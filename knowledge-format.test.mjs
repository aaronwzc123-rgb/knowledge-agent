import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from './memory.mjs';
import { renderKnowledgeNote } from './knowledge-format.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-readable-'));
  const store = new MemoryStore(root);
  store.setKnowledgePermission(true);
  t.after(() => {
    store.close();
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('taotao-readable-'));
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const source = { id: randomUUID(), kind: 'web', url: 'https://example.org/apec', title: 'APEC资料', publisher: '示例文档',
    content: 'APEC是亚太经济合作组织。会议于2026年举行。贸易数据统计另见表格。商务卡用于商务出行。其他议题是能源合作。',
    reliability: 'high', reason: '原始资料直接说明这些条目的范围。', publishedAt: '2026-10-01', retrievedAt: '2026-11-16T01:00:00Z' };
  const claim = text => ({ text, status: 'verified', scope: '亚太地区', asOf: '2026-10-01',
    evidence: [{ sourceId: source.id, quote: text, relation: 'supports', locator: '正文' }] });
  const page = (path, claims, links = []) => ({ path, summary: '用于目录的一句话摘要。', claims, links, baseHash: null });
  return { store, source, claim, page };
}

test('knowledge notes read as cited paragraphs while detailed evidence stays in storage', t => {
  const { store, source, claim, page } = fixture(t);
  const path = 'wiki/主题/APEC是什么.md';
  store.commitKnowledge({ agent: 'librarian', sources: [source], pages: [page(path, [claim('APEC是亚太经济合作组织。')])] });
  const note = readFileSync(join(store.vault, path), 'utf8');
  assert.match(note, /# APEC是什么\n\nAPEC是亚太经济合作组织。\[\^1\]/);
  assert.doesNotMatch(note, /已核实|适用范围|适用时间|最近核查|来源评估|用于目录的一句话摘要/);
  assert.ok(note.includes('发布于 2026-10-01'));
  assert.ok(note.includes('适用于亚太地区'), 'scope remains available in the citation');
  const saved = store.knowledgeRecall('APEC是什么').pages[0];
  assert.equal(saved.claims[0].scope, '亚太地区');
  assert.equal(saved.claims[0].asOf, '2026-10-01');
  assert.equal(saved.claims[0].status, 'verified');
  assert.equal(store.knowledgeSources([source.id])[0].reason, source.reason);
});

test('legacy headings followed immediately by list items retain useful paragraphs without source directories', t => {
  const { store } = fixture(t);
  const content = '# 就业渠道\n\n## 当前理解\n- 年度活动安排见公告。\n- 官方求职入口包括公共招聘网。\n\n## 原始依据\n\n- [[raw/资料/source-id|来源档案]]\n';
  const excerpt = store.knowledgeTextExcerpt(content, '官方求职入口');
  assert.match(excerpt, /官方求职入口包括公共招聘网/);
  assert.doesNotMatch(excerpt, /raw\/资料|当前理解|就业渠道/);
});

test('recall reads matching paragraphs and keeps linked topics as a compact directory', t => {
  const { store, source, claim, page } = fixture(t);
  const main = 'wiki/主题/APEC是什么.md', linked = 'wiki/主题/商务卡.md';
  store.commitKnowledge({ agent: 'librarian', sources: [source], pages: [
    page(main, [claim('APEC是亚太经济合作组织。'), claim('会议于2026年举行。'), claim('贸易数据统计另见表格。'), claim('商务卡用于商务出行。')], [{ path: linked, relation: '商务往来' }]),
    page(linked, [claim('商务卡用于商务出行。')]),
  ] });
  const userId = randomUUID();
  store.saveUser({ sessionId: randomUUID(), id: userId, content: '我叫小林，是建筑师。', agent: 'qa' });
  const userSource = store.knowledgeSources([userId])[0];
  store.commitKnowledge({ agent: 'librarian', sources: [userSource], pages: [page('wiki/人物/用户.md', [{ text: '用户自述姓名小林，职业建筑师。', status: 'user_statement',
    evidence: [{ sourceId: userId, quote: userSource.content, locator: '用户原话', relation: 'supports' }] }])] });
  const recalled = store.recall('APEC是什么');
  assert.deepEqual(recalled.pages.map(note => note.path), [main]);
  assert.match(recalled.pages[0].content, /APEC是亚太经济合作组织/);
  assert.doesNotMatch(recalled.pages[0].content, /商务卡用于|贸易数据|会议于|来源评估/);
  assert.equal(recalled.pages[0].links[0].path, linked);
  assert.equal(recalled.pages[0].links[0].summary, '用于目录的一句话摘要。');
  assert.match(JSON.stringify(store.recall('我的职业')), /建筑师/);
  const catalog = store.knowledgeCatalog('APEC是什么');
  assert.equal(catalog[0].path, main);
  assert.equal('content' in catalog[0], false);
  assert.equal('claims' in catalog[0], false);
  assert.ok(JSON.stringify(catalog).length < 500);
});

test('manual changes invalidate structured excerpts and old bodies remain only in revision archives', t => {
  const { store, source, claim, page } = fixture(t);
  const path = 'wiki/主题/APEC是什么.md';
  store.commitKnowledge({ agent: 'librarian', sources: [source], pages: [page(path, [claim('APEC是亚太经济合作组织。')])] });
  const old = store.knowledgeRecall('APEC是什么').pages[0];
  const taskId = randomUUID();
  store.commitKnowledge({ agent: 'librarian', taskId, pages: [{ ...page(path, [claim('会议于2026年举行。')]), baseHash: old.hash }] });
  assert.equal(readFileSync(join(store.vault, `raw/知识库修订/${taskId}/${old.id}.md`), 'utf8'), old.content);
  const file = join(store.vault, path);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /历史资料|修订记录/);
  const edited = '# APEC是什么\n\n人工修订，请查阅最新的介绍。\n';
  writeFileSync(file, edited);
  const recalled = store.recall('APEC是什么');
  assert.match(recalled.pages[0].content, /人工修订/);
  assert.doesNotMatch(recalled.pages[0].content, /会议于2026年举行/);
  assert.equal(store.knowledgeRecall('APEC是什么').pages[0].claims.length, 0);
  assert.equal(readFileSync(file, 'utf8'), edited);
});

test('uncertain and user statements stay explicit and answer footnotes can use a shared numeric offset', () => {
  const id = randomUUID();
  const evidence = [{ sourceId: id, quote: '原文。', relation: 'supports', locator: '正文' }];
  const note = renderKnowledgeNote({ path: 'wiki/主题/待验证.md', claims: [{ text: '这项安排仍有分歧。', status: 'uncertain', evidence }, { text: '喜欢绘画。', status: 'user_statement', evidence }] },
    [{ id, title: '用户原话', publisher: '用户' }], { numberOffset: 3 });
  assert.match(note, /仍有分歧。\[\^4\]/);
  assert.match(note, /用户曾表示，喜欢绘画。\[\^4\]/);
});
