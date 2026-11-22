import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { createServer } from './server.mjs';

const modelJson = content => Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });

test('the eight editable components drive chat, and specialized agents use their own Markdown', async t => {
  const temporary = await realpath(tmpdir());
  const root = await mkdtemp(join(temporary, 'taotao-agent-config-'));
  const calls = [];
  const server = createServer({ memoryRoot: root, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const payload = JSON.parse(init.body);
    const system = payload.messages[0].content;
    calls.push(payload);
    if (system.startsWith('你是独立工作的子 Agent')) return Response.json({ choices: [{ message: { content: '委派实际结果' } }] });
    if (system.startsWith('你负责 Wiki 本地答案检查')) return modelJson({ page: '', quote: '', query: '' });
    if (system.startsWith('你是资料摘要助手')) return modelJson({ paragraphs: [], gaps: [] });
    assert.equal(payload.stream, true);
    return new Response('data: {"choices":[{"delta":{"content":"原始回答"}}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (dirname(root) === temporary && basename(root).startsWith('taotao-agent-config-')) {
      await rm(root, { recursive: true, force: true, maxRetries: 2 });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, method = 'GET', body) => fetch(base + path, {
    method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const get = async id => (await request('/api/agents/' + id)).json();
  async function set(id, key, value, from) {
    const before = from || await get(id);
    const response = await request('/api/agents/' + id + '/' + key, 'PUT', { value, revision: before.revisions[key] });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  async function chat(agent, content, { remember = true, webSearch = false, resourceIds } = {}) {
    const sessionId = randomUUID();
    if (remember) {
      const saved = await request('/api/memory/user', 'POST', { sessionId, id: randomUUID(), agent, content });
      assert.equal(saved.status, 200);
    }
    const response = await request('/api/chat', 'POST', {
      agent, model: 'fixture', apiKey: 'fixture-key', webSearch, resourceIds,
      messages: [{ role: 'user', content }],
      ...(remember ? { memory: { sessionId, id: randomUUID(), visible: true, curate: false } } : {}),
    });
    return { status: response.status, text: await response.text() };
  }
  const agents = ['qa', 'taotao', 'librarian', 'summarizer', 'harness2'];
  for (const id of agents) {
    const state = await get(id);
    assert.deepEqual(Object.keys(state.components), ['system', 'guardrails', 'memory', 'tools', 'subagents', 'skills', 'scripts', 'plugins']);
    assert.equal(await readFile(join(root, '我的记忆库', state.files.config), 'utf8').then(text => JSON.parse(text).skills.length), 0);
  }
  const initial = await get('qa');
  const md = join(root, '我的记忆库', initial.files.system);
  await writeFile(md, '---\r\nagent: qa\r\ncustom: preserve-me\r\n---\r\n\r\n旧提示词\r\n');
  const prompt = await set('qa', 'system', '网页保存的提示词', await get('qa'));
  assert.equal(prompt.components.system, '网页保存的提示词');
  assert.equal(await readFile(md, 'utf8'), '---\r\nagent: qa\r\ncustom: preserve-me\r\n---\r\n\r\n网页保存的提示词\r\n');
  const stale = await request('/api/agents/qa/system', 'PUT', { value: '过期修改', revision: initial.revisions.system });
  assert.equal(stale.status, 409);

  await set('qa', 'guardrails', { instructions: '网页护栏指令', blocked: '阻止本句', blockWeb: true });
  await set('qa', 'memory', '独立长期记忆');
  await set('qa', 'tools', [{ id: 'request_knowledge_review', description: '被编辑且实际注册的工具说明' }]);
  await set('taotao', 'system', '子代理从磁盘读取的提示词');
  await set('qa', 'subagents', [
    { target: 'librarian', mode: 'review', trigger: '', task: '保留现有收录流程' },
    { target: 'taotao', mode: 'delegate', trigger: '检验', task: '验证这次委派' },
  ]);
  await set('qa', 'skills', [{ name: '检查工作流', trigger: '检验', instructions: '实际加载的技能步骤' }]);
  await set('qa', 'scripts', [{ name: '计数字符', trigger: '检验', input: 'question', code: 'trim\ncount' }]);
  const hooks = [
    { name: '提示钩子', event: 'before_model', action: '', value: '运行的模型前钩子', match: '' },
    { name: '回复钩子', event: 'after_reply', action: 'replace', match: '原始', value: '处理后' },
  ];
  await set('qa', 'plugins', hooks);

  const blocked = await chat('qa', '阻止本句');
  assert.equal(blocked.status, 403);
  assert.equal(calls.length, 0);
  const answer = await chat('qa', '检验应用', { webSearch: true });
  assert.match(answer.text, /"webSearch":false/u);
  assert.match(answer.text, /处理后回答/u);
  assert.doesNotMatch(answer.text, /原始回答/u);
  const [child, parent] = calls.splice(0);
  assert.equal(child.messages.length, 2);
  assert.match(child.messages[0].content, /子代理从磁盘读取的提示词/u);
  assert.equal(JSON.parse(child.messages[1].content).task, '验证这次委派');
  const instructions = parent.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  for (const text of ['网页保存的提示词', '网页护栏指令', '独立长期记忆', '实际加载的技能步骤', '运行的模型前钩子', '委派实际结果', '"script":"计数字符","result":"4"']) {
    assert.ok(instructions.includes(text), text);
  }
  assert.equal(parent.tools[0].function.description, '被编辑且实际注册的工具说明');

  await set('qa', 'plugins', [...hooks, { name: '拦截脚本', event: 'before_tool', action: '', value: 'run_script', match: '' }]);
  const nothing = await chat('qa', '检验应用', { remember: false });
  assert.doesNotMatch(nothing.text, /执行脚本/u);
  assert.doesNotMatch(calls.at(-1).messages.map(m => m.content).join('\n'), /计数字符|独立长期记忆/u);

  const externalBefore = await get('qa');
  await writeFile(md, '直接在 Obsidian 修改');
  const conflicts = await request('/api/agents/qa/system', 'PUT', { value: '旧窗口', revision: externalBefore.revisions.system });
  assert.equal(conflicts.status, 409);
  await chat('qa', '普通问题', { remember: false });
  assert.match(calls.at(-1).messages.map(m => m.content).join('\n'), /直接在 Obsidian 修改/u);
  await set('qa', 'system', '');
  assert.equal((await get('qa')).components.system, '');

  await set('librarian', 'system', '管理员独立提示修改');
  assert.match((await chat('librarian', '测试本地资料不足')).text, /data: \[DONE\]/u);
  assert.match(calls.at(-1).messages[0].content, /管理员独立提示修改/u);
  await set('summarizer', 'system', '摘要独立提示修改');
  const upload = await fetch(base + '/api/resources/upload?name=fixture.txt', { method: 'POST', body: '这是一段用于验证原文提取的资料。' });
  assert.equal(upload.status, 201);
  const listed = await (await request('/api/resources')).json();
  assert.match((await chat('summarizer', '总结这份资料', { resourceIds: [listed.files[0].id] })).text, /data: \[DONE\]/u);
  assert.match(calls.at(-1).messages[0].content, /摘要独立提示修改/u);
});
