import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from './memory.mjs';
import { createServer } from './server.mjs';

const key = 'sk-memory-test-only';
const model = 'deepseek-chat';
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-memory-'));
  const store = new MemoryStore(root);
  t.after(() => store.close());
  const sessionId = randomUUID();
  const user = (content, id = randomUUID()) => { store.saveUser({ sessionId, id, content }); return id; };
  return { store, root, sessionId, user };
}
function publish(store, notes) {
  store.setKnowledgePermission(true);
  const sources = store.knowledgeSources([...new Set(notes.flatMap(p => p.sourceIds))]);
  return store.commitKnowledge({ agent: 'librarian', sources, pages: notes.map(note => {
    const existing = store.db.prepare('SELECT hash FROM pages WHERE path=? AND deleted=0').get(note.path);
    return { path: note.path, baseHash: existing?.hash ?? null, summary: note.text, links: note.links || [],
      claims: [{ text: note.text, status: 'user_statement', scope: '用户明确陈述', asOf: null,
        evidence: note.sourceIds.map(sourceId => ({ sourceId, quote: sources.find(s => s.id === sourceId)?.content || '无法核对的原话', locator: '聊天原文', relation: 'supports' })) }] };
  }) });
}

test('agent sessions remain distinguishable while sharing the same read-only Wiki', async t => {
  const { store, root, sessionId, user } = setup(t);
  const source = user('我叫小林，职业是建筑师。');
  publish(store, [{ path: 'wiki/人物/用户.md', text: '姓名小林，职业建筑师。', sourceIds: [source] }]);
  const qaSession = randomUUID();
  store.saveUser({ sessionId: qaSession, id: randomUUID(), content: '我叫什么？', agent: 'qa' });
  assert.equal(store.history(sessionId).session.agent, 'taotao');
  assert.equal(store.history(qaSession).session.agent, 'qa');
  store.saveUser({ sessionId, id: randomUUID(), content: '这条消息交给问答助手', agent: 'qa' });
  assert.equal(store.history(sessionId).messages.at(-1).agent, 'qa');
  assert.throws(() => store.beginAssistant(qaSession, randomUUID(), true, 'taotao'), /先向这个助手/);
  const id = randomUUID(); store.beginAssistant(qaSession, id, true, 'qa'); store.append(id, '你叫小林。'); store.finish(id, 'complete');
  assert.match(readFileSync(join(root, '我的记忆库/raw/对话', `${qaSession}.md`), 'utf8'), /## 问答助手/);
  assert.match(JSON.stringify(store.recall('我叫什么')), /建筑师/);
});

test('full archive, interrupted stream, hidden drafts, idempotency, restart and consistent backup', async t => {
  const { store, root, sessionId, user } = setup(t);
  const source = user('我叫小林，是建筑师，正在做滔滔不绝。');
  user('我叫小林，是建筑师，正在做滔滔不绝。', source);
  assert.equal(store.status().saved, 1);
  const id = randomUUID(); store.beginAssistant(sessionId, id, false); store.append(id, '尚未读出的草稿'); store.finish(id, 'interrupted');
  const raw = readFileSync(join(store.vault, 'raw/对话', `${sessionId}.md`), 'utf8');
  assert.match(raw, /小林/); assert.match(raw, /未完成/); assert.match(raw, /尚未展示/);
  publish(store, [
    { path: 'wiki/人物/用户.md', text: '用户明确说：名字是小林，职业是建筑师。', sourceIds: [source], links: [{ path: 'wiki/项目/滔滔不绝.md', relation: '用户正在开发的项目' }] },
    { path: 'wiki/项目/滔滔不绝.md', text: '用户正在开发此项目。', sourceIds: [source], links: [{ path: 'wiki/人物/用户.md', relation: '项目开发者' }] },
  ]);
  const remembered = store.recall('你记得我叫什么吗');
  assert.ok(remembered.pages.some(p => p.content.includes('小林')));
  assert.match(readFileSync(join(store.vault, 'wiki/人物/用户.md'), 'utf8'), new RegExp(source));
  assert.match(readFileSync(join(store.vault, 'wiki/index.md'), 'utf8'), /滔滔不绝/);
  const restart = new MemoryStore(root);
  assert.match(JSON.stringify(restart.recall('我的职业')), /建筑师/);
  restart.close();
  const backup = store.backup();
  const db = new DatabaseSync(join(backup.path, 'memory.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n, 2); db.close();
  assert.ok(existsSync(join(backup.path, '我的记忆库/wiki/人物/用户.md')));
});

test('same project is revised, manual changes are recalled and a late model cannot overwrite them', async t => {
  const { store, user } = setup(t);
  const first = user('我的项目叫滔滔不绝，先用SQLite。');
  const page = 'wiki/项目/滔滔不绝.md';
  publish(store, [{ path: page, text: '使用SQLite。', sourceIds: [first] }]);
  const second = user('滔滔不绝增加Obsidian Wiki，不只是导出笔记。');
  publish(store, [{ path: page, text: '采用SQLite + Obsidian Wiki。', sourceIds: [first, second] }]);
  assert.equal(store.status().pages.length, 1);
  const third = user('滔滔不绝记住我对记忆系统的要求。');
  const staleHash = store.db.prepare('SELECT hash FROM pages WHERE path=?').get(page).hash;
  const path = join(store.vault, page);
  writeFileSync(path, readFileSync(path, 'utf8').replace('采用SQLite + Obsidian Wiki。', '人工更正：项目已更名为长谈。'));
  assert.throws(() => store.commitKnowledge({ agent: 'librarian', sources: store.knowledgeSources([third]), pages: [{ path: page, baseHash: staleHash,
    summary: '旧结果覆盖。', claims: [{ text: '旧结果覆盖。', status: 'user_statement', evidence: [{ sourceId: third, quote: '滔滔不绝记住我对记忆系统的要求。', locator: '原话', relation: 'supports' }] }], links: [] }] }), /人工修改|笔记已修改|手动修改|新修改/);
  assert.match(JSON.stringify(store.recall('项目')), /长谈/);
  assert.doesNotMatch(readFileSync(join(store.vault, page), 'utf8'), /旧结果覆盖/);
  const moved = 'wiki/项目/长谈.md';
  renameSync(join(store.vault, page), join(store.vault, moved));
  store.syncWiki();
  assert.equal(store.status().pages.length, 1);
  assert.equal(store.status().pages[0].path, moved);
  writeFileSync(join(store.vault, moved), '超大手改内容'.repeat(30000));
  assert.equal(store.recall('长谈').pages.length, 0, 'oversized manual edit cannot fall back to a stale DB version');
});

test('bad source IDs, invalid paths and web identity claims are rejected without writing', async t => {
  const { store, user, sessionId } = setup(t);
  const source = user('我朋友是医生；假设我住在月球。');
  for (const page of [
    { path: 'wiki/项目/../../outside.md', text: 'x', sourceIds: [source] },
    { path: 'wiki/人物/用户.md', text: '用户资料', sourceIds: ['made-up-source'] },
    { path: 'wiki/人物/用户.md', text: '<script>不能执行</script>', sourceIds: [source] },
    { path: 'wiki/主题/测试.md', text: '测试知识', sourceIds: [source], links: [{ path: 'wiki/主题/不存在.md', relation: '不存在的关联' }] },
  ]) assert.throws(() => publish(store, [page]));
  assert.equal(store.status().pages.length, 0);
  const msg = randomUUID(); store.beginAssistant(sessionId, msg, true);
  store.research(msg, { query: '医生职业', sources: [{ title: '医生', url: 'https://example.com/', content: '医生的工作' }] });
  const web = { id: randomUUID(), kind: 'web', title: '医生', publisher: '外部资料', url: 'https://example.com/', content: '医生的工作是诊疗疾病。', publishedAt: null, retrievedAt: new Date().toISOString(), reliability: 'high', reason: '仅介绍职业一般信息，不是用户个人资料。' };
  assert.throws(() => store.commitKnowledge({ agent: 'librarian', sources: [web], pages: [{ path: 'wiki/人物/用户.md', baseHash: null, summary: '用户是医生。',
    claims: [{ text: '用户是医生。', status: 'verified', evidence: [{ sourceId: web.id, quote: web.content, locator: '网页', relation: 'supports' }] }], links: [] }] }), /人物|用户/);
});

test('forget removes dependent recall and old sources cannot recreate a page', async t => {
  const { store, user } = setup(t);
  const source = user('我叫小林。');
  publish(store, [{ path: 'wiki/人物/用户.md', text: '姓名小林。', sourceIds: [source] }]);
  store.removePage(store.status().pages[0].id);
  assert.equal(store.recall('小林').pages.length, 0);
  assert.equal(store.recall('小林').pending.length, 0);
  assert.equal(store.status().pending, 0);
  assert.deepEqual(store.recall('小林').interests.more, []);
  const second = user('再聊一下我。');
  assert.throws(() => publish(store, [{ path: 'wiki/人物/用户.md', text: '小林', sourceIds: [second] }]), /删除/);
});

test('durable preference scoring is idempotent and a stale browser cannot reintroduce forgotten scores', t => {
  const { store, user, sessionId } = setup(t);
  user('随便聊聊');
  const event = { id: randomUUID(), type: 'question', payload: { text: '月球研究' } };
  store.event(event); store.event(event);
  assert.equal(store.status().interests[0].score, 1);
  store.event({ id: randomUUID(), type: 'clear_preferences', payload: {} });
  store.event({ id: randomUUID(), type: 'pause', payload: {}, interests: [{ text: '月球研究', score: 10, updated: Date.now() }] });
  assert.deepEqual(store.recall('月球').interests.more, []);
  const feedbackId = randomUUID();
  store.event({ id: feedbackId, sessionId, type: 'feedback', payload: { direction: 'less', excerpt: '月球研究' } });
  assert.equal(store.status().interests[0].score, -3);
  const raw = readFileSync(join(store.vault, 'raw/对话', `${sessionId}.md`), 'utf8');
  assert.match(raw, /用户明确选择少聊/); assert.ok(raw.includes(`^${feedbackId}`));
});

test('deleting a session invalidates its evidence before a late knowledge commit', async t => {
  const { store, user, sessionId } = setup(t);
  const source = user('我叫小林。');
  const captured = store.knowledgeSources([source]);
  store.setKnowledgePermission(true);
  store.deleteSession(sessionId);
  assert.throws(() => store.commitKnowledge({ agent: 'librarian', sources: captured, pages: [{ path: 'wiki/人物/用户.md', baseHash: null, summary: '小林',
    claims: [{ text: '小林', status: 'user_statement', evidence: [{ sourceId: source, quote: '我叫小林。', locator: '原话', relation: 'supports' }] }], links: [] }] }), /原话|来源|删除/);
  assert.equal(store.status().saved, 0);
  assert.equal(store.status().pages.length, 0);
});

test('editing raw never destroys original DB text or silently overwrites the file', t => {
  const { store, user, sessionId } = setup(t);
  user('第一条原话');
  const file = join(store.vault, 'raw/对话', `${sessionId}.md`);
  writeFileSync(file, '我手动改过的档案');
  user('第二条原话');
  assert.equal(readFileSync(file, 'utf8'), '我手动改过的档案');
  assert.equal(store.history(sessionId).messages.length, 2);
  assert.equal(store.status().exportErrors.length, 1);
});

test('cancelled HTTP streaming leaves the displayed prefix durable and unfinished', async t => {
  const root = mkdtempSync(join(tmpdir(), 'taotao-memory-cancel-'));
  let markCancelled;
  const cancelled = new Promise(resolve => { markCancelled = resolve; });
  const server = createServer({ memoryRoot: root, fetchImpl: async (_, options) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"已经收到的一半回答。"}}]}\n\n'));
      options.signal.addEventListener('abort', () => { markCancelled(); controller.error(new Error('stopped')); }, { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sessionId = randomUUID(); const id = randomUUID();
  await fetch(`${base}/api/memory/user`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, id: randomUUID(), content: '开始聊天。' }) });
  const controller = new AbortController();
  const response = await fetch(`${base}/api/chat`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key, model, webSearch: false, messages: [{ role: 'user', content: '开始聊天。' }], memory: { sessionId, id, visible: true, curate: false } }) });
  const reader = response.body.getReader(); let seen = '';
  while (!seen.includes('已经收到')) seen += new TextDecoder().decode((await reader.read()).value);
  const beforeAbort = await (await fetch(`${base}/api/memory/history?id=${sessionId}`)).json();
  assert.equal(beforeAbort.messages.at(-1).content, '已经收到的一半回答。');
  controller.abort();
  await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(Error('Did not abort')), 1500).unref())]);
  let after;
  for (let i = 0; i < 30; i++) {
    after = await (await fetch(`${base}/api/memory/history?id=${sessionId}`)).json();
    if (after.messages.at(-1).status === 'interrupted') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(after.messages.at(-1).status, 'interrupted');
  assert.match(readFileSync(join(root, '我的记忆库/raw/对话', `${sessionId}.md`), 'utf8'), /已经收到的一半回答/);
});

test('HTTP saves before display, answers and plans use recall, personal question bypasses search', async t => {
  const root = mkdtempSync(join(tmpdir(), 'taotao-memory-http-'));
  const sessionId = randomUUID(); const id = randomUUID();
  const seeded = new MemoryStore(root);
  seeded.saveUser({ sessionId, id, content: '我叫小林，我在做滔滔不绝的本地Wiki记忆。' });
  publish(seeded, [
    { path: 'wiki/人物/用户.md', text: '用户明确说自己叫小林。', sourceIds: [id] },
    { path: 'wiki/项目/滔滔不绝.md', text: '项目使用本地Wiki记忆。', sourceIds: [id] },
  ]);
  seeded.close();
  const calls = [];
  const server = createServer({ memoryRoot: root, fetchImpl: async (url, opts) => {
    const body = JSON.parse(opts.body); calls.push({ url, body });
    if (url.endsWith('v1/tools/search')) return Response.json({ results: [{ title: 'Wiki', url: 'https://example.com/wiki', content: 'Wiki链接与知识组织' }] });
    if (!body.stream) return Response.json({ choices: [{ message: { content: JSON.stringify({ query: 'Wiki 知识组织', focus: '如何整理Wiki' }) } }] });
    return new Response('data: {"choices":[{"delta":{"content":"你叫小林。"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
  assert.equal((await post('/api/memory/user', { sessionId, id, content: '我叫小林，我在做滔滔不绝的本地Wiki记忆。' })).status, 200);
  const answerId = randomUUID();
  const response = await post('/api/chat', { apiKey: key, model, webSearch: true, messages: [{ role: 'user', content: '你记得我叫什么吗' }],
    memory: { sessionId, id: answerId, visible: true, curate: true } });
  const text = await response.text();
  assert.match(text, /你叫小林/); assert.match(text, /localOnly":true/);
  assert.equal(calls.filter(c => c.url.includes('search')).length, 0);
  assert.match(JSON.stringify(calls.at(-1).body.messages), /本机记忆/);
  const history = await (await fetch(`${base}/api/memory/history?id=${sessionId}`)).json();
  assert.equal(history.messages.at(-1).content, '你叫小林。'); assert.equal(history.messages.at(-1).status, 'complete');
  const qaSession = randomUUID();
  await post('/api/memory/user', { sessionId: qaSession, id: randomUUID(), content: '你记得我的职业吗？', agent: 'qa' });
  const qaResponse = await post('/api/chat', { apiKey: key, model, agent: 'qa', webSearch: false,
    messages: [{ role: 'user', content: '你记得我的职业吗？' }], memory: { sessionId: qaSession, id: randomUUID(), visible: true, curate: false } });
  assert.match(await qaResponse.text(), /wiki\/人物\/用户.md/);
  assert.match(JSON.stringify(calls.at(-1).body.messages), /用户明确说自己叫小林/);
  assert.match(JSON.stringify(calls.at(-1).body.messages), /只回答这一次/);
  const researched = await post('/api/chat', { apiKey: key, model, webSearch: true, messages: [{ role: 'user', content: '研究滔滔不绝的Wiki知识组织' }],
    memory: { sessionId, id: randomUUID(), visible: false, curate: false } });
  await researched.text();
  const planner = calls.find(c => c.body.messages?.[0]?.content.includes('中文资料研究员'));
  assert.match(planner.body.messages[1].content, /项目使用本地Wiki记忆/);
  assert.doesNotMatch(planner.body.messages[1].content, /用户明确说自己叫小林/);
  assert.equal((await fetch(`${base}/data/memory.sqlite`)).status, 404);
  const noteURL = path => `${base}/api/memory/note?path=${encodeURIComponent(path)}`;
  const noteResponse = await fetch(noteURL('wiki/人物/用户.md'));
  assert.equal(noteResponse.status, 200);
  const note = await noteResponse.json();
  assert.match(note.content, /小林/);
  assert.equal(new URL(note.obsidian).searchParams.get('path'), join(root, '我的记忆库/wiki/人物/用户.md'));
  const download = await fetch(noteURL('wiki/人物/用户.md') + '&download=1');
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.equal(await download.text(), note.content);
  assert.match((await (await fetch(noteURL('wiki/index.md'))).json()).content, /记忆目录/);
  assert.match((await (await fetch(noteURL(`raw/对话/${sessionId}.md`))).json()).content, /我叫小林/);
  for (const path of ['../server.mjs', 'wiki/../../server.mjs', '/wiki/index.md', 'wiki/../wiki/index.md',
    'wiki\\人物\\用户.md', 'wiki/人物/用户.md:secret.md', '.obsidian/app.json', 'data/memory.sqlite', 'wiki//index.md']) {
    assert.equal((await fetch(noteURL(path))).status, 400, path);
  }
  assert.equal((await fetch(noteURL('wiki/不存在.md'))).status, 404);
  assert.equal((await fetch(noteURL('wiki/人物/用户.md'), { headers: { Origin: 'https://example.org' } })).status, 403);
  assert.equal((await post('/api/memory/backup', {})).status, 200);
  const status = await (await fetch(`${base}/api/memory/status`)).json();
  assert.equal(status.saved, 5);
  assert.ok(!readFileSync(join(root, 'data/memory.sqlite')).includes(Buffer.from(key)));
  assert.ok(!readFileSync(join(root, 'data/memory.sqlite-wal')).includes(Buffer.from(key)));
});
