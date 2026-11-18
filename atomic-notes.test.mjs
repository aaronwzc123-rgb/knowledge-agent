import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from './memory.mjs';
import { runLibrarian } from './librarian.mjs';
import { renderKnowledgeNote } from './knowledge-format.mjs';

const apiKey = 'sk-atomic-note-fixture-only';
const model = 'deepseek-flash';
const definition = 'APEC（亚太经合组织）是亚太地区的经济合作机制。';
const meeting = '2026年APEC领导人非正式会议安排在深圳举行。';
const trade = '2026年贸易统计另见单独统计表。';
const policy = '商务旅行卡在华停留政策属于独立的出入境政策问题。';
const definitionPath = 'wiki/主题/APEC是什么.md';
const meetingPath = 'wiki/主题/2026年APEC会议安排.md';
const jobsPath = 'wiki/主题/公共就业服务.md';
const modelResponse = value => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-atomic-notes-'));
  const store = new MemoryStore(root);
  store.setKnowledgePermission(true);
  t.after(() => {
    store.close();
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('taotao-atomic-notes-'));
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  return store;
}

function source(content = `${definition}\n${meeting}\n${trade}\n${policy}`) {
  return {
    id: randomUUID(), kind: 'web', url: 'https://example.org/apec-original', title: 'APEC示例原始资料',
    publisher: '示例原始发布者', publishedAt: '2026-11-14', updatedAt: null,
    retrievedAt: new Date().toISOString(), content,
    reliability: 'high', reason: '此测试原始资料直接陈述下列事实及其适用条件。',
  };
}

function claim(evidence, text, extra = {}) {
  return { text, status: 'verified', scope: '', asOf: null,
    evidence: [{ sourceId: evidence.id, quote: text, locator: '原文段落', relation: 'supports' }], ...extra };
}

function note(path, evidence, texts, extra = {}) {
  return { path, baseHash: null, summary: texts[0], claims: texts.map(text => claim(evidence, text)), links: [], ...extra };
}

function seed(store, pages, evidence) {
  store.commitKnowledge({ agent: 'librarian', pages, sources: [evidence] });
  return store.knowledgeRecall('', { all: true }).pages;
}

test('a canonical concept question returns the stored note without any upstream request', async t => {
  const store = fixture(t);
  const evidence = source();
  seed(store, [note(definitionPath, evidence, [definition])], evidence);
  const result = await runLibrarian({ memory: store, apiKey, model, question: 'APEC是什么？',
    fetchImpl: async () => { assert.fail('an exact supported concept note needs neither a model call nor a web search'); } });
  assert.equal(result.knowledge.mode, 'local');
  assert.equal(result.knowledge.changed, false);
  assert.ok(result.text.includes(definition));
  assert.ok(result.text.includes('[^1]'));
  assert.ok(result.text.includes(evidence.url));
  assert.doesNotMatch(result.text, /已核实|适用范围|适用时间/);
});

test('a partial local answer returns the selected original paragraph and omits raw archives from coverage', async t => {
  const store = fixture(t);
  const rawTail = 'UNRELATED_SOURCE_ARCHIVE '.repeat(1200);
  const evidence = source(`${definition}\n${meeting}\n${trade}\n${policy}\n${rawTail}`);
  const combinedPath = 'wiki/主题/APEC与2026年APEC中国年.md';
  const pages = seed(store, [note(combinedPath, evidence, [definition, meeting, trade, policy])], evidence);
  const definitionClaim = pages.find(page => page.path === combinedPath).claims[0];
  let coverage;
  const result = await runLibrarian({ memory: store, apiKey, model, question: '亚太经合组织的定义是什么？',
    fetchImpl: async (url, options) => {
      assert.ok(String(url).endsWith('/chat/completions'), 'a supported paragraph should not start a web search');
      const body = JSON.parse(options.body);
      assert.ok(body.messages[0].content.includes('知识覆盖检查'));
      coverage = JSON.parse(body.messages.at(-1).content);
      return modelResponse({ answerable: true, needsRefresh: false, claimIds: [definitionClaim.id], gaps: [], queries: [] });
    } });
  assert.equal(result.knowledge.mode, 'local');
  assert.ok(result.text.includes(definition));
  assert.ok(!result.text.includes(meeting));
  assert.ok(!result.text.includes(trade));
  assert.ok(!result.text.includes(policy));
  assert.ok(Array.isArray(coverage.catalog), 'coverage starts with the lightweight Wiki index');
  assert.ok(coverage.pages.every(page => !Object.hasOwn(page, 'content')), 'coverage does not receive full Markdown pages');
  assert.ok(coverage.sources.every(item => !Object.hasOwn(item, 'content')), 'coverage receives source metadata and exact claim quotations, not full archives');
  assert.ok(!JSON.stringify(coverage).includes('UNRELATED_SOURCE_ARCHIVE'));
});

test('one research result creates separate readable notes and drops a rejected unrelated link', async t => {
  const store = fixture(t);
  const jobs = source('公共就业服务提供招聘信息。');
  jobs.url = 'https://example.org/jobs';
  seed(store, [note(jobsPath, jobs, [jobs.content])], jobs);
  const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (!body) return new Response(`<html><head><title>APEC示例原始资料</title><meta name="author" content="示例原始发布者"></head><body><main><p>${definition}</p><p>${meeting}</p></main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (String(url).endsWith('/search')) return Response.json({ results: [{ url: 'https://example.org/apec-original', title: 'APEC示例原始资料' }] });
    const prompt = body.messages[0].content;
    const input = JSON.parse(body.messages.at(-1).content);
    if (prompt.includes('知识覆盖检查')) return modelResponse({ answerable: false, claimIds: [], gaps: ['定义和会议安排'], queries: ['APEC 2026 原始资料'] });
    if (prompt.includes('知识证据整理')) {
      const evidence = input.sources.find(item => item.url === 'https://example.org/apec-original');
      assert.ok(evidence);
      return modelResponse({
        sourceAssessments: [{ id: evidence.id, reliability: 'high', reason: '原始发布者分别说明机制定义和当年会议地点。' }],
        pages: [
          note(definitionPath, evidence, [definition], { links: [{ path: meetingPath, relation: '当年的会议安排' }, { path: jobsPath, relation: '区域合作也可能影响就业' }] }),
          note(meetingPath, evidence, [meeting], { links: [{ path: definitionPath, relation: '会议所属机制' }] }),
        ], gaps: [],
      });
    }
    if (prompt.includes('证据支持审查')) return modelResponse({
      approved: [{ pagePath: definitionPath, claimIndex: 0 }, { pagePath: meetingPath, claimIndex: 0 }], rejected: [],
      rejectedLinks: [{ pagePath: definitionPath, targetPath: jobsPath, reason: '就业页与机制定义没有直接知识关系。' }],
    });
    assert.fail('unexpected research stage');
  };
  const result = await runLibrarian({ memory: store, apiKey, model, question: '请介绍亚太经合组织及2026年的会议安排。', fetchImpl, lookupImpl });
  assert.equal(result.knowledge.saved, true);
  assert.deepEqual(new Set(result.knowledge.pages.map(page => page.path)), new Set([definitionPath, meetingPath]));
  const definitionText = readFileSync(join(store.vault, definitionPath), 'utf8');
  const meetingText = readFileSync(join(store.vault, meetingPath), 'utf8');
  assert.ok(definitionText.includes(definition));
  assert.ok(!definitionText.includes(meeting));
  assert.ok(meetingText.includes(meeting));
  assert.ok(!meetingText.includes(definition));
  assert.doesNotMatch(definitionText, /已核实|适用范围|适用时间|公共就业服务/);
  assert.match(definitionText, /\[\^1\]:/);
  assert.match(definitionText, /\[\[wiki\/主题\/2026年APEC会议安排\]\]/);
});

test('numeric footnotes remain distinct when several reusable notes appear in one answer', () => {
  const first = source(definition), second = source(meeting);
  second.id = randomUUID(); second.url = 'https://example.org/apec-meeting';
  const text = renderKnowledgeNote(note(definitionPath, first, [definition]), [first], { headingLevel: 2, includeLinks: false })
    + renderKnowledgeNote(note(meetingPath, second, [meeting]), [second], { headingLevel: 2, includeLinks: false, numberOffset: 1 });
  assert.match(text, /\[\^1\]:.*apec-original/);
  assert.match(text, /\[\^2\]:.*apec-meeting/);
  assert.equal((text.match(/^\[\^1\]:/gm) || []).length, 1);
  assert.equal((text.match(/^\[\^2\]:/gm) || []).length, 1);
});

test('a page rejected for mixing independent questions is not published even when its individual facts are supported', async t => {
  const store = fixture(t);
  const mixedPath = 'wiki/主题/APEC定义与会议与旅行卡.md';
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (!body) return new Response(`<main><p>${definition}</p><p>${meeting}</p><p>${policy}</p></main>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (String(url).endsWith('/search')) return Response.json({ results: [{ url: 'https://example.org/apec-original' }] });
    const prompt = body.messages[0].content;
    const input = JSON.parse(body.messages.at(-1).content);
    if (prompt.includes('知识覆盖检查')) return modelResponse({ answerable: false, claimIds: [], gaps: ['所需主题'], queries: ['APEC原始资料'] });
    if (prompt.includes('知识证据整理')) {
      const evidence = input.sources.find(item => item.kind === 'web');
      return modelResponse({ sourceAssessments: [{ id: evidence.id, reliability: 'high', reason: '测试原始资料提供了三条直接陈述。' }],
        pages: [note(mixedPath, evidence, [definition, meeting, policy])], gaps: [] });
    }
    if (prompt.includes('证据支持审查')) return modelResponse({
      approved: [0, 1, 2].map(claimIndex => ({ pagePath: mixedPath, claimIndex })), rejected: [],
      rejectedPages: [{ path: mixedPath, reason: '机制定义、会议安排和旅行卡政策是三个独立问题，应分别整理。' }],
    });
    assert.fail('unexpected research stage');
  };
  const result = await runLibrarian({ memory: store, apiKey, model, question: '介绍APEC及相关安排。', fetchImpl,
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.equal(result.knowledge.saved, false);
  assert.ok(!store.knowledgeStatus().pages.some(page => page.path === mixedPath));
});
