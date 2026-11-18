import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from './server.mjs';
import { createActivityTracker } from './activity.mjs';
import { MemoryStore } from './memory.mjs';
import { runLibrarian } from './librarian.mjs';

const key = 'sk-activity-fixture-only';
const model = 'deepseek-flash';
const stream = () => new Response('data: {"choices":[{"delta":{"content":"这是已经生成的回答。"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
const frames = text => text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
async function fixture(t, fetchImpl) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-activity-'));
  const server = createServer({ memoryRoot: root, fetchImpl });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(done => server.close(done));
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('taotao-activity-'));
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, signal) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body), signal });
  const sessionId = randomUUID(), messageId = randomUUID();
  await post('/api/memory/user', { sessionId, id: randomUUID(), content: '请解释测试任务。', agent: 'qa' });
  const request = { apiKey: key, model, agent: 'qa', webSearch: false, messages: [{ role: 'user', content: '请解释测试任务。' }], memory: { sessionId, id: messageId, visible: true, curate: false } };
  const history = async () => {
    const message = (await (await fetch(base + '/api/memory/history?id=' + sessionId)).json()).messages.find(m => m.id === messageId);
    if (message && typeof message.activity === 'string') message.activity = JSON.parse(message.activity);
    return message;
  };
  return { root, post, request, history };
}

test('tracker retains real operation identity and marks unfinished work failed or cancelled', async () => {
  const events = [], activity = createActivityTracker(async frame => events.push(frame.activity));
  const id = await activity.start('search', '联网搜索', { detail: '明确的公开查询' });
  await activity.finish(id, { detail: '找到 2 个来源' });
  const pending = await activity.start('source', '读取网页原文');
  await activity.stop('cancelled');
  assert.equal(events[0].id, events[1].id);
  assert.equal(events[1].startedAt, events[0].startedAt);
  assert.ok(events[1].elapsedMs >= 0);
  assert.equal(events.at(-1).id, pending);
  assert.equal(events.at(-1).state, 'cancelled');
});

test('live activity arrives before a held model responds and is restored with the completed message', async t => {
  let release, started;
  const gate = new Promise(done => { release = done; });
  t.after(() => release());
  const waiting = new Promise(done => { started = done; });
  const { post, request, history } = await fixture(t, async () => { started(); await gate; return stream(); });
  const response = await post('/api/chat', request);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '';
  await waiting;
  while (!text.includes('生成回答')) text += decoder.decode((await reader.read()).value);
  assert.ok(text.includes('deepseek-flash'));
  assert.ok(!text.includes(key));
  assert.ok(!text.includes('这是已经生成的回答'));
  while (!text.includes('"heartbeat"')) {
    const chunk = await Promise.race([reader.read(), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('waiting connection emitted no heartbeat')), 6500); timer.unref();
    })]);
    text += decoder.decode(chunk.value);
  }
  assert.equal(frames(text).filter(frame => frame.activity?.kind === 'answer').length, 1, 'waiting does not invent additional progress');
  release();
  while (true) { const chunk = await reader.read(); text += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done }); if (chunk.done) break; }
  const steps = frames(text).filter(frame => frame.activity).map(frame => frame.activity);
  assert.ok(steps.some(step => step.kind === 'memory' && step.state === 'complete'));
  assert.ok(steps.some(step => step.kind === 'answer' && step.state === 'running' && step.title === '输出回答'));
  assert.equal(steps.at(-1).state, 'complete');
  const saved = await history();
  assert.equal(saved.status, 'complete');
  assert.ok(Array.isArray(saved.activity));
  assert.ok(saved.activity.every(step => step.state !== 'running'));
});

test('cancelled waiting and upstream failure settle persistent activities accurately', async t => {
  for (const cancelled of [true, false]) await t.test(cancelled ? 'cancelled' : 'failed', async t => {
    let started;
    const waiting = new Promise(done => { started = done; });
    const { post, request, history } = await fixture(t, async (_url, options) => {
      started();
      if (!cancelled) return new Response(key, { status: 401 });
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    });
    const controller = new AbortController();
    const response = await post('/api/chat', request, controller.signal);
    await waiting;
    if (cancelled) controller.abort();
    else {
      const text = await response.text();
      assert.ok(frames(text).at(-1).error);
      assert.ok(!text.includes(key));
    }
    let saved;
    for (let i = 0; i < 50; i++) {
      saved = await history();
      if (saved?.status === 'interrupted' && saved.activity.some(step => step.kind === 'answer' && step.state === (cancelled ? 'cancelled' : 'failed'))) break;
      await new Promise(done => setTimeout(done, 10));
    }
    assert.equal(saved.status, 'interrupted');
    assert.ok(saved.activity.every(step => step.state !== 'running'));
    assert.equal(saved.activity.find(step => step.kind === 'answer').state, cancelled ? 'cancelled' : 'failed');
  });
});

test('librarian reports actual queries, opened sources, evidence review and saved notes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'taotao-activity-'));
  const memory = new MemoryStore(root); memory.setKnowledgePermission(true);
  t.after(() => { memory.close(); const target = resolve(root); assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('taotao-activity-')); rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); });
  const events = [], quote = '离线模式可以读取已经下载的资料。', path = 'wiki/主题/离线模式是什么.md';
  const modelResponse = value => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
  const result = await runLibrarian({ memory, apiKey: key, model, question: '离线模式是什么？', send: async frame => { if (frame.activity) events.push(frame.activity); },
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url, options = {}) => {
      if (!options.body) return new Response(`<html><head><title>离线模式说明</title></head><body><main><p>${quote}</p><p>这份使用说明介绍已经下载的资料如何在离线状态下读取，适用于产品文档中注明的版本。</p></main></body></html>`, { headers: { 'Content-Type': 'text/html' } });
      const body = JSON.parse(options.body);
      if (String(url).endsWith('/search')) return Response.json({ results: [{ url: 'https://example.org/offline', title: '离线模式说明' }] });
      const input = JSON.parse(body.messages.at(-1).content), prompt = body.messages[0].content;
      if (prompt.includes('知识覆盖检查')) return modelResponse({ answerable: false, queries: ['离线模式 官方说明'], claimIds: [] });
      if (prompt.includes('知识证据整理')) {
        const source = input.sources[0];
        return modelResponse({ sourceAssessments: [{ id: source.id, reliability: 'high', reason: '原始使用文档直接说明离线读取功能。' }], pages: [{ path, summary: quote, claims: [{ text: quote, status: 'verified', evidence: [{ sourceId: source.id, quote, locator: '正文', relation: 'supports' }] }], links: [] }] });
      }
      return modelResponse({ approved: [{ pagePath: path, claimIndex: 0 }] });
    } });
  assert.equal(result.knowledge.saved, true);
  assert.ok(events.some(step => step.kind === 'search' && step.detail.includes('离线模式 官方说明')));
  assert.ok(events.some(step => step.kind === 'source' && step.state === 'complete' && step.items[0].url === 'https://example.org/offline'));
  assert.ok(events.some(step => step.kind === 'review' && step.state === 'complete'));
  assert.ok(events.some(step => step.kind === 'save' && step.state === 'complete' && step.items[0].path === path));
  const latest = new Map(events.map(step => [step.id, step]));
  assert.ok([...latest.values()].every(step => step.state !== 'running'));
  assert.ok(!JSON.stringify(events).includes(key));
});
