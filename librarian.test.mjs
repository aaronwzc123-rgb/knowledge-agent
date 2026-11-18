import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from './memory.mjs';
import { createServer } from './server.mjs';

const apiKey = 'sk-librarian-fixture-only';
const model = 'deepseek-flash';
const notePath = 'wiki/主题/离线模式.md';
const quote = '离线模式可以读取已经下载的资料，但同步需要联网。';
const source = () => ({
  id: randomUUID(), url: 'https://example.org/guide/offline', title: '离线模式说明',
  publisher: '示例软件文档', publishedAt: '2026-10-01', updatedAt: null,
  retrievedAt: new Date().toISOString(), content: `使用说明\n${quote}\n适用于桌面版本。`,
  kind: 'web', reliability: 'primary', reason: '产品原始使用文档直接说明该功能。',
});
const page = (evidence, extra = {}) => ({
  path: notePath, baseHash: null, summary: '离线可以阅读已下载的资料，同步仍需网络。',
  claims: [{ text: '离线模式支持读取已下载的资料；同步需要联网。', status: 'verified',
    scope: '桌面版本', asOf: '2026-10-01',
    evidence: [{ sourceId: evidence.id, quote, locator: '使用说明', relation: 'supports' }] }],
  links: [], ...extra,
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-librarian-'));
  const store = new MemoryStore(root);
  t.after(() => {
    store.close();
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('taotao-librarian-'));
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  return { root, store };
}

function wikiSnapshot(store) {
  const entries = [];
  function walk(folder) {
    for (const item of readdirSync(join(store.vault, folder), { withFileTypes: true })) {
      const relative = `${folder}/${item.name}`;
      if (item.isDirectory()) walk(relative);
      else if (item.isFile()) entries.push([relative, readFileSync(join(store.vault, relative), 'utf8')]);
    }
  }
  walk('wiki');
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

async function seed(store) {
  store.setKnowledgePermission(true);
  const evidence = source();
  await store.commitKnowledge({ agent: 'librarian', sources: [evidence], pages: [page(evidence)] });
  return evidence;
}

test('only the authorized librarian can publish knowledge; citations contain dates and traceable evidence', async t => {
  const { store } = fixture(t);
  const evidence = source();
  const request = { agent: 'librarian', sources: [evidence], pages: [page(evidence)] };
  assert.equal(store.knowledgePermission(), false);
  await assert.rejects(async () => store.commitKnowledge(request), /授权|权限/);
  store.setKnowledgePermission(true);
  for (const agent of ['qa', 'taotao']) {
    await assert.rejects(async () => store.commitKnowledge({ ...request, agent }), /权限|管理员|授权/);
  }
  await store.commitKnowledge(request);
  const content = readFileSync(join(store.vault, notePath), 'utf8');
  assert.match(content, /# 离线模式/);
  assert.doesNotMatch(content, /已核实|适用范围：|适用时间：/);
  assert.match(content, /\[\^[^\]]+\]/);
  assert.match(content, /2026-10-01/);
  assert.match(content, /example\.org\/guide\/offline/);
  assert.match(content, /raw\/资料/);
  assert.match(content, /示例软件文档/);
  const recalled = store.knowledgeRecall('离线模式');
  const note = recalled.pages.find(p => p.path === notePath);
  assert.ok(note?.claims.length);
  assert.equal(note.claims[0].evidence[0].sourceId, evidence.id);
  assert.equal(note.claims[0].evidence[0].quote, quote);
  store.setKnowledgePermission(false);
  await assert.rejects(async () => store.commitKnowledge({ ...request, pages: [page(evidence, { baseHash: note.hash })] }), /授权|权限/);
});

test('fake, missing and unknown citations never enter the Wiki', async t => {
  const { store } = fixture(t);
  store.setKnowledgePermission(true);
  const evidence = source();
  const initial = wikiSnapshot(store);
  for (const edits of [
    { evidence: [] },
    { evidence: [{ sourceId: evidence.id, quote: '这段话并不在原始资料中。', locator: '正文', relation: 'supports' }] },
    { evidence: [{ sourceId: randomUUID(), quote, locator: '正文', relation: 'supports' }] },
  ]) {
    const proposed = page(evidence);
    Object.assign(proposed.claims[0], edits);
    await assert.rejects(async () => store.commitKnowledge({ agent: 'librarian', sources: [evidence], pages: [proposed] }));
    assert.deepEqual(wikiSnapshot(store), initial);
  }
});

test('reading, refreshing and restarting never rewrite manually authored Wiki files', async t => {
  const { store, root } = fixture(t);
  const manualPath = join(store.vault, 'wiki/主题/人工笔记.md');
  mkdirSync(join(store.vault, 'wiki/主题'), { recursive: true });
  const manual = '# 人工笔记\n\n这是一篇没有程序标识的手写笔记。\n';
  writeFileSync(manualPath, manual);
  const initial = wikiSnapshot(store);
  store.recall('人工笔记');
  store.knowledgeRecall('人工笔记');
  store.status();
  assert.deepEqual(wikiSnapshot(store), initial, 'read-side indexing cannot rewrite any Wiki file');
  const restarted = new MemoryStore(root);
  restarted.recall('人工笔记');
  restarted.status();
  assert.deepEqual(wikiSnapshot(restarted), initial, 'startup does not rewrite the index or human note');
  restarted.close();
});

test('manual edits invalidate old verified claims and stale commits preserve the latest note', async t => {
  const { store } = fixture(t);
  const evidence = await seed(store);
  const old = store.knowledgeRecall('离线模式').pages.find(p => p.path === notePath);
  const file = join(store.vault, notePath);
  const edited = readFileSync(file, 'utf8') + '\n人工备注：此结论需重新核查。\n';
  writeFileSync(file, edited);
  const current = store.knowledgeRecall('离线模式').pages.find(p => p.path === notePath);
  assert.ok(current);
  assert.equal(current.claims.length, 0, 'stale claim evidence is not attached to a newly edited version');
  await assert.rejects(async () => store.commitKnowledge({ agent: 'librarian', sources: [evidence], pages: [page(evidence, { baseHash: old.hash })] }));
  assert.equal(readFileSync(file, 'utf8'), edited);
});

test('supplements keep stable claim identities and add only useful linked knowledge', async t => {
  const { store } = fixture(t);
  const evidence = await seed(store);
  const first = store.knowledgeRecall('离线模式').pages.find(p => p.path === notePath);
  await store.commitKnowledge({ agent: 'librarian', sources: [evidence], pages: [page(evidence, { baseHash: first.hash })] });
  const second = store.knowledgeRecall('离线模式').pages.find(p => p.path === notePath);
  assert.equal(second.claims.length, 1, 'same conclusion is not duplicated merely because a model omitted its ID');
  assert.equal(second.claims[0].id, first.claims[0].id);
  const other = source(); other.id = randomUUID(); other.url = 'https://example.org/guide/sync';
  const next = page(other, { path: 'wiki/主题/同步条件.md', summary: '同步需要网络。', links: [{ path: notePath, relation: '离线使用的限制条件' }] });
  await store.commitKnowledge({ agent: 'librarian', sources: [other], pages: [next] });
  const related = readFileSync(join(store.vault, next.path), 'utf8');
  assert.match(related, /\[\[wiki\/主题\/离线模式\]\]/);
  assert.match(related, /离线使用的限制条件/);
});

test('a mixed conversation records each turn under its actual agent', async t => {
  const { store } = fixture(t);
  const sessionId = randomUUID();
  for (const agent of ['qa', 'taotao', 'librarian']) {
    store.saveUser({ sessionId, id: randomUUID(), content: `给${agent}的问题`, agent });
    const id = randomUUID();
    store.beginAssistant(sessionId, id, true, agent);
    store.append(id, `${agent}的回答`);
    store.finish(id, 'complete');
  }
  const history = store.history(sessionId);
  assert.deepEqual(history.messages.filter(m => m.role === 'assistant').map(m => m.agent), ['qa', 'taotao', 'librarian']);
  const raw = readFileSync(join(store.vault, 'raw/对话', `${sessionId}.md`), 'utf8');
  for (const name of ['问答助手', '滔滔', '知识库管理员']) assert.ok(raw.includes(name));
});

async function httpFixture(t, fetchImpl) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-librarian-http-'));
  const server = createServer({ memoryRoot: root, fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('taotao-librarian-http-'));
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
  return { base, post, root };
}

test('ordinary agents stay read-only even when old curate flags and APIs are requested; collection creates a librarian conversation', async t => {
  const calls = [];
  const { base, post } = await httpFixture(t, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    assert.equal(calls.at(-1).body.stream, true, 'ordinary agent cannot start the former Wiki curator');
    return new Response('data: {"choices":[{"delta":{"content":"这是待交给管理员核查的回答。"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const agents = await (await fetch(base + '/api/agents')).json();
  const librarian = agents.agents.find(agent => agent.id === 'librarian');
  assert.ok(librarian?.system && Array.isArray(librarian.skills));
  assert.equal(agents.permission, false);
  const sessionId = randomUUID();
  await post('/api/memory/user', { sessionId, id: randomUUID(), content: '介绍离线模式', agent: 'qa' });
  const messageId = randomUUID();
  const response = await post('/api/chat', { apiKey, model, agent: 'qa', webSearch: false,
    messages: [{ role: 'user', content: '介绍离线模式' }], memory: { sessionId, id: messageId, visible: true, curate: true } });
  assert.match(await response.text(), /\[DONE\]/);
  assert.equal(calls.length, 1);
  assert.equal((await post('/api/memory/curate', { apiKey, model, agent: 'qa' })).status, 403);
  const collected = await post('/api/knowledge/submit', { sessionId, messageId });
  assert.equal(collected.status, 200);
  const request = await collected.json();
  assert.ok(request.sessionId && request.requestId);
  const history = await (await fetch(base + '/api/memory/history?id=' + request.sessionId)).json();
  assert.equal(history.session.agent, 'librarian');
  assert.ok(history.messages.some(m => m.role === 'user' && m.agent === 'librarian'));
  const duplicate = await (await post('/api/knowledge/submit', { sessionId, messageId })).json();
  assert.deepEqual(duplicate, request, 'repeating collection opens the same review conversation');
  assert.equal(calls.length, 1, 'creating a review conversation does not silently call a model');
});

test('fragmented model tool calls open an administrator review with the actual archived source, including tool-only replies', async t => {
  let calls = 0;
  const { base, post, root } = await httpFixture(t, async (_url, options) => {
    const body = JSON.parse(options.body); calls++;
    assert.ok(body.tools.some(tool => tool.function.name === 'request_knowledge_review'));
    const pieces = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: 'request_knowledge_', arguments: '{"reason":"新' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'review', arguments: '知识需要查证"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    return new Response(pieces.map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const sessionId = randomUUID(), userId = randomUUID(), messageId = randomUUID();
  const original = '介绍离线模式和同步的关系。'; // No collection keyword: the model decides to request review.
  await post('/api/memory/user', { sessionId, id: userId, content: original, agent: 'qa' });
  const response = await post('/api/chat', { apiKey, model, agent: 'qa', webSearch: false, messages: [{ role: 'user', content: original }], memory: { sessionId, id: messageId, visible: true, curate: false } });
  const text = await response.text();
  assert.match(text, /已提交知识库管理员/);
  const frames = text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
  const handoff = frames.find(frame => frame.handoff)?.handoff;
  assert.ok(handoff?.sessionId && handoff.requestId);
  assert.ok(text.indexOf('"handoff"') < text.indexOf('data: [DONE]'), 'handoff arrives before completion');
  assert.equal(calls, 1, 'the server does not silently perform librarian work on the ordinary model call');
  const history = await (await fetch(base + '/api/memory/history?id=' + handoff.sessionId)).json();
  assert.equal(history.session.agent, 'librarian');
  assert.ok(history.messages[0].content.includes(original));
  assert.ok(history.messages[0].content.includes('待核查'));
  const db = new DatabaseSync(join(root, 'data/memory.sqlite'), { readOnly: true });
  try {
    const request = db.prepare('SELECT * FROM knowledge_requests WHERE id=?').get(handoff.requestId);
    assert.equal(request.origin_session, sessionId); assert.equal(request.origin_message, messageId);
    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(userId);
    assert.equal(source.kind, 'user'); assert.equal(source.content, original);
    assert.equal(db.prepare('SELECT * FROM sources WHERE id=?').get(history.messages[0].id).kind, 'request');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM knowledge_sources').get().n, 0);
  } finally { db.close(); }
});

const modelResponse = content => Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
function researchMock({ localClaimId, forged = false, refresh = false, privateURL = false, rejectReview = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    url = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    if (!body) {
      assert.ok(!url.includes('127.0.0.1'), 'private source URL must never be requested');
      return new Response(`<!doctype html><html lang="zh-CN"><head><title>离线模式说明</title><meta name="author" content="示例文档"><meta property="article:published_time" content="2026-10-01"></head><body><main><h1>离线模式说明</h1><p>${quote}</p><p>适用于桌面版本。</p></main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.endsWith('/search')) return Response.json({ results: [{ title: '离线模式说明', url: privateURL ? 'http://127.0.0.1:8765/private' : 'https://example.org/guide/offline', content: '搜索摘要用于定位资料，不是完整证据。', date: '2026-10-01' }] });
    const prompt = body.messages[0].content;
    const input = JSON.parse(body.messages.at(-1).content);
    if (prompt.includes('知识覆盖检查')) return modelResponse({ answerable: !!localClaimId, needsRefresh: refresh, claimIds: localClaimId ? [localClaimId] : [], gaps: localClaimId && !refresh ? [] : ['离线模式限制'], queries: ['离线模式同步限制 官方说明'], reason: localClaimId ? '已有对应结论' : '缺少经过核查的证据' });
    if (prompt.includes('知识证据整理')) {
      const retrieved = input.sources.find(s => s.kind === 'web');
      if (!retrieved) return modelResponse({ summary: '', pages: [], gaps: ['没有可读取的原始资料'] });
      const proposed = page(retrieved);
      if (forged) proposed.claims[0].evidence[0].quote = '未在原文出现的伪造引用。';
      return modelResponse({ summary: proposed.summary, pages: [proposed], gaps: [], sourceAssessments: [{ id: retrieved.id, reliability: 'high', reason: '原始产品使用文档直接说明离线和同步的适用条件。' }] });
    }
    if (prompt.includes('证据支持审查')) return modelResponse(rejectReview
      ? { approved: [], rejected: [{ pagePath: notePath, claimIndex: 0, reason: '原文不能支持该结论的全部适用条件。' }] }
      : { approved: [{ pagePath: notePath, claimIndex: 0 }], rejected: [] });
    if (prompt.startsWith('知识修正')) return modelResponse({ pages: [], gaps: [] });
    throw new Error('Unexpected librarian model stage: ' + prompt.slice(0, 60));
  };
  return { calls, fetchImpl };
}

test('librarian reuses a fully supported local note without web searches or rewrites', async t => {
  const { runLibrarian } = await import('./librarian.mjs');
  const { store } = fixture(t);
  await seed(store);
  const note = store.knowledgeRecall('离线模式').pages.find(p => p.path === notePath);
  const before = wikiSnapshot(store);
  const mock = researchMock({ localClaimId: note.claims[0].id });
  const result = await runLibrarian({ memory: store, apiKey, model, question: '离线模式是否需要网络？', fetchImpl: mock.fetchImpl, lookupImpl, signal: new AbortController().signal, send: async () => {} });
  assert.equal(result.knowledge.mode, 'local');
  assert.ok(result.text.includes('离线模式'));
  assert.ok(result.text.includes('example.org/guide/offline'));
  assert.ok(mock.calls.every(c => !c.url.endsWith('/search') && c.body), 'only coverage analysis is needed');
  assert.deepEqual(wikiSnapshot(store), before);
});

test('collecting a draft still merges the new details into an already-covered note', async t => {
  const { runLibrarian } = await import('./librarian.mjs');
  const { store } = fixture(t);
  await seed(store);
  const existing = store.knowledgeRecall('离线模式').pages.find(p => p.path === notePath);
  const oldText = existing.claims[0].text;
  // 一场普通对话：回答里有旧笔记没有的细节。
  const sessionId = randomUUID(), messageId = randomUUID();
  store.saveUser({ sessionId, id: randomUUID(), content: '离线模式和同步怎么配合？', agent: 'qa' });
  store.beginAssistant(sessionId, messageId, true, 'qa');
  store.append(messageId, '离线可以读已下载资料。断网期间的修改会留在待上传队列，恢复连接后自动同步。');
  store.finish(messageId, 'complete');
  const newer = '断网期间的修改会留在待上传队列，恢复连接后自动同步。';
  store.research(messageId, { query: '离线模式 同步队列', sources: [{ title: '同步队列说明', url: 'https://example.org/guide/queue',
    content: `${newer}仅适用于桌面版本。`, publishedAt: '2026-10-02' }] });
  const request = store.createKnowledgeRequest({ sessionId, messageId });
  const submission = store.knowledgeRequest(request.sessionId);
  const question = store.history(request.sessionId).messages[0].content;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    url = String(url); const body = options.body ? JSON.parse(options.body) : null; calls.push(url);
    const prompt = body.messages[0].content, input = JSON.parse(body.messages.at(-1).content);
    if (prompt.includes('知识覆盖检查')) return modelResponse({ answerable: true, claimIds: [existing.claims[0].id], gaps: [], queries: [], reason: '本地已有对应结论' });
    if (prompt.includes('知识证据整理')) {
      const queue = input.sources.find(s => String(s.content).includes('待上传队列'));
      assert.ok(queue, 'the earlier session source is available to the compile step');
      return modelResponse({ pages: [{ path: notePath, summary: '离线与同步的关系。', claims: [
        { text: oldText, status: 'reviewed', kind: 'knowledge', attribution: '产品文档', reviewState: 'accepted', basis: 'explanation',
          evidence: [{ sourceId: existing.claims[0].evidence[0].sourceId, quote, locator: '使用说明', relation: 'supports' }] },
        { text: newer, status: 'reviewed', kind: 'knowledge', attribution: '产品文档', reviewState: 'accepted', basis: 'explanation',
          evidence: [{ sourceId: queue.id, quote: newer, locator: '同步队列说明', relation: 'supports' }] }], links: [] }], gaps: [] });
    }
    if (prompt.includes('证据支持审查')) return modelResponse({ approved: [{ pagePath: notePath, claimIndex: 0 }], rejected: [] });
    throw new Error('Unexpected stage: ' + prompt.slice(0, 40));
  };
  const result = await runLibrarian({ memory: store, apiKey, model, question, submission, userSourceId: submission.sourceId,
    fetchImpl, lookupImpl, signal: new AbortController().signal, send: async () => {} });
  assert.equal(result.knowledge.saved, true, 'a covered topic still stores the new detail');
  assert.match(result.text, /新增 1 段/);
  assert.match(result.text, /跳过 1 段重复/);
  const note = store.knowledgeRecall('离线模式').pages.find(p => p.path === notePath);
  assert.equal(note.claims.length, 2);
  assert.ok(note.claims.some(claim => claim.text.includes('待上传队列')));
  assert.ok(readFileSync(join(store.vault, notePath), 'utf8').includes('待上传队列'));
});

test('collecting a fully repeated draft says so instead of silently returning the old note', async t => {
  const { runLibrarian } = await import('./librarian.mjs');
  const { store } = fixture(t);
  await seed(store);
  const existing = store.knowledgeRecall('离线模式').pages.find(p => p.path === notePath);
  const sessionId = randomUUID(), messageId = randomUUID();
  store.saveUser({ sessionId, id: randomUUID(), content: '再说一遍离线模式。', agent: 'qa' });
  store.beginAssistant(sessionId, messageId, true, 'qa');
  store.append(messageId, existing.claims[0].text);
  store.finish(messageId, 'complete');
  const request = store.createKnowledgeRequest({ sessionId, messageId });
  const submission = store.knowledgeRequest(request.sessionId);
  const question = store.history(request.sessionId).messages[0].content;
  const fetchImpl = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages[0].content;
    if (prompt.includes('知识覆盖检查')) return modelResponse({ answerable: true, claimIds: [existing.claims[0].id], gaps: [], queries: [], reason: '已有对应结论' });
    if (prompt.includes('知识证据整理')) return modelResponse({ pages: [{ path: notePath, summary: '离线与同步的关系。', claims: [
      { text: existing.claims[0].text, status: 'reviewed', kind: 'knowledge', attribution: '产品文档', reviewState: 'accepted', basis: 'explanation',
        evidence: [{ sourceId: existing.claims[0].evidence[0].sourceId, quote, locator: '使用说明', relation: 'supports' }] }], links: [] }], gaps: [] });
    throw new Error('Unexpected stage: ' + prompt.slice(0, 40));
  };
  const before = readFileSync(join(store.vault, notePath), 'utf8');
  const result = await runLibrarian({ memory: store, apiKey, model, question, submission, userSourceId: submission.sourceId,
    fetchImpl, lookupImpl, signal: new AbortController().signal, send: async () => {} });
  assert.equal(result.knowledge.saved, false);
  assert.match(result.text, /没有找到可新增的细节/);
  assert.equal(readFileSync(join(store.vault, notePath), 'utf8'), before, 'no rewrite when nothing is new');
});

test('librarian reads the original document, checks per-claim evidence and stores an attributed note', async t => {
  const { runLibrarian } = await import('./librarian.mjs');
  const { store } = fixture(t);
  store.setKnowledgePermission(true);
  const mock = researchMock();
  const result = await runLibrarian({ memory: store, apiKey, model, question: '离线模式是否需要网络？', fetchImpl: mock.fetchImpl, lookupImpl, signal: new AbortController().signal, send: async () => {} });
  assert.equal(result.knowledge.mode, 'web');
  assert.equal(result.knowledge.saved, true);
  assert.ok(mock.calls.some(c => c.url === 'https://example.org/guide/offline' && !c.body), 'original HTML is opened rather than relying on a search snippet');
  assert.ok(result.text.includes('example.org/guide/offline'));
  const recalled = store.knowledgeRecall('离线模式');
  assert.ok(recalled.pages.some(p => p.path === notePath && p.claims.length));
  assert.match(readFileSync(join(store.vault, notePath), 'utf8'), /2026-10-01/);
});

test('an explicit need to refresh forces a web check even when a note was just archived', async t => {
  const { runLibrarian } = await import('./librarian.mjs');
  const { store } = fixture(t);
  await seed(store);
  const note = store.knowledgeRecall('离线模式').pages.find(p => p.path === notePath);
  const mock = researchMock({ localClaimId: note.claims[0].id, refresh: true });
  await runLibrarian({ memory: store, apiKey, model, question: '现在离线模式是否需要网络？', fetchImpl: mock.fetchImpl, lookupImpl, signal: new AbortController().signal, send: async () => {} });
  assert.ok(mock.calls.some(c => c.url.endsWith('/search')), 'recent storage time cannot override an explicit stale-evidence judgement');
});

test('private source addresses are never fetched or published, and cancellation stops before model work', async t => {
  const { runLibrarian } = await import('./librarian.mjs');
  const { store } = fixture(t);
  store.setKnowledgePermission(true);
  const before = wikiSnapshot(store);
  const mock = researchMock({ privateURL: true });
  const result = await runLibrarian({ memory: store, apiKey, model, question: '离线模式是否需要网络？', fetchImpl: mock.fetchImpl, lookupImpl, signal: new AbortController().signal, send: async () => {} });
  assert.equal(result.knowledge.saved, false);
  assert.ok(mock.calls.every(c => !c.url.startsWith('http://127.0.0.1')));
  assert.deepEqual(wikiSnapshot(store), before);
  const aborted = new AbortController(); aborted.abort();
  const calls = mock.calls.length;
  await assert.rejects(() => runLibrarian({ memory: store, apiKey, model, question: '离线模式', fetchImpl: mock.fetchImpl, lookupImpl, signal: aborted.signal, send: async () => {} }), { name: 'AbortError' });
  assert.equal(mock.calls.length, calls);
});

test('read-only librarian can answer but cannot write, and fabricated quotations never publish', async t => {
  const { runLibrarian } = await import('./librarian.mjs');
  const { store } = fixture(t);
  const before = wikiSnapshot(store);
  const mock = researchMock();
  const result = await runLibrarian({ memory: store, apiKey, model, question: '离线模式是否需要网络？', fetchImpl: mock.fetchImpl, lookupImpl, signal: new AbortController().signal, send: async () => {} });
  assert.equal(result.knowledge.saved, false);
  assert.deepEqual(wikiSnapshot(store), before);
  store.setKnowledgePermission(true);
  const forged = researchMock({ forged: true });
  try {
    const failed = await runLibrarian({ memory: store, apiKey, model, question: '离线模式是否需要网络？', fetchImpl: forged.fetchImpl, lookupImpl, signal: new AbortController().signal, send: async () => {} });
    assert.equal(failed.knowledge.saved, false);
  } catch (error) { assert.match(error.message, /引用|证据|原文|核查/); }
  assert.deepEqual(wikiSnapshot(store), before);
});

test('a failed semantic evidence review never publishes a verified conclusion', async t => {
  const { runLibrarian } = await import('./librarian.mjs');
  const { store } = fixture(t); store.setKnowledgePermission(true);
  const before = wikiSnapshot(store);
  const mock = researchMock({ rejectReview: true });
  const result = await runLibrarian({ memory: store, apiKey, model, question: '离线模式是否需要网络？', fetchImpl: mock.fetchImpl, lookupImpl, signal: new AbortController().signal, send: async () => {} });
  assert.equal(result.knowledge.saved, false);
  assert.equal(result.knowledge.mode, 'unverified');
  assert.match(result.text, /未收录/);
  assert.match(result.text, /原文不能支持该结论的全部适用条件/);
  assert.deepEqual(wikiSnapshot(store), before);
});

test('personal statements are archived as statements, while mixed public claims still require web evidence', async t => {
  const { runLibrarian } = await import('./librarian.mjs');
  const { store } = fixture(t);
  store.setKnowledgePermission(true);
  const sessionId = randomUUID(), userSourceId = randomUUID();
  const original = '请记住，我叫小林，我的职业是建筑师。';
  store.saveUser({ sessionId, id: userSourceId, content: original, agent: 'librarian' });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    assert.ok(String(url).endsWith('/chat/completions'), 'personal statement must not become a public search query');
    const body = JSON.parse(options.body);
    const input = JSON.parse(body.messages.at(-1).content);
    if (body.messages[0].content.includes('知识覆盖检查')) return modelResponse({ answerable: false, needsRefresh: false, userStatementOnly: true, claimIds: [], gaps: [], queries: [], reason: '仅整理用户本人明确自述' });
    if (body.messages[0].content.includes('知识证据整理')) {
      const actual = input.sources.find(s => s.id === userSourceId);
      assert.equal(actual.content, original);
      return modelResponse({ summary: '用户自述姓名小林，职业建筑师。', pages: [{ path: 'wiki/人物/用户.md', summary: '用户自述姓名小林，职业建筑师。', claims: [{ text: '用户自述姓名小林，职业建筑师。', status: 'user_statement', scope: '用户本人陈述', asOf: null, evidence: [{ sourceId: userSourceId, quote: original, locator: '用户原话', relation: 'supports' }] }], links: [] }], gaps: [] });
    }
    return modelResponse({ approved: [{ pagePath: 'wiki/人物/用户.md', claimIndex: 0 }], rejected: [] });
  };
  const personal = await runLibrarian({ memory: store, apiKey, model, question: original, userSourceId, fetchImpl, lookupImpl, signal: new AbortController().signal, send: async () => {} });
  assert.equal(personal.knowledge.saved, true);
  assert.match(personal.text, /用户(?:自述|曾表示|陈述)/);
  const note = store.knowledgeRecall('小林').pages.find(p => p.path === 'wiki/人物/用户.md');
  assert.equal(note.claims[0].status, 'user_statement');
  const mixedId = randomUUID();
  const question = '我是一名程序员，请收录离线模式是否需要网络。';
  store.saveUser({ sessionId, id: mixedId, content: question, agent: 'librarian' });
  const mixed = researchMock();
  await runLibrarian({ memory: store, apiKey, model, question, userSourceId: mixedId, fetchImpl: mixed.fetchImpl, lookupImpl, signal: new AbortController().signal, send: async () => {} });
  assert.ok(mixed.calls.some(c => c.url.endsWith('/search')), 'mentioning a profession cannot turn an external fact into a personal statement');
});
