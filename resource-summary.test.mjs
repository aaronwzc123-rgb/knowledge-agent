import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { ResourceLibrary } from './resource-library.mjs';
import { ResourceDocuments, runResourceSummary } from './resource-summary.mjs';
import { createActivityTracker } from './activity.mjs';

function fixture(t, extractImpl) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-summary-'));
  const library = new ResourceLibrary(root, { openImpl: async () => {} });
  const extractions = [];
  const documents = new ResourceDocuments(library, { extractImpl: async options => {
    extractions.push(options);
    return extractImpl ? extractImpl(options) : { parser: 'fixture-text', pages: readFileSync(options.path, 'utf8').split('\f')
      .map((text, index) => ({ locator: `第${index + 1}页`, page: index + 1, text })), warnings: [] };
  } });
  t.after(() => {
    library.close();
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('taotao-summary-'));
    rmSync(absolute, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const upload = async (text, name = '报告.txt', folder = '') => (await library.upload(
    Object.assign(Readable.from([Buffer.from(text)]), { headers: {} }), name, folder)).file;
  return { root, library, documents, extractions, upload };
}

function runner(documents, overrides = {}) {
  const calls = [], events = [];
  const modelCall = async (system, input, tokens) => {
    calls.push({ system, input, tokens });
    if (overrides.modelCall) return overrides.modelCall(system, input, tokens);
    if (system.startsWith('逐段核对摘要')) return { approved: input.paragraphs.map(paragraph => paragraph.index), gaps: [] };
    if (input.drafts) return { paragraphs: input.drafts, gaps: [] };
    const source = input.sources.find(source => source.text.includes('火星探测')) || input.sources[0];
    return { paragraphs: [{ text: `文件记载：${source.text.slice(0, 60)}`, evidence: [{ sourceId: source.sourceId, quote: source.text.slice(0, 60) }] }], gaps: [] };
  };
  const options = {
    documents, question: '摘要', modelCall,
    activity: createActivityTracker(async event => { events.push(event.activity); }),
    messageId: randomUUID(), sessionId: randomUUID(), origin: 'http://127.0.0.1:18765',
    ...overrides,
  };
  options.modelCall = modelCall;
  return { options, calls, events, run: (extra = {}) => runResourceSummary({ ...options, ...extra }) };
}

test('extraction caches by bytes, indexes located chunks and preserves both cited versions', async t => {
  const { library, documents, upload, extractions } = fixture(t);
  const first = await upload('第一版原文，预算为一百万元。\f火星探测采用两阶段验证方案。');
  const extracted = await documents.extract(first.id, 1);
  assert.equal(extracted.cached, false); assert.equal(extracted.file.version, 1);
  assert.equal(extractions.length, 1);
  assert.ok(extractions[0].path.startsWith(library.snapshotFolder + sep));
  const chunks = documents.chunks(extracted.file);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].page, 2); assert.equal(chunks[1].locator, '第2页');
  assert.equal(documents.db.prepare('SELECT COUNT(*) AS n FROM resource_text WHERE resource_text MATCH ?').get('"火星探测"').n, 1);
  assert.equal(documents.retrieve(chunks, '火星探测', 20)[0].id, chunks[1].id);
  assert.equal((await documents.extract(first.id, 1)).cached, true); assert.equal(extractions.length, 1);
  writeFileSync(join(library.folder, first.relativePath), '第二版原文，预算已调整为二百万元。');
  const revised = await documents.extract(first.id);
  assert.equal(revised.file.version, 2); assert.equal(revised.cached, false); assert.equal(extractions.length, 2);
  assert.notEqual(revised.file.sha256, first.sha256);
  const historical = await documents.extract(first.id, 1);
  assert.equal(historical.cached, true); assert.equal(historical.file.version, 1); assert.equal(extractions.length, 2);
  assert.match(historical.pages[0].text, /一百万元/);
  assert.equal(documents.db.prepare('SELECT COUNT(*) AS n FROM resource_extractions').get().n, 2);
  assert.equal(documents.db.prepare('SELECT COUNT(*) AS n FROM resource_chunks').get().n, 3);
});

test('no selected or matching files returns without model calls or a saved draft', async t => {
  const { documents } = fixture(t);
  const task = runner(documents);
  const result = await task.run();
  assert.match(result.text, /请选择资料/);
  assert.deepEqual(result.sources, []); assert.equal(task.calls.length, 0);
  assert.equal(documents.draft(task.options.messageId), null);
  assert.equal(task.events.at(-1).state, 'complete');
});

test('ambiguous filenames require a path and finish the lookup activity without a model call', async t => {
  const { documents, library, upload } = fixture(t);
  await library.createFolder({ name: '项目甲' }); await library.createFolder({ name: '项目乙' });
  await upload('甲项目预算一百万元。', '计划.txt', '项目甲');
  await upload('乙项目预算二百万元。', '计划.txt', '项目乙');
  const task = runner(documents, { question: '总结计划.txt' });
  const result = await task.run();
  assert.match(result.text, /同名/); assert.equal(task.calls.length, 0);
  assert.equal(documents.draft(task.options.messageId), null);
  assert.equal(task.events.at(-1).state, 'complete');
});

test('an explicit relative path selects one of the files sharing a basename', async t => {
  const { documents, library, upload } = fixture(t);
  await library.createFolder({ name: '项目甲' }); await library.createFolder({ name: '项目乙' });
  const first = await upload('甲项目计划记载预算一百万元。', '计划.txt', '项目甲');
  await upload('乙项目计划记载预算二百万元。', '计划.txt', '项目乙');
  const task = runner(documents, { question: '请摘要项目甲/计划.txt' });
  const result = await task.run();
  assert.equal(task.calls.length, 2);
  assert.deepEqual(result.files.map(file => file.id), [first.id]);
  assert.ok(result.sources.every(source => source.document.resourceId === first.id));
  assert.doesNotMatch(result.text, /同名资料/);
});

test('restoring earlier bytes reuses extraction while citation IDs still distinguish versions', async t => {
  const { documents, library, upload, extractions } = fixture(t);
  const original = '原始方案记载预算一百万元。';
  const file = await upload(original);
  const firstTask = runner(documents);
  const first = await firstTask.run({ resourceIds: [file.id] });
  writeFileSync(join(library.folder, file.relativePath), '修改方案记载预算二百万元。');
  await runner(documents).run({ resourceIds: [file.id] });
  writeFileSync(join(library.folder, file.relativePath), original);
  const third = await runner(documents).run({ resourceIds: [file.id] });
  assert.equal(extractions.length, 2, 'the restored bytes reuse the first extraction cache');
  assert.equal(first.sources[0].document.version, 1);
  assert.equal(third.sources[0].document.version, 3);
  assert.equal(first.sources[0].document.sha256, third.sources[0].document.sha256);
  assert.notEqual(first.sources[0].id, third.sources[0].id);
  assert.equal(new URL(first.sources[0].url).searchParams.get('version'), '1');
  assert.equal(new URL(third.sources[0].url).searchParams.get('version'), '3');
  assert.equal(documents.draft(firstTask.options.messageId).sources[0].document.version, 1);
});

test('summary rejects fabricated quotes, unknown IDs and markup before the independent review', async t => {
  const { documents, upload } = fixture(t);
  const file = await upload('文件记载预算为一百万元，项目分两个阶段实施。');
  let reviewed;
  const task = runner(documents, { modelCall: async (system, input) => {
    if (system.startsWith('逐段核对摘要')) { reviewed = input; return { approved: [0], gaps: [] }; }
    const source = input.sources[0];
    return { paragraphs: [
      { text: '项目预算一百万元。', evidence: [{ sourceId: source.sourceId, quote: '预算为一百万元' }] },
      { text: '不存在的费用。', evidence: [{ sourceId: source.sourceId, quote: '预算为九千万元' }] },
      { text: '来自未知文件。', evidence: [{ sourceId: randomUUID(), quote: '预算为一百万元' }] },
      { text: '<script>alert(1)</script>', evidence: [{ sourceId: source.sourceId, quote: '预算为一百万元' }] },
    ], gaps: [] };
  } });
  const result = await task.run({ resourceIds: [file.id] });
  assert.equal(task.calls.length, 2); assert.equal(reviewed.paragraphs.length, 1);
  assert.equal(result.paragraphs.length, 1); assert.equal(result.sources.length, 1);
  assert.match(result.text, /项目预算一百万元。\[\^1\]/);
  assert.doesNotMatch(result.text, /九千|未知文件|script/);
  const source = result.sources[0];
  assert.equal(source.kind, 'document'); assert.equal(source.reliability, 'document_statement');
  assert.equal(source.content, '文件记载预算为一百万元，项目分两个阶段实施。');
  assert.equal(source.document.resourceId, file.id); assert.equal(source.document.sha256, file.sha256);
  assert.equal(source.document.version, 1); assert.equal(source.document.locator, '第1页');
  const url = new URL(source.url);
  assert.equal(url.origin, task.options.origin); assert.equal(url.searchParams.get('resource'), file.id);
  assert.equal(url.searchParams.get('version'), '1'); assert.equal(url.hash, '#page=1');
  const draft = documents.draft(task.options.messageId);
  assert.equal(draft.text, result.text); assert.deepEqual(draft.sources, result.sources);
  documents.deleteSession(task.options.sessionId);
  assert.equal(documents.draft(task.options.messageId), null);
});

test('independent support review can reject otherwise literal evidence', async t => {
  const { documents, upload } = fixture(t);
  const file = await upload('项目曾讨论预算一百万元，但并未批准。');
  const task = runner(documents, { modelCall: async (system, input) => system.startsWith('逐段核对摘要')
    ? { approved: [], gaps: ['原文并未批准预算。'] }
    : { paragraphs: [{ text: '项目已批准预算一百万元。', evidence: [{ sourceId: input.sources[0].sourceId, quote: '预算一百万元' }] }] } });
  const result = await task.run({ resourceIds: [file.id] });
  assert.equal(task.calls.length, 2); assert.deepEqual(result.paragraphs, []); assert.deepEqual(result.sources, []);
  assert.match(result.text, /未生成可引用结论/); assert.match(result.text, /原文并未批准预算/);
  assert.doesNotMatch(result.text, /项目已批准/);
});

test('question retrieval declares partial coverage and selects the relevant original passages', async t => {
  const pages = Array.from({ length: 8 }, (_, index) => ({ locator: `第${index + 1}页`, page: index + 1,
    text: (index === 7 ? '火星探测预算为一百万元。' : `第${index + 1}章会议安排。`).padEnd(6000, '资料') }));
  const { documents, upload } = fixture(t, async () => ({ parser: 'fixture-long', pages, warnings: [] }));
  const file = await upload('长篇原件，用于片段检索。');
  const task = runner(documents, { question: '围绕火星探测，预算是多少？' });
  const result = await task.run({ resourceIds: [file.id] });
  assert.match(result.text, /本次依据检索到的相关段落回答/);
  assert.equal(task.events.find(event => event.title === '检索相关段落' && event.state === 'complete').detail, '6/8 个片段 · 36000 字');
  assert.ok(task.calls.some(call => call.input.sources?.some(source => source.text.includes('火星探测预算'))));
  assert.ok(result.sources.some(source => source.content.includes('火星探测预算')));
});

test('long overviews use bounded batches, merge and review while retaining each batch gap', async t => {
  const pages = Array.from({ length: 12 }, (_, index) => ({ locator: `第${index + 1}页`, page: index + 1,
    text: `第${index + 1}章原文：这一阶段需要完成实地验证。`.padEnd(6000, '资料') }));
  const { documents, upload } = fixture(t, async () => ({ parser: 'fixture-long', pages, warnings: [] }));
  const file = await upload('全文摘要原件。');
  let batch = 0;
  const task = runner(documents, { modelCall: async (system, input) => {
    if (system.startsWith('逐段核对摘要')) return { approved: input.paragraphs.map(paragraph => paragraph.index), gaps: [] };
    if (input.drafts) return { paragraphs: input.drafts, gaps: [] };
    batch++;
    assert.ok(input.sources.reduce((size, source) => size + source.text.length, 0) <= 24000);
    return { paragraphs: [{ text: `文件第${batch}部分记载实地验证要求。`,
      evidence: [{ sourceId: input.sources[0].sourceId, quote: input.sources[0].text.slice(0, 35) }] }], gaps: [`第${batch}部分没有给出完成日期。`] };
  } });
  const result = await task.run({ resourceIds: [file.id] });
  assert.equal(batch, 3); assert.equal(task.calls.length, 5);
  assert.equal(task.calls.filter(call => call.input.drafts).length, 1);
  assert.equal(task.calls.filter(call => call.system.startsWith('逐段核对摘要')).length, 1);
  assert.equal(result.paragraphs.length, 3);
  for (let index = 1; index <= 3; index++) assert.match(result.text, new RegExp(`第${index}部分没有给出完成日期`));
  assert.doesNotMatch(result.text, /检索到的相关段落/);
});

test('OCR provenance and extraction warnings survive cached summaries', async t => {
  const { documents, upload } = fixture(t, async () => ({ parser: 'fixture-ocr', pages: [
    { locator: '第3页', page: 3, text: '扫描件记载预算暂为一百万元。', ocr: true },
  ], warnings: ['第四页文字无法辨认。'], truncated: true }));
  const file = await upload('扫描原件。', '扫描.pdf');
  await documents.extract(file.id, 1);
  const task = runner(documents);
  const result = await task.run({ resourceIds: [file.id] });
  assert.equal(result.sources[0].document.ocr, true);
  assert.match(result.text, /第四页文字无法辨认/);
  assert.match(result.text, /本次摘要不覆盖未提取部分/);
});

test('cancellation during extraction or generation never saves a summary draft', async t => {
  const firstController = new AbortController();
  const first = fixture(t, async () => {
    firstController.abort();
    return { parser: 'fixture-cancelled', pages: [{ locator: '第1页', page: 1, text: '中途取消的原文内容。' }], warnings: [] };
  });
  const firstFile = await first.upload('取消提取原件。');
  const firstTask = runner(first.documents, { signal: firstController.signal });
  await assert.rejects(() => firstTask.run({ resourceIds: [firstFile.id] }), { name: 'AbortError' });
  assert.equal(firstTask.calls.length, 0); assert.equal(first.documents.draft(firstTask.options.messageId), null);
  assert.equal(first.documents.db.prepare('SELECT COUNT(*) AS n FROM resource_extractions').get().n, 0);

  const secondController = new AbortController();
  const second = fixture(t);
  const secondFile = await second.upload('生成过程中取消，原文应完整保留。');
  const secondTask = runner(second.documents, { signal: secondController.signal, modelCall: async () => {
    secondController.abort(); return { paragraphs: [] };
  } });
  await assert.rejects(() => secondTask.run({ resourceIds: [secondFile.id] }), { name: 'AbortError' });
  assert.equal(secondTask.calls.length, 1); assert.equal(second.documents.draft(secondTask.options.messageId), null);
  assert.equal(readFileSync(join(second.library.folder, secondFile.relativePath), 'utf8'), '生成过程中取消，原文应完整保留。');
});
