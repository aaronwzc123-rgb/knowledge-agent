import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from './memory.mjs';
import { claimPolicyError } from './knowledge-policy.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-policy-storage-'));
  let store = new MemoryStore(root); store.setKnowledgePermission(true);
  t.after(() => { store.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); });
  return { get store() { return store; }, restart() { store.close(); store = new MemoryStore(root); },
    user(content) { const id = randomUUID(); store.saveUser({ sessionId: randomUUID(), id, content }); return store.knowledgeSources([id])[0]; } };
}
const web = () => ({ id: randomUUID(), kind: 'web', title: '机器学习教材', publisher: '教学机构', url: 'https://example.org/course',
  retrievedAt: new Date().toISOString(), content: '监督学习使用带有目标标签的训练样本学习输入到输出的映射。', reliability: 'medium', reason: '课程教材正文清楚定义概念并说明训练过程。' });
const doc = () => { const resourceId = randomUUID(); return { id: randomUUID(), kind: 'document', title: '本人简历.pdf', publisher: '用户资料',
  url: `http://127.0.0.1:8765/?resource=${resourceId}&version=1&locator=${encodeURIComponent('第1页')}`,
  retrievedAt: new Date().toISOString(), content: '修过机器学习课程，参与课程项目。', reliability: 'document_statement', reason: '本地原文定位。',
  document: { resourceId, version: 1, sha256: 'a'.repeat(64), chunkId: randomUUID(), locator: '第1页', page: 1 } }; };
const claim = (source, extra = {}) => ({ text: '监督学习从有标签的样本中学习预测关系。', status: 'reviewed', kind: 'knowledge', attribution: '课程教材',
  reviewState: 'accepted', basis: 'explanation', scope: '', asOf: null,
  evidence: [{ sourceId: source.id, quote: source.content, locator: source.document?.locator || '课程正文', relation: 'supports' }], ...extra });
function save(store, sources, c, path = 'wiki/主题/监督学习是什么.md') {
  return store.commitKnowledge({ agent: 'librarian', sources, pages: [{ path, summary: c.text.slice(0, 100), baseHash: null, claims: [c], links: [] }] });
}

test('knowledge explanations retain their type, attribution and citations through recall and restart', t => {
  const f = fixture(t), source = web(); save(f.store, [source], claim(source));
  const before = readFileSync(join(f.store.vault, 'wiki/主题/监督学习是什么.md'), 'utf8');
  assert.match(before, /collections: \["知识与方法"\]/); assert.doesNotMatch(before, /尚未证实/);
  f.restart();
  const p = f.store.knowledgeRecall('监督学习是什么').pages[0];
  assert.equal(p.claims[0].kind, 'knowledge'); assert.equal(p.claims[0].basis, 'explanation');
  assert.equal(p.claims[0].attribution, '课程教材'); assert.deepEqual(p.collections, ['知识与方法']);
  assert.equal(f.store.recall('监督学习').pages[0].claims[0].kind, 'knowledge');
  assert.equal(readFileSync(join(f.store.vault, p.path), 'utf8'), before, 'restart never rewrites existing notes');
});

test('owned résumé is accepted into personal notes and ownership cannot be borrowed for another document', t => {
  const f = fixture(t), source = doc();
  const owner = f.user(`这是我的简历，请收录学习经历。 ${source.url}`);
  const c = claim(source, { text: '用户修过机器学习课程，并参与课程项目。', kind: 'personal', attribution: '用户', basis: 'attributed', ownershipSourceId: owner.id });
  save(f.store, [source, owner], c, 'wiki/人物/我学过哪些课程.md');
  const p = f.store.knowledgeRecall('我学过哪些课程').pages[0];
  assert.equal(p.claims[0].ownershipSourceId, owner.id); assert.equal(p.claims[0].evidence[0].sourceId, source.id);
  assert.doesNotMatch(p.content, /尚未证实/);
  const other = doc();
  assert.match(claimPolicyError(claim(other, { ...c, evidence: claim(other).evidence }), new Map([[other.id, other], [owner.id, owner]])), /本人文档/);
  f.store.db.prepare('UPDATE sources SET suppressed=1 WHERE id=?').run(owner.id);
  assert.equal(f.store.knowledgeRecall('我学过哪些课程').pages[0].claims.length, 0, 'forgotten ownership cannot remain usable');
});

test('opinions and hypotheses remain attributable reusable records rather than failed facts', t => {
  const f = fixture(t), source = f.user('我在小项目里觉得简单工具更顺手，因为配置少。');
  const c = claim(source, { text: '小项目里简单工具更顺手，因为配置少。', kind: 'opinion', attribution: '用户', basis: 'attributed' });
  save(f.store, [source], c, 'wiki/决策/小项目的工具偏好.md');
  const p = f.store.knowledgeRecall('小项目工具').pages[0];
  assert.match(p.content, /用户认为/); assert.doesNotMatch(p.content, /尚未证实/);
  assert.equal(p.claims[0].reviewState, 'accepted'); assert.deepEqual(p.collections, ['观点与经验']);
  assert.match(claimPolicyError({ ...c, kind: 'analysis', basis: 'derivation', attribution: '用户' }, new Map([[source.id, source]])), /前提|分析/);
});

test('local report statements and evaluated originals remain separate from independent web verification', t => {
  const f = fixture(t), source = doc();
  const c = claim(source, { text: '文件记录修过机器学习课程。', kind: 'fact', attribution: '该文件', basis: 'attributed' });
  save(f.store, [source], c);
  const sources = new Map([[source.id, source]]);
  assert.match(claimPolicyError({ ...c, status: 'verified', kind: 'fact' }, sources), /网页证据/);
  assert.match(claimPolicyError({ ...c, basis: 'direct' }, sources), /公共事实/);
  assert.equal(claimPolicyError({ ...c, basis: 'direct', sourceAssessment: { sourceId: source.id, reliability: 'primary', reason: '确认其为原始签发机构发布的文件，并核对文内署名和出处。' } }, sources), null);
});

test('typed policy does not bypass literal quote checks, personal ownership, or write permission', t => {
  const f = fixture(t), source = doc(), sources = new Map([[source.id, source]]);
  assert.match(claimPolicyError(claim(source, { kind: 'personal', attribution: '用户', basis: 'attributed' }), sources), /本人文档/);
  const c = claim(source); c.evidence[0].quote = '这是伪造的不存在的引文';
  assert.match(claimPolicyError(c, sources), /引用原文/);
  f.store.setKnowledgePermission(false);
  assert.throws(() => save(f.store, [source], claim(source)), /授权/);
});

test('malformed model classification metadata returns a validation error instead of throwing', () => {
  const source = web(), sources = new Map([[source.id, source]]);
  for (const kind of [null, [], { toString: null }, { toString: {} }, true, 42]) {
    assert.match(claimPolicyError(claim(source, { kind }), sources), /分类|类型/);
  }
  assert.match(claimPolicyError(null, sources), /状态/);
});

test('deleting an Obsidian note cannot inject shared suppressed claims through prose, summaries or links', t => {
  const f = fixture(t), secretText = '用户学过仅限旧档案的秘密课程甲。', safeText = '用户计划复习公开课程乙。';
  const source = f.user(secretText), safe = f.user(safeText);
  const privateClaim = claim(source, { kind: 'personal', attribution: '用户', basis: 'attributed', text: secretText });
  const safeClaim = claim(safe, { kind: 'personal', attribution: '用户', basis: 'attributed', text: safeText });
  const firstPath = 'wiki/人物/旧课程记录.md', mixedPath = 'wiki/人物/课程计划.md', emptyPath = 'wiki/人物/课程档案.md';
  f.store.commitKnowledge({ agent: 'librarian', sources: [source, safe], pages: [
    { path: firstPath, baseHash: null, summary: secretText, claims: [privateClaim], links: [] },
    { path: mixedPath, baseHash: null, summary: secretText, claims: [privateClaim, safeClaim], links: [] },
    { path: emptyPath, baseHash: null, summary: secretText, claims: [privateClaim], links: [] },
    { path: 'wiki/主题/课程索引.md', baseHash: null, summary: safeText, claims: [safeClaim], links: [{ path: mixedPath, relation: '课程计划' }] },
  ] });
  unlinkSync(join(f.store.vault, firstPath));
  f.store.syncWiki();
  const recalled = f.store.knowledgeRecall('课程', { all: true });
  const mixed = recalled.pages.find(page => page.path === mixedPath);
  assert.equal(mixed.claims.length, 1); assert.ok(mixed.content.includes(safeText));
  assert.equal(recalled.pages.find(page => page.path === emptyPath).content, '');
  assert.ok(!JSON.stringify(recalled).includes(secretText));
  assert.ok(!JSON.stringify(f.store.knowledgeCatalog('课程')).includes(secretText));
  assert.ok(!JSON.stringify(f.store.recall('课程')).includes(secretText), 'ordinary agent context and linked summaries cannot resurrect suppressed claims');
  f.store.navigation();
  assert.ok(!readFileSync(join(f.store.vault, 'wiki/index.md'), 'utf8').includes(secretText));
  const manual = '# 手写课程\n\n这是用户独立手写的课程笔记，保持可读。\n';
  writeFileSync(join(f.store.vault, 'wiki/主题/手写课程.md'), manual);
  assert.ok(f.store.recall('手写课程').pages.some(page => page.content.includes('用户独立手写的课程笔记')));
});
