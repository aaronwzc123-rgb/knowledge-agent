import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { MemoryStore } from './memory.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-maintenance-'));
  const store = new MemoryStore(root);
  store.setKnowledgePermission(true);
  t.after(() => {
    store.close();
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('taotao-maintenance-'));
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const sourceId = randomUUID();
  store.saveUser({ sessionId: randomUUID(), id: sourceId, content: '请记住，我叫小林。我喜欢绘画。', agent: 'librarian' });
  const source = store.knowledgeSources([sourceId])[0];
  const claim = text => ({ text, status: 'user_statement', scope: '用户本人陈述', asOf: null,
    evidence: [{ sourceId, quote: source.content, locator: '用户原话', relation: 'supports' }] });
  const page = (path, claims, baseHash = null) => ({ path, claims, baseHash, summary: claims.map(item => item.text).join('；'), links: [] });
  return { root, store, source, claim, page };
}

function seedLegacy(store, path, content, sourceIds = []) {
  const id = randomUUID();
  store.atomic(path, content);
  store.db.prepare('INSERT INTO pages VALUES(?,?,?,?,?,0,0,?)').run(id, path, content,
    createHash('sha256').update(content).digest('hex'), JSON.stringify(sourceIds), new Date().toISOString());
  return id;
}

test('maintenance sees pending legacy pages and retrieves only their real user sources', t => {
  const { store, source } = fixture(t);
  seedLegacy(store, 'wiki/待确认/旧资料.md', '# 旧资料\n\n待核查。', [source.id]);
  const all = store.knowledgeRecall('完全无关', { all: true }).pages;
  assert.equal(all.length, 1);
  assert.equal(store.knowledgeRecall('完全无关').pages.length, 0);
  assert.deepEqual(store.knowledgeMaintenanceSources(all).map(item => item.id), [source.id]);
  assert.deepEqual(store.knowledgeMaintenanceSources([{ ...all[0], id: randomUUID() }]), []);
});

test('maintenance replaces claims and legacy text while preserving previous full versions', t => {
  const { store, source, claim, page } = fixture(t);
  const path = 'wiki/人物/用户.md';
  const legacy = '# 用户\n\n未经核实的学历猜测。';
  const id = seedLegacy(store, path, legacy, [source.id]);
  let note = store.knowledgeRecall('', { all: true }).pages[0];
  store.commitKnowledge({ agent: 'librarian', pages: [page(path, [claim('用户自述姓名小林。'), claim('用户自述喜欢绘画。')], note.hash)], sources: [source] });
  note = store.knowledgeRecall('', { all: true }).pages[0];
  const oldVersion = note.content;
  const result = store.commitKnowledge({ agent: 'librarian', pages: [page(path, [claim('用户自述姓名小林。')], note.hash)],
    replaceExisting: true, taskId: randomUUID() });
  assert.equal(result.changed, 1);
  note = store.knowledgeRecall('', { all: true }).pages[0];
  assert.equal(note.claims.length, 1);
  assert.ok(!note.content.includes('未经核实的学历猜测'));
  assert.ok(!note.content.includes('用户自述喜欢绘画'));
  assert.equal(store.db.prepare('SELECT legacy FROM knowledge_pages WHERE page_id=?').get(id).legacy, '');
  assert.ok(store.db.prepare('SELECT content FROM revisions WHERE page_id=?').all(id).some(row => row.content === oldVersion));
});

test('archiving requires explicit authority and preserves shared evidence and audit history', t => {
  const { store, source, claim, page } = fixture(t);
  const first = 'wiki/人物/用户.md', second = 'wiki/偏好/绘画.md';
  store.commitKnowledge({ agent: 'librarian', sources: [source], pages: [page(first, [claim('用户自述姓名小林。')]), page(second, [claim('用户自述喜欢绘画。')])] });
  const note = store.knowledgeRecall('', { all: true }).pages.find(item => item.path === first);
  const archivePages = [{ path: first, baseHash: note.hash, reason: '用户要求移除重复资料。' }];
  assert.throws(() => store.commitKnowledge({ agent: 'librarian', pages: [], archivePages }), /授权/);
  assert.throws(() => store.commitKnowledge({ agent: 'qa', pages: [], archivePages, allowArchive: true }), /管理员/);
  store.setKnowledgePermission(false);
  assert.throws(() => store.commitKnowledge({ agent: 'librarian', pages: [], archivePages, allowArchive: true }), /授权/);
  store.setKnowledgePermission(true);
  const result = store.commitKnowledge({ agent: 'librarian', pages: [], archivePages, allowArchive: true, taskId: randomUUID() });
  assert.equal(result.changed, 1);
  assert.equal(result.archived[0].path, first);
  assert.ok(!existsSync(store.path(first)));
  assert.equal(readFileSync(store.path(result.archived[0].revision), 'utf8'), note.content);
  assert.ok(existsSync(store.path(second)));
  assert.equal(store.db.prepare('SELECT suppressed FROM sources WHERE id=?').get(source.id).suppressed, 0);
  assert.ok(store.knowledgeSources([source.id]).length);
  assert.ok(store.db.prepare('SELECT content FROM revisions WHERE page_id=?').all(note.id).some(row => row.content === note.content));
  assert.equal(store.db.prepare('SELECT content FROM pages WHERE id=?').get(note.id).content, note.content);
  assert.equal(store.knowledgeRecall('', { all: true }).pages.length, 1);
});

test('stale or manually edited archive targets are preserved', t => {
  const { store, source, claim, page } = fixture(t);
  const path = 'wiki/人物/用户.md';
  store.commitKnowledge({ agent: 'librarian', sources: [source], pages: [page(path, [claim('用户自述姓名小林。')])] });
  const note = store.knowledgeRecall('', { all: true }).pages[0];
  assert.throws(() => store.commitKnowledge({ agent: 'librarian', pages: [], allowArchive: true,
    archivePages: [{ path, baseHash: 'stale', reason: '清理旧资料。' }] }), /修改/);
  const manual = note.content + '\n用户手写内容。';
  writeFileSync(store.path(path), manual);
  assert.throws(() => store.commitKnowledge({ agent: 'librarian', pages: [], allowArchive: true,
    archivePages: [{ path, baseHash: note.hash, reason: '清理旧资料。' }] }), /人工|修改/);
  assert.equal(readFileSync(store.path(path), 'utf8'), manual);
});

test('a failed mixed maintenance commit restores edits, archives and index together', t => {
  const { store, source, claim, page } = fixture(t);
  const first = 'wiki/人物/用户.md', second = 'wiki/偏好/绘画.md';
  store.commitKnowledge({ agent: 'librarian', sources: [source], pages: [page(first, [claim('用户自述姓名小林。')]), page(second, [claim('用户自述喜欢绘画。')])] });
  const notes = store.knowledgeRecall('', { all: true }).pages;
  const one = notes.find(note => note.path === first), two = notes.find(note => note.path === second);
  const indexBefore = readFileSync(store.path('wiki/index.md'), 'utf8');
  const revisionCount = store.db.prepare('SELECT COUNT(*) n FROM revisions').get().n;
  const originalNavigation = store.navigation.bind(store);
  store.navigation = () => { originalNavigation(); throw new Error('fixture write failure'); };
  assert.throws(() => store.commitKnowledge({ agent: 'librarian', replaceExisting: true,
    pages: [page(first, [claim('用户自述姓名为小林。')], one.hash)],
    archivePages: [{ path: second, baseHash: two.hash, reason: '移除重复资料。' }], allowArchive: true, taskId: randomUUID() }), /fixture write failure/);
  store.navigation = originalNavigation;
  assert.equal(readFileSync(store.path(first), 'utf8'), one.content);
  assert.equal(readFileSync(store.path(second), 'utf8'), two.content);
  assert.equal(readFileSync(store.path('wiki/index.md'), 'utf8'), indexBefore);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM revisions').get().n, revisionCount);
  assert.equal(store.knowledgeRecall('', { all: true }).pages.length, 2);
});
