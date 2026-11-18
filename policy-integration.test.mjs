import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { MemoryStore } from './memory.mjs';
import { runLibrarian } from './librarian.mjs';

const response = value => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
const teachingQuote = '监督学习使用带有目标标签的训练样本，学习从输入到输出的映射，并在未见样本上评估泛化表现。';
const teachingURL = 'https://example.org/course/supervised-learning';
const evidence = (source, quote = source.content) => [{ sourceId: source.id, quote,
  locator: source.document?.locator || (source.kind === 'user' ? '用户原话' : '课程正文'), relation: 'supports' }];
const typedClaim = (kind, text, source, options = {}) => ({ text, kind, status: 'reviewed',
  attribution: kind === 'knowledge' ? '示例大学课程' : '用户', basis: kind === 'knowledge' ? 'explanation' : 'attributed',
  reviewState: 'accepted', scope: '', asOf: null, evidence: evidence(source), ...options });
const page = (path, claims) => ({ path, summary: claims[0].text.slice(0, 80), claims, links: [] });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-policy-integration-'));
  const store = new MemoryStore(root);
  store.setKnowledgePermission(true);
  t.after(() => {
    store.close();
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('taotao-policy-integration-'));
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const remember = content => {
    const sessionId = randomUUID(), id = randomUUID();
    store.saveUser({ sessionId, id, content, agent: 'librarian' });
    return { sessionId, id, source: store.knowledgeSources([id])[0] };
  };
  return { root, store, remember };
}

function modelMock({ coverage = {}, write, review, documentWrite, repair } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    url = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    if (!body) {
      assert.equal(url, teachingURL);
      return new Response(`<html><head><title>监督学习课程</title><meta name="author" content="示例大学"></head><body><main><p>${teachingQuote}</p><p>基础课程讨论训练数据与模型评价的关系，并说明训练误差不能代替泛化评价。</p></main></body></html>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.endsWith('/search')) return Response.json({ results: [{ url: teachingURL, title: '监督学习课程' }] });
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const prompt = body.messages[0].content, input = JSON.parse(body.messages.at(-1).content);
    if (prompt.startsWith('知识覆盖检查')) return response({ answerable: false, needsRefresh: false,
      userStatementOnly: false, claimIds: [], queries: [], gaps: [], ...coverage });
    if (prompt.startsWith('知识证据整理')) {
      const result = write(input);
      return response({ gaps: [], sourceAssessments: input.sources.filter(source => source.kind === 'web')
        .map(source => ({ id: source.id, reliability: 'high', reason: '大学基础课程直接解释监督学习的定义、训练目标与评价边界。' })), ...result });
    }
    if (prompt.startsWith('本地资料收录')) return response(documentWrite(input));
    if (prompt.startsWith('证据支持审查')) return response(review ? review(input) : {
      approved: input.pages.flatMap(p => p.claims.map((_claim, claimIndex) => ({ pagePath: p.path, claimIndex }))), rejected: [],
    });
    if (prompt.startsWith('知识修正')) return response(repair ? repair(input) : { pages: [], gaps: [] });
    throw new Error('Unexpected policy workflow: ' + prompt.slice(0, 70));
  };
  return { fetchImpl, calls };
}

const run = (store, mock, question, extra = {}) => runLibrarian({ memory: store, apiKey: 'sk-policy-fixture-only',
  model: 'policy-fixture-model', question, fetchImpl: mock.fetchImpl, lookupImpl, ...extra });
const noSearch = mock => assert.ok(mock.calls.every(call => call.url.endsWith('/chat/completions')),
  'private experiences and local documents must not trigger a public search');

test('a teaching source supports a paraphrased concept note and typed local reuse', async t => {
  const { store } = fixture(t), path = 'wiki/主题/监督学习是什么.md';
  const mock = modelMock({ coverage: { queries: ['监督学习 定义 大学课程'] }, write: input => {
    const source = input.sources.find(s => s.kind === 'web');
    return { pages: [page(path, [typedClaim('knowledge', '监督学习通过已有标签的例子学习预测规则；模型是否有用，还需要看它面对新样本时的表现。', source,
      { evidence: evidence(source, teachingQuote) })])] };
  } });
  const result = await run(store, mock, '请收录监督学习的基本原理');
  assert.equal(result.knowledge.saved, true, JSON.stringify(result));
  const stored = store.knowledgeRecall('监督学习').pages.find(p => p.path === path);
  assert.equal(stored.claims[0].kind, 'knowledge');
  assert.equal(stored.claims[0].basis, 'explanation');
  assert.notEqual(stored.claims[0].text, teachingQuote);
  assert.match(result.text, /example\.org\/course/);
  assert.doesNotMatch(result.text, /尚未证实/);
  const reuse = modelMock({ coverage: { answerable: true, claimIds: [stored.claims[0].id] },
    write: () => { throw new Error('a reusable note must not be rewritten'); } });
  const recalled = await run(store, reuse, '监督学习如何训练和评估？');
  assert.equal(recalled.knowledge.mode, 'local');
  assert.ok(recalled.text.includes(stored.claims[0].text));
  noSearch(reuse);
});

test('我学过 is saved from the archived user statement without requiring whole-task classification', async t => {
  const { store, remember } = fixture(t);
  const question = '请记住，我学过机器学习和概率论。';
  const user = remember(question), path = 'wiki/人物/用户修过的课程.md';
  const mock = modelMock({ write: input => {
    const source = input.sources.find(s => s.id === user.id);
    assert.ok(source, 'the real archived self-report is available to the writer');
    return { pages: [page(path, [typedClaim('personal', '用户学过机器学习和概率论。', source)])] };
  } });
  const result = await run(store, mock, question, { userSourceId: user.id });
  assert.equal(result.knowledge.saved, true, JSON.stringify(result));
  assert.equal(store.knowledgeRecall('课程').pages.find(p => p.path === path).claims[0].kind, 'personal');
  noSearch(mock);
});

test('mixed requests preserve personal courses while researching only the public concept', async t => {
  const { store, remember } = fixture(t);
  const question = '请记住我学过机器学习，并收录监督学习的基本原理。';
  const user = remember(question);
  const mock = modelMock({ coverage: { userStatementOnly: false, queries: ['监督学习 定义 大学课程'] }, write: input => {
    const personal = input.sources.find(s => s.id === user.id), teaching = input.sources.find(s => s.kind === 'web');
    assert.ok(personal && teaching, 'mixed tasks retain both archived self-report and teaching sources');
    return { pages: [page('wiki/人物/用户学习经历.md', [typedClaim('personal', '用户学过机器学习。', personal)]),
      page('wiki/主题/监督学习的原理.md', [typedClaim('knowledge', '监督学习利用带标签的样本学习输入与输出的关系，并检查对新样本的泛化能力。', teaching,
        { evidence: evidence(teaching, teachingQuote) })])] };
  } });
  const result = await run(store, mock, question, { userSourceId: user.id });
  assert.equal(result.knowledge.saved, true, JSON.stringify(result));
  assert.equal(result.knowledge.pages.length, 2);
  for (const call of mock.calls.filter(c => c.url.endsWith('/search'))) {
    assert.doesNotMatch(call.body.query, /我学过|请记住/);
  }
});

test('an external coverage gap is still researched when the question also mentions a profession', async t => {
  const { store, remember } = fixture(t);
  const question = '我是一名程序员，请收录监督学习能不能不用标签。';
  const user = remember(question);
  const mock = modelMock({ coverage: { queries: ['监督学习 是否需要标签 大学课程'] }, write: input => {
    const source = input.sources.find(s => s.kind === 'web');
    assert.ok(source, 'an external coverage query cannot be discarded merely because the user mentioned a profession');
    return { pages: [page('wiki/主题/监督学习是否需要标签.md', [typedClaim('knowledge', '监督学习使用带有目标标签的训练样本。', source,
      { evidence: evidence(source, teachingQuote) })])] };
  } });
  const result = await run(store, mock, question, { userSourceId: user.id });
  assert.equal(result.knowledge.saved, true, JSON.stringify(result));
  assert.ok(mock.calls.some(call => call.url.endsWith('/search')));
});

test('an earlier personal statement does not make the current public question a private-only task', async t => {
  const { store, remember } = fixture(t);
  const earlier = remember('请记住，我学过机器学习课程。');
  const question = '请收录监督学习是否需要标签。';
  const current = remember(question);
  const mock = modelMock({ coverage: { queries: ['监督学习 是否需要标签 大学课程'] }, write: input => {
    const source = input.sources.find(s => s.kind === 'web');
    assert.ok(source, 'a previous personal turn must not suppress an actual external coverage gap');
    return { pages: [page('wiki/主题/监督学习的标签要求.md', [typedClaim('knowledge', '监督学习的训练样本包含目标标签。', source,
      { evidence: evidence(source, teachingQuote) })])] };
  } });
  const result = await run(store, mock, question, { userSourceId: current.id,
    history: [{ role: 'user', id: earlier.id, agent: 'librarian', content: earlier.source.content }] });
  assert.equal(result.knowledge.saved, true, JSON.stringify(result));
  assert.ok(mock.calls.some(call => call.url.endsWith('/search')));
});

test('opinions, experiences and hypotheses retain attribution and remain reusable records', async t => {
  const { store, remember } = fixture(t);
  const question = '请记住：我觉得蓝色界面更舒服；我上次用番茄钟复习时更专注；我预测自己下个月会更喜欢早晨学习。';
  const user = remember(question);
  const entries = [
    ['opinion', 'wiki/偏好/用户的界面颜色评价.md', '用户觉得蓝色界面更舒服。'],
    ['experience', 'wiki/主题/用户使用番茄钟的经历.md', '用户上次用番茄钟复习时感觉更专注，这是一段个人经历。'],
    ['hypothesis', 'wiki/决策/用户对学习时间的预测.md', '用户预测自己下个月会更喜欢早晨学习；这项预测尚待后续体验检验。'],
  ];
  const mock = modelMock({ write: input => {
    const source = input.sources.find(s => s.id === user.id);
    return { pages: entries.map(([kind, path, text]) => page(path, [typedClaim(kind, text, source)])) };
  } });
  const result = await run(store, mock, question, { userSourceId: user.id });
  assert.equal(result.knowledge.saved, true, JSON.stringify(result));
  assert.equal(result.knowledge.pages.length, 3);
  assert.doesNotMatch(result.text, /尚未证实/);
  noSearch(mock);
  const opinion = store.knowledgeRecall('界面颜色').pages.find(p => p.path === entries[0][1]);
  assert.equal(opinion.claims[0].attribution, '用户');
  const reuse = modelMock({ coverage: { answerable: true, claimIds: [opinion.claims[0].id] },
    write: () => { throw new Error('an attributed opinion must be reused as an opinion'); } });
  const recalled = await run(store, reuse, '我对界面颜色有什么偏好？');
  assert.equal(recalled.knowledge.mode, 'local');
  assert.match(recalled.text, /用户觉得蓝色/);
  noSearch(reuse);
});

function localDocument() {
  const resourceId = randomUUID(), id = randomUUID(), locator = '第1页';
  return { id, kind: 'document', title: '课程与项目简历.pdf', publisher: '本地资料',
    content: '教育经历：已修课程包括机器学习、概率论。项目经历：参与校园课程推荐项目。',
    publishedAt: null, updatedAt: null, retrievedAt: new Date().toISOString(),
    reliability: 'document_statement', reason: '保留本地原件的文字记录及准确位置。',
    url: `http://127.0.0.1:8765/?resource=${resourceId}&version=1&locator=${encodeURIComponent(locator)}#page=1`,
    document: { resourceId, version: 1, sha256: 'a'.repeat(64), locator, page: 1,
      chunkId: randomUUID(), extractorVersion: 2, parser: 'fixture-extractor' } };
}

for (const owned of [true, false]) test(owned ? 'an explicitly owned résumé enters personal notes with original file citations'
  : 'a third-party résumé cannot be promoted to the user identity by the writer', async t => {
  const { store, remember } = fixture(t);
  const source = localDocument(), path = 'wiki/人物/用户的课程经历.md';
  const question = (owned ? '这是我的简历，请摘要后收录。' : '这是同事的简历，请摘要后收录。')
    + ` [课程与项目简历.pdf](<${source.url}>)`;
  const user = remember(question);
  const mock = modelMock({ documentWrite: input => {
    const actual = input.sources.find(s => s.id === source.id);
    return { pages: [page(path, [typedClaim('personal', '用户修过机器学习和概率论课程，并参与校园课程推荐项目。', actual,
      { ownershipSourceId: user.id })])], gaps: [] };
  } });
  const result = await run(store, mock, question, { userSourceId: user.id,
    submission: { review_session: randomUUID(), sourceId: user.id }, documentDraft: { question, sources: [source],
      paragraphs: [{ text: '简历列出已修课程与参与项目。', evidence: [{ sourceId: source.id, quote: source.content }] }], files: [] } });
  assert.equal(result.knowledge.saved, owned, JSON.stringify(result));
  if (owned) {
    const stored = store.knowledgeRecall('课程').pages.find(p => p.path === path);
    assert.equal(stored.claims[0].kind, 'personal');
    assert.equal(stored.claims[0].ownershipSourceId, user.id);
    const note = readFileSync(join(store.vault, path), 'utf8');
    assert.match(note, /课程与项目简历\.pdf/);
    assert.match(note, /version=1/);
    assert.match(note, /第1页/);
    assert.doesNotMatch(note, /尚未证实/);
  } else assert.equal(store.status().pages.some(p => p.path === path), false);
  noSearch(mock);
});

test('a local course document can support knowledge rather than an unverified public assertion', async t => {
  const { store, remember } = fixture(t), source = localDocument();
  source.title = '监督学习课程讲义.pdf';
  source.content = teachingQuote;
  const question = `请收录这份课程讲义的监督学习概念。 [课程讲义](<${source.url}>)`;
  const user = remember(question), path = 'wiki/主题/监督学习的定义.md';
  const mock = modelMock({ documentWrite: input => {
    const actual = input.sources.find(s => s.id === source.id);
    return { pages: [page(path, [typedClaim('knowledge', '监督学习从带有答案标签的例子中学习预测关系；泛化评估关注没有参与训练的新样本。', actual)])], gaps: [] };
  } });
  const result = await run(store, mock, question, { userSourceId: user.id,
    submission: { sourceId: user.id, review_session: randomUUID() }, documentDraft: { question, sources: [source],
      paragraphs: [{ text: '讲义介绍监督学习的定义与泛化评估。', evidence: [{ sourceId: source.id, quote: source.content }] }], files: [] } });
  assert.equal(result.knowledge.saved, true, JSON.stringify(result));
  assert.equal(store.knowledgeRecall('监督学习').pages.find(p => p.path === path).claims[0].kind, 'knowledge');
  assert.doesNotMatch(result.text, /尚未证实/);
  noSearch(mock);
});

test('partial intake keeps qualified content and reports a specific rejection after one repair attempt', async t => {
  const { store, remember } = fixture(t);
  const question = '请记住，我学过机器学习课程。';
  const user = remember(question), path = 'wiki/人物/用户的机器学习课程.md';
  const reason = '原文只说学过课程，不能据此写成精通机器学习。';
  const mock = modelMock({ write: input => {
    const source = input.sources.find(s => s.id === user.id);
    return { pages: [page(path, [typedClaim('personal', '用户学过机器学习课程。', source),
      typedClaim('personal', '用户精通机器学习。', source)])] };
  }, review: () => ({ approved: [{ pagePath: path, claimIndex: 0 }], rejected: [{ pagePath: path, claimIndex: 1, reason }] }) });
  const result = await run(store, mock, question, { userSourceId: user.id });
  assert.equal(result.knowledge.saved, true, JSON.stringify(result));
  assert.match(result.text, /原文只说学过课程/);
  const stored = store.knowledgeRecall('课程').pages.find(p => p.path === path);
  assert.deepEqual(stored.claims.map(c => c.text), ['用户学过机器学习课程。']);
  assert.equal(mock.calls.filter(call => call.body?.messages?.[0].content.startsWith('知识修正')).length, 1,
    'a rejected item gets one targeted repair attempt');
  noSearch(mock);
});

test('a failed repair request does not discard already approved personal knowledge', async t => {
  const { store, remember } = fixture(t);
  const question = '请记住，我学过机器学习课程。';
  const user = remember(question), path = 'wiki/人物/用户的学习记录.md';
  const mock = modelMock({ write: input => {
    const source = input.sources.find(s => s.id === user.id);
    return { pages: [page(path, [typedClaim('personal', '用户学过机器学习课程。', source),
      typedClaim('personal', '用户精通机器学习。', source)])] };
  }, review: () => ({ approved: [{ pagePath: path, claimIndex: 0 }], rejected: [{ pagePath: path, claimIndex: 1,
    reason: '课程经历不能直接证明精通程度。' }] }), repair: () => { throw new Error('fixture repair connection failed'); } });
  const result = await run(store, mock, question, { userSourceId: user.id });
  assert.equal(result.knowledge.saved, true, JSON.stringify(result));
  assert.match(result.text, /课程经历不能直接证明/);
  assert.deepEqual(store.knowledgeRecall('学习记录').pages.find(p => p.path === path).claims.map(c => c.text), ['用户学过机器学习课程。']);
  noSearch(mock);
});

test('cancellation during a repair prevents even the approved partial result from being saved', async t => {
  const { store, remember } = fixture(t);
  const question = '请记住，我学过机器学习课程。';
  const user = remember(question), path = 'wiki/人物/取消中的学习记录.md', controller = new AbortController();
  const mock = modelMock({ write: input => {
    const source = input.sources.find(s => s.id === user.id);
    return { pages: [page(path, [typedClaim('personal', '用户学过机器学习课程。', source),
      typedClaim('personal', '用户精通机器学习。', source)])] };
  }, review: () => ({ approved: [{ pagePath: path, claimIndex: 0 }], rejected: [{ pagePath: path, claimIndex: 1,
    reason: '课程经历不能直接证明精通程度。' }] }), repair: () => {
    controller.abort(); throw new DOMException('fixture repair cancelled', 'AbortError');
  } });
  await assert.rejects(() => run(store, mock, question, { userSourceId: user.id, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(store.status().pages.some(p => p.path === path), false);
  noSearch(mock);
});

test('repair cannot relabel a rejected public fact as an opinion to bypass its review standard', async t => {
  const { store } = fixture(t), path = 'wiki/主题/监督学习的适用范围.md';
  const mock = modelMock({ coverage: { queries: ['监督学习 适用范围 大学课程'] }, write: input => {
    const source = input.sources.find(s => s.kind === 'web');
    return { pages: [page(path, [typedClaim('fact', '监督学习对所有数据都有效。', source,
      { attribution: '示例大学课程', basis: 'direct', evidence: evidence(source, teachingQuote) })])] };
  }, review: input => input.pages.some(p => p.claims.some(c => c.kind === 'fact'))
    ? { approved: [], rejected: [{ pagePath: path, claimIndex: 0, reason: '课程并未证明对所有数据都有效。' }] }
    : { approved: [{ pagePath: path, claimIndex: 0 }], rejected: [] }, repair: input => {
      const source = input.sources.find(s => s.kind === 'web');
      return { pages: [page(path, [typedClaim('opinion', '示例大学课程认为监督学习对所有数据都有效。', source,
        { attribution: '示例大学课程', basis: 'attributed', evidence: evidence(source, teachingQuote) })])] };
    } });
  const result = await run(store, mock, '请收录监督学习的适用范围');
  assert.equal(result.knowledge.saved, false, JSON.stringify(result));
  assert.match(result.text, /课程并未证明/);
  assert.equal(store.status().pages.some(p => p.path === path), false);
  assert.equal(mock.calls.filter(call => call.body?.messages?.[0].content.startsWith('证据支持审查')).length, 1,
    'a type-changing repair is filtered before it can be approved by the second review');
});
