import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from './server.mjs';

test('workflows route inputs, run Agent configuration and retain past runs after deletion', async t => {
  const temporary = await realpath(tmpdir());
  const root = await mkdtemp(join(temporary, 'taotao-workflow-'));
  const calls = [];
  let modelAborted = false;
  const server = createServer({ memoryRoot: root, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const payload = JSON.parse(init.body);
    calls.push(payload.messages);
    if (payload.messages.at(-1).content.includes('等待停止')) {
      await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => {
        modelAborted = true; reject(init.signal.reason);
      }, { once: true }));
    }
    return Response.json({ choices: [{ message: { content: '可审核的邮件草稿' } }] });
  } });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (dirname(root) === temporary && basename(root).startsWith('taotao-workflow-')) {
      await rm(root, { recursive: true, force: true, maxRetries: 2 });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const base = origin + '/api/workflows';
  const read = async path => fetch(base + path).then(response => response.json());
  const request = (path, method, body, signal) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const [{ id }] = await read('');
  const path = '/' + id;
  const initial = await read(path);
  assert.equal(initial.nodes.length, 7);
  async function run(text, revision = 1, chat) {
    const response = await request(path + '/runs', 'POST', {
      revision, apiKey: 'fixture-workflow-key', model: 'fixture', inputs: { customer_name: '测试客户', email_content: text }, chat,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const lines = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.at(-1), { status: 'complete', output: { reply: '可审核的邮件草稿' } });
    const execution = await read(path + '/runs/' + lines[0].id);
    assert.equal(execution.status, 'complete');
    assert.ok(!JSON.stringify(execution).includes('fixture-workflow-key'));
    return execution;
  }
  const chat = { sessionId: randomUUID(), userId: randomUUID(), replyId: randomUUID(), agent: 'qa', content: '@邮件助理 请问 Dify 能做什么？' };
  const chatHistory = () => fetch(origin + '/api/memory/history?id=' + chat.sessionId).then(response => response.json());
  const related = await run('请问 Dify 能做什么？', 1, chat);
  const { messages } = await chatHistory();
  assert.deepEqual(messages.map(message => message.id), [chat.userId, chat.replyId]);
  assert.equal(messages[1].content, related.output.reply);
  assert.equal(messages[1].status, 'complete');
  assert.deepEqual(JSON.parse(messages[1].workflow), { id, runId: related.id, name: '邮件助理' });
  assert.match(calls[0].at(-1).content, /Dify 简介/u);
  assert.equal(related.steps.find(step => step.id === 'knowledge').output.notes.length, 1);
  assert.equal(related.steps.find(step => step.id === 'general').status, 'skipped');
  const other = await run('可否预约交流？');
  assert.doesNotMatch(calls[1].at(-1).content, /Dify 简介/u);
  assert.equal(other.steps.find(step => step.id === 'knowledge').status, 'skipped');
  assert.equal(other.steps.find(step => step.id === 'specialist').status, 'skipped');
  assert.equal(calls.length, 2);

  const draft = structuredClone(initial);
  draft.name = '新的邮件流程';
  draft.nodes.find(node => node.id === 'classify').config.value = '付费';
  draft.nodes.find(node => node.id === 'knowledge').config.source = 'wiki';
  await writeFile(join(root, '我的记忆库', 'wiki', 'Dify.md'), '# Dify\n\n本地 Wiki 测试材料，产品试用需先确认适用范围。');
  const saved = await request(path, 'PUT', draft);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 2);
  assert.equal((await request(path, 'PUT', draft)).status, 409);
  await run('请问 Dify 能做什么？', 2);
  assert.doesNotMatch(calls[2].at(-1).content, /Dify 简介/u);
  const local = await run('Dify 付费问题', 2);
  assert.equal(local.steps.find(step => step.id === 'knowledge').output.notes[0].path, 'wiki/Dify.md');
  assert.match(calls[3].at(-1).content, /本地 Wiki 测试材料/u);
  assert.equal((await read(path + '/runs/' + related.id)).flow.name, '邮件助理');

  const controller = new AbortController();
  const interrupted = { ...chat, userId: randomUUID(), replyId: randomUUID(), content: '@邮件助理 等待停止' };
  const response = await request(path + '/runs', 'POST', {
    revision: 2, apiKey: 'fixture-workflow-key', model: 'fixture',
    inputs: { customer_name: '测试客户', email_content: '等待停止' },
    chat: interrupted,
  }, controller.signal);
  assert.equal(response.status, 200);
  for (let i = 0; calls.length < 5 && i < 100; i++) await delay(10);
  assert.equal(calls.length, 5);
  controller.abort();
  for (let i = 0; !modelAborted && i < 100; i++) await delay(10);
  assert.equal(modelAborted, true);
  let latest;
  for (let i = 0; latest?.status !== 'stopped' && i < 100; i++) {
    [latest] = await read(path + '/runs');
    if (latest.status !== 'stopped') await delay(10);
  }
  assert.equal(latest.status, 'stopped');
  assert.equal((await read(path + '/runs/' + latest.id)).steps.find(step => step.id === 'general').status, 'stopped');
  assert.equal((await chatHistory()).messages.at(-1).status, 'interrupted');

  const agent = 'optimist';
  const harnessUrl = origin + '/api/agents/' + agent;
  const harness = await fetch(harnessUrl).then(response => response.json());
  const savedPrompt = await fetch(harnessUrl + '/system', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: harness.revisions.system, value: '从机会出发列出可测试的假设。' }),
  });
  assert.equal(savedPrompt.status, 200);
  const started = await request('', 'POST', { template: 'blank' }).then(response => response.json());
  const agentPath = '/' + started.id;
  started.nodes.push({ id: 'reviewer', title: '机会分析', type: 'agent', x: 122, y: 120,
    config: { agent, prompt: '分析：{{start.input}}', remember: false } });
  started.nodes.find(node => node.type === 'output').config.fields[0].variable = 'reviewer.text';
  started.edges = [{ from: 'start', to: 'reviewer', port: 'next' }, { from: 'reviewer', to: 'output', port: 'next' }];
  assert.equal((await request(agentPath, 'PUT', started)).status, 200);
  const agentRun = () => request(agentPath + '/runs', 'POST', {
    revision: 2, apiKey: 'fixture-workflow-key', model: 'fixture', inputs: { input: '社区活动' },
  });
  const entries = (await (await agentRun()).text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.at(-1).status, 'complete');
  assert.equal(entries.at(-1).output.result, '可审核的邮件草稿');
  assert.match(calls.at(-1)[0].content, /^从机会出发列出可测试的假设。/u);
  assert.equal(calls.at(-1).at(-1).content, '分析：社区活动');

  assert.equal((await fetch(harnessUrl, { method: 'DELETE' })).status, 200);
  const directory = await fetch(origin + '/api/agents').then(response => response.json());
  assert.ok(!directory.agents.some(item => item.id === agent) && directory.deleted.includes(agent));
  assert.equal((await fetch(harnessUrl)).status, 410);
  const before = calls.length;
  assert.match(await (await agentRun()).text(), /乐观主义者.*已删除/u);
  assert.equal(calls.length, before);
  const oldRunPath = agentPath + '/runs/' + entries[0].id;
  assert.equal((await request(agentPath, 'DELETE', { revision: 1 })).status, 409);
  assert.equal((await request(agentPath, 'DELETE', { revision: 2 })).status, 200);
  assert.ok(!(await read('')).some(item => item.id === started.id));
  assert.equal((await read(agentPath)).deleted, true);
  assert.equal((await agentRun()).status, 410);
  assert.equal((await read(oldRunPath)).output.result, '可审核的邮件草稿');
});
