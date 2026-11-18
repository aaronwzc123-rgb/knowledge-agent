import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from './server.mjs';

const apiKey = 'sk-summary-integration-only', model = 'fixture-model';
const quote = '项目报告记载，2026年第一阶段的研究预算为320元，第二阶段尚未确定。';
const paragraph = '项目报告记载，2026年第一阶段研究预算为320元；第二阶段预算尚未确定。';
const notePath = 'wiki/主题/项目研究预算.md';
const responseJSON = value => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
const frames = text => text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
const answer = text => frames(text).map(frame => frame.choices?.[0]?.delta?.content || '').join('');

async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-summary-http-'));
  const config = { status: 'document_statement', forgedSummary: false, forgedLibrarian: false, ...options };
  const calls = [], extracts = [];
  const server = createServer({ memoryRoot: root, resourceExtractImpl: async ({ path, signal }) => {
    extracts.push(path);
    if (config.extractImpl) return config.extractImpl({ path, signal });
    return { parser: 'fixture-extractor', pages: [{ page: 3, locator: '第3页', text: readFileSync(path, 'utf8') }], warnings: [], truncated: false };
  }, fetchImpl: async (url, request) => {
    const body = JSON.parse(request.body); calls.push({ url: String(url), body });
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions', 'document work must never search the web');
    assert.equal(body.stream, false);
    const system = body.messages[0].content, input = JSON.parse(body.messages[1].content);
    if (config.httpError) return Response.json({ error: 'fixture-error' }, { status: config.httpError });
    if (config.holdModel) return new Promise((_done, reject) => {
      request.signal.addEventListener('abort', () => { config.modelAborted = true; reject(new DOMException('cancelled', 'AbortError')); }, { once: true });
      config.modelStarted?.();
    });
    if (system.startsWith('你是资料摘要助手')) {
      assert.equal(input.sources[0].locator, '第3页');
      assert.ok(input.sources[0].text.includes(quote));
      return responseJSON({ paragraphs: [{ text: paragraph, evidence: [{ sourceId: input.sources[0].sourceId,
        quote: config.forgedSummary ? '这一段并不存在于报告中，预算为999万元。' : quote }] }], gaps: [] });
    }
    if (system.startsWith('逐段核对摘要')) return responseJSON({ approved: [0], gaps: [] });
    if (system.startsWith('本地资料收录')) {
      assert.ok(input.draft[0].text.includes('320元'));
      const source = input.sources.find(source => source.kind === 'document');
      assert.ok(source?.document?.sha256 && source.document.version === 1);
      return responseJSON({ pages: [{ path: notePath, summary: '项目报告中的阶段预算。', claims: [{ text: paragraph, status: config.status,
        scope: '项目报告', asOf: '2026年', evidence: [{ sourceId: source.id, quote: config.forgedLibrarian ? '报告没有记载的伪造预算结论。' : quote,
          locator: source.document.locator, relation: 'supports' }] }], links: [] }], gaps: [] });
    }
    if (system.startsWith('证据支持审查')) return responseJSON({ approved: [{ pagePath: notePath, claimIndex: 0 }], rejected: [] });
    throw new Error('Unexpected model workflow: ' + system.slice(0, 60));
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(done => server.close(done));
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('taotao-summary-http-'));
    await rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const upload = async (folder = '') => {
    const response = await fetch(`${base}/api/resources/upload?name=${encodeURIComponent('项目报告.pdf')}&folder=${encodeURIComponent(folder)}`, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/octet-stream' }, body: quote });
    assert.equal(response.status, 201); return (await response.json()).file;
  };
  const chat = async (agent, sessionId, content, resourceIds, extra = {}) => {
    const id = randomUUID();
    const response = await post('/api/chat', { apiKey, model, agent, webSearch: true,
      messages: [{ role: 'user', content }], memory: { sessionId, id, visible: true, curate: true }, ...(resourceIds ? { resourceIds } : {}) }, extra);
    return { id, response, text: await response.text() };
  };
  const summarize = async file => {
    const sessionId = randomUUID(), content = `请摘要这份资料 [项目报告](<${base}/?resource=${file.id}&version=1>)`;
    assert.equal((await post('/api/memory/user', { sessionId, id: randomUUID(), content, agent: 'summarizer' })).status, 200);
    const result = await chat('summarizer', sessionId, content, [file.id]);
    return { ...result, sessionId };
  };
  const collect = async summary => {
    const response = await post('/api/knowledge/submit', { sessionId: summary.sessionId, messageId: summary.id });
    assert.equal(response.status, 200);
    return response.json();
  };
  const review = async handoff => {
    const history = await (await fetch(`${base}/api/memory/history?id=${handoff.sessionId}`)).json();
    return chat('librarian', handoff.sessionId, history.messages.find(message => message.role === 'user').content);
  };
  return { root, base, post, config, calls, extracts, upload, chat, summarize, collect, review };
}

test('folders, keyless cached extraction, cited summaries and original version snapshots work together', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/resources/folders', { name: '项目' })).status, 201);
  assert.equal((await f.post('/api/resources/folders', { parent: '项目', name: '原件' })).status, 201);
  const file = await f.upload('项目/原件');
  assert.equal(file.relativePath, '项目/原件/项目报告.pdf');
  const listing = await (await fetch(f.base + '/api/resources')).json();
  assert.ok(listing.folders.some(folder => folder.path === '项目/原件'));
  const first = await f.post(`/api/resources/${file.id}/extract`, { version: 1 });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).cached, false);
  const cached = await (await f.post(`/api/resources/${file.id}/extract`, { version: 1 })).json();
  assert.equal(cached.cached, true);
  assert.equal(cached.pages[0].locator, '第3页');
  assert.equal(f.calls.length, 0, 'extracting needs no key or model');
  const result = await f.summarize(file);
  assert.match(result.text, /\[DONE\]/);
  const content = answer(result.text);
  assert.ok(content.includes(paragraph));
  assert.match(content, /第3页/);
  assert.match(content, /version=1/);
  assert.match(content, /#page=3/);
  assert.match(content, /v1/);
  assert.equal(f.extracts.length, 1, 'summary reuses the original extraction cache');
  assert.equal(f.calls.length, 2, 'one summary and one citation review');
  const status = await (await fetch(f.base + '/api/knowledge/status')).json();
  assert.equal(status.claims, 0, 'summary agent cannot write Wiki even with legacy curate=true');
  assert.ok(!existsSync(join(f.root, '我的记忆库', notePath)));
  writeFileSync(join(f.root, '资料库', file.relativePath), '原件已改为新的内容。');
  await fetch(f.base + '/api/resources');
  const current = await (await fetch(`${f.base}/api/resources/${file.id}`)).json();
  assert.equal(current.version, 2);
  const historical = await (await fetch(`${f.base}/api/resources/${file.id}?version=1`)).json();
  assert.equal(historical.snapshot, true);
  assert.equal(historical.version, 1);
  const original = await fetch(`${f.base}/api/resources/${file.id}/file?version=1`);
  assert.equal(original.status, 200);
  assert.equal(await original.text(), quote, 'old citation opens the bytes actually summarized');
});

test('manual summary handoff lets only an authorized administrator save document knowledge and citations', async t => {
  const f = await fixture(t), file = await f.upload(), summary = await f.summarize(file);
  const handoff = await f.collect(summary);
  const denied = await f.review(handoff);
  const deniedResult = frames(denied.text).find(frame => frame.knowledge)?.knowledge;
  assert.equal(deniedResult.saved, false);
  assert.equal(deniedResult.permissionRequired, true);
  assert.ok(!existsSync(join(f.root, '我的记忆库', notePath)));
  assert.equal((await f.post('/api/knowledge/permission', { enabled: true })).status, 200);
  const approved = await f.review(handoff);
  const result = frames(approved.text).find(frame => frame.knowledge)?.knowledge;
  assert.equal(result.saved, true, approved.text);
  const note = readFileSync(join(f.root, '我的记忆库', notePath), 'utf8');
  assert.ok(note.includes(paragraph));
  assert.match(note, /项目报告\.pdf/);
  assert.match(note, /第3页/);
  assert.match(note, /version=1/);
  assert.match(note, /v1/);
  assert.doesNotMatch(note, /已核实|适用时间：/);
  const db = new DatabaseSync(join(f.root, 'data/memory.sqlite'), { readOnly: true });
  try {
    const claim = db.prepare('SELECT status,evidence FROM knowledge_claims').get();
    assert.equal(claim.status, 'document_statement');
    assert.equal(JSON.parse(claim.evidence)[0].quote, quote);
    const source = JSON.parse(db.prepare('SELECT data FROM knowledge_sources').get().data);
    assert.equal(source.kind, 'document');
    assert.equal(source.reliability, 'document_statement');
    assert.equal(source.document.resourceId, file.id);
    assert.equal(source.document.version, 1);
    assert.equal(source.document.locator, '第3页');
    assert.match(source.document.sha256, /^[a-f0-9]{64}$/);
  } finally { db.close(); }
  assert.ok(f.calls.every(call => call.url.endsWith('/chat/completions')));
});

test('invented quotations and promotion of document evidence cannot enter knowledge', async t => {
  for (const config of [{ forgedSummary: true }, { forgedLibrarian: true }, { status: 'verified' }, { status: 'user_statement' }]) {
    await t.test(JSON.stringify(config), async sub => {
      const f = await fixture(sub, config), file = await f.upload(), summary = await f.summarize(file);
      if (config.forgedSummary) {
        assert.match(answer(summary.text), /未生成可引用结论/);
        assert.doesNotMatch(answer(summary.text), /999万元/);
        assert.equal(f.calls.length, 1, 'a nonmatching quote is discarded before review');
      } else {
        await f.post('/api/knowledge/permission', { enabled: true });
        const review = await f.review(await f.collect(summary));
        assert.equal(frames(review.text).find(frame => frame.knowledge)?.knowledge.saved, false);
        assert.match(answer(review.text), /不足|未收录/);
      }
      assert.ok(!existsSync(join(f.root, '我的记忆库', notePath)));
      assert.equal((await (await fetch(f.base + '/api/knowledge/status')).json()).claims, 0);
    });
  }
});

test('model HTTP failures and cancellation never publish or finish a summary draft', async t => {
  await t.test('readable upstream failure', async sub => {
    const f = await fixture(sub, { httpError: 401 }), summary = await f.summarize(await f.upload());
    const errors = frames(summary.text).filter(frame => frame.error);
    assert.ok(errors.some(frame => /API Key/.test(frame.error)));
    assert.doesNotMatch(summary.text, /\[DONE\]/);
    assert.equal((await f.post('/api/knowledge/submit', { sessionId: summary.sessionId, messageId: summary.id })).status, 400);
    const db = new DatabaseSync(join(f.root, 'data/library.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) n FROM resource_summaries').get().n, 0); } finally { db.close(); }
  });
  await t.test('client cancellation reaches the model call', async sub => {
    let start;
    const started = new Promise(done => { start = done; });
    const f = await fixture(sub, { holdModel: true, modelStarted: start }), file = await f.upload();
    const sessionId = randomUUID(), content = '摘要项目报告';
    await f.post('/api/memory/user', { sessionId, id: randomUUID(), agent: 'summarizer', content });
    const controller = new AbortController();
    const pending = f.chat('summarizer', sessionId, content, [file.id], { signal: controller.signal });
    await started; controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    for (let attempt = 0; !f.config.modelAborted && attempt < 50; attempt++) await new Promise(done => setTimeout(done, 10));
    assert.equal(f.config.modelAborted, true);
    const db = new DatabaseSync(join(f.root, 'data/library.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) n FROM resource_summaries').get().n, 0); } finally { db.close(); }
    assert.equal((await (await fetch(f.base + '/api/knowledge/status')).json()).claims, 0);
  });
});
