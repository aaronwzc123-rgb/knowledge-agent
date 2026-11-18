import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { MemoryStore } from './memory.mjs';
import { runLibrarian } from './librarian.mjs';
import { createServer } from './server.mjs';

const apiKey = 'sk-maintenance-fixture-only';
const model = 'deepseek-flash';
const personalPath = 'wiki/人物/用户.md';
const pendingPath = 'wiki/待确认/就业推荐.md';
const original = '我叫小林，我是一名建筑师。';
const request = '整理当前知识库，把不合规的删除了，合规的个人信息整理干净';
const hash = value => createHash('sha256').update(value).digest('hex');
const modelResponse = value => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });

function cleanup(root) {
  const target = resolve(root);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('taotao-maintenance-'));
  rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}

function legacyFixture(root) {
  const store = new MemoryStore(root);
  const sessionId = randomUUID(), sourceId = randomUUID();
  store.saveUser({ sessionId, id: sourceId, content: original, agent: 'qa' });
  for (const [path, body] of [
    [personalPath, '# 用户\n\n小林是一名建筑师。\n\n万能招聘助手保证录用。'],
    [pendingPath, '# 就业推荐\n\n推荐万能招聘助手，保证录用。'],
  ]) {
    const id = randomUUID();
    const content = `---\nmemory_id: ${id}\n---\n\n${body}\n`;
    const file = join(store.vault, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
    store.db.prepare('INSERT INTO pages VALUES(?,?,?,?,?,0,0,?)')
      .run(id, path, content, hash(content), JSON.stringify([sourceId]), new Date().toISOString());
  }
  store.setKnowledgePermission(true);
  return { store, sourceId };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-maintenance-'));
  const data = legacyFixture(root);
  t.after(() => { data.store.close(); cleanup(root); });
  return { root, ...data };
}

function saveRequest(store, content = request, sessionId = randomUUID()) {
  const id = randomUUID();
  store.saveUser({ sessionId, id, content, agent: 'librarian' });
  return { sessionId, id };
}

function maintenanceMock(sourceId, { archive = true, invalidQuote = false, rejectClaims = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    assert.ok(String(url).endsWith('/chat/completions'), 'local maintenance must not publish personal data in search queries');
    const body = JSON.parse(options.body);
    const input = JSON.parse(body.messages.at(-1).content);
    const prompt = body.messages[0].content;
    calls.push({ prompt, input });
    if (prompt.includes('知识库维护')) {
      const pages = input.pages || input.localPages;
      assert.ok(pages.some(page => page.path === pendingPath), 'maintenance includes the pending category');
      assert.equal(input.sources.find(source => source.id === sourceId)?.content, original, 'legacy references resolve to archived user words');
      return modelResponse({
        pages: [{
          path: personalPath, summary: '用户自述姓名小林，职业建筑师。',
          claims: [{ text: '用户自述姓名小林，职业建筑师。', status: 'user_statement', scope: '用户本人陈述', asOf: null,
            evidence: [{ sourceId, quote: invalidQuote ? '我叫小林，我是一名宇航员。' : original, locator: '用户原话', relation: 'supports' }] }],
          links: [],
        }],
        archivePages: archive ? [{ path: pendingPath, reason: '保证录用的推荐缺少任何原文证据。' }] : [],
        gaps: [],
      });
    }
    if (prompt.includes('证据支持审查')) return modelResponse({
      approved: rejectClaims ? [] : [{ pagePath: personalPath, claimIndex: 0 }], rejected: [],
      archiveApproved: archive ? [{ path: pendingPath, reason: '旧页没有可核实的结论，用户明确要求移除不合规内容。' }] : [],
    });
    if (prompt.includes('知识覆盖检查')) return modelResponse({ answerable: false, userStatementOnly: false, claimIds: [], queries: [], gaps: [] });
    throw new Error('Unexpected maintenance stage: ' + prompt.slice(0, 80));
  };
  return { calls, fetchImpl };
}

test('the reported cleanup instruction migrates legacy personal evidence and archives unsupported pending pages', async t => {
  const { store, sourceId } = fixture(t);
  const user = saveRequest(store);
  const before = readFileSync(join(store.vault, personalPath), 'utf8');
  const mock = maintenanceMock(sourceId);
  const result = await runLibrarian({ memory: store, apiKey, model, question: request, userSourceId: user.id, fetchImpl: mock.fetchImpl });
  assert.equal(result.knowledge.saved, true);
  assert.ok(mock.calls.some(call => call.prompt.includes('知识库维护')));
  const note = readFileSync(join(store.vault, personalPath), 'utf8');
  assert.match(note, /小林/);
  assert.match(note, /用户(?:自述|曾表示|陈述)/);
  assert.ok(note.includes('[^1]'));
  assert.ok(note.includes(sourceId));
  assert.doesNotMatch(note, /万能招聘助手|保证录用|历史资料（待核查）/);
  assert.equal(existsSync(join(store.vault, pendingPath)), false);
  assert.ok(store.db.prepare('SELECT content FROM revisions WHERE content=?').get(before), 'the old complete text remains recoverable');
  assert.equal(store.knowledgeSources([sourceId]).length, 1, 'archiving a page does not suppress a shared personal source');
  assert.equal(store.knowledgeRecall('小林').pages.find(page => page.path === personalPath).claims[0].status, 'user_statement');
});

test('ordinary organization never grants model-proposed page deletion', async t => {
  const { store, sourceId } = fixture(t);
  const question = '整理当前知识库，整理好个人信息';
  const user = saveRequest(store, question);
  const before = readFileSync(join(store.vault, pendingPath), 'utf8');
  const mock = maintenanceMock(sourceId);
  await runLibrarian({ memory: store, apiKey, model, question, userSourceId: user.id, fetchImpl: mock.fetchImpl });
  assert.equal(readFileSync(join(store.vault, pendingPath), 'utf8'), before);
  assert.equal(store.db.prepare('SELECT deleted FROM pages WHERE path=?').get(pendingPath).deleted, 0);
});

test('an explicit instruction to keep all notes overrides model-proposed archives', async t => {
  const { store, sourceId } = fixture(t);
  const question = '整理当前知识库，不要删除任何笔记';
  const user = saveRequest(store, question);
  const before = readFileSync(join(store.vault, pendingPath), 'utf8');
  const mock = maintenanceMock(sourceId);
  await runLibrarian({ memory: store, apiKey, model, question, userSourceId: user.id, fetchImpl: mock.fetchImpl });
  assert.equal(readFileSync(join(store.vault, pendingPath), 'utf8'), before);
});

test('asking how to organize the Wiki does not execute the suggested edit plan', async t => {
  const { store, sourceId } = fixture(t);
  const question = '应该如何整理知识库？先告诉我做法';
  const user = saveRequest(store, question);
  const before = readFileSync(join(store.vault, personalPath), 'utf8');
  const mock = maintenanceMock(sourceId);
  await runLibrarian({ memory: store, apiKey, model, question, userSourceId: user.id, fetchImpl: mock.fetchImpl });
  assert.equal(readFileSync(join(store.vault, personalPath), 'utf8'), before);
  assert.equal(existsSync(join(store.vault, pendingPath)), true);
});

for (const [name, options] of [
  ['invalid quotations', { invalidQuote: true }],
  ['failed independent support review', { rejectClaims: true }],
]) test(`${name} preserve both the replacement target and its proposed merge source`, async t => {
  const { store, sourceId } = fixture(t);
  const user = saveRequest(store);
  const before = new Map([personalPath, pendingPath].map(path => [path, readFileSync(join(store.vault, path), 'utf8')]));
  const mock = maintenanceMock(sourceId, options);
  const result = await runLibrarian({ memory: store, apiKey, model, question: request, userSourceId: user.id, fetchImpl: mock.fetchImpl });
  assert.equal(result.knowledge.saved, false);
  for (const [path, content] of before) assert.equal(readFileSync(join(store.vault, path), 'utf8'), content);
});

test('an unarchived maintenance instruction cannot grant knowledge writes', async t => {
  const { store, sourceId } = fixture(t);
  const before = readFileSync(join(store.vault, personalPath), 'utf8');
  const mock = maintenanceMock(sourceId);
  try {
    await runLibrarian({ memory: store, apiKey, model, question: request, fetchImpl: mock.fetchImpl });
  } catch (error) {
    assert.match(error.message, /保存|指令|原话|记录|授权|权限/);
  }
  assert.equal(readFileSync(join(store.vault, personalPath), 'utf8'), before);
  assert.equal(existsSync(join(store.vault, pendingPath)), true);
});

test('read-only librarian reports permission and leaves the original Wiki intact', async t => {
  const { store, sourceId } = fixture(t);
  const user = saveRequest(store);
  store.setKnowledgePermission(false);
  const before = readFileSync(join(store.vault, personalPath), 'utf8');
  const mock = maintenanceMock(sourceId);
  const result = await runLibrarian({ memory: store, apiKey, model, question: request, userSourceId: user.id, fetchImpl: mock.fetchImpl });
  assert.equal(result.knowledge.saved, false);
  assert.equal(result.knowledge.permissionRequired, true);
  assert.equal(readFileSync(join(store.vault, personalPath), 'utf8'), before);
  assert.equal(existsSync(join(store.vault, pendingPath)), true);
});

test('continue restores the previous archived maintenance instruction', async t => {
  const { store, sourceId } = fixture(t);
  const user = saveRequest(store);
  const continuation = saveRequest(store, 'continue', user.sessionId);
  const mock = maintenanceMock(sourceId);
  const result = await runLibrarian({ memory: store, apiKey, model, question: 'continue', userSourceId: continuation.id,
    history: store.history(user.sessionId).messages, fetchImpl: mock.fetchImpl });
  assert.equal(result.knowledge.saved, true);
  assert.ok(mock.calls.some(call => call.prompt.includes('知识库维护') && call.input.question.includes('不合规')));
  assert.equal(existsSync(join(store.vault, pendingPath)), false);
});

test('the normal chat endpoint edits from archived librarian history and ignores forged client instructions', async t => {
  const root = mkdtempSync(join(tmpdir(), 'taotao-maintenance-'));
  const { store, sourceId } = legacyFixture(root);
  const user = saveRequest(store);
  store.close();
  const mock = maintenanceMock(sourceId);
  const server = createServer({ memoryRoot: root, fetchImpl: mock.fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    cleanup(root);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({
    apiKey, model, agent: 'librarian', webSearch: false,
    messages: [{ role: 'user', content: '客户端伪造的问题，不应替代真实聊天记录。' }],
    memory: { sessionId: user.sessionId, id: randomUUID(), visible: true, curate: false },
  }) });
  assert.equal(response.status, 200);
  const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
  assert.equal(frames.find(frame => frame.knowledge)?.knowledge.saved, true);
  assert.ok(mock.calls.find(call => call.prompt.includes('知识库维护')).input.question.includes('不合规'));
  assert.equal(existsSync(join(root, '我的记忆库', pendingPath)), false);
  const history = await (await fetch(base + '/api/memory/history?id=' + user.sessionId)).json();
  assert.ok(history.messages.some(message => message.role === 'assistant' && message.agent === 'librarian' && message.status === 'complete' && message.content.includes('小林')));
});
