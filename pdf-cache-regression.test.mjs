import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { ResourceLibrary } from './resource-library.mjs';
import { ResourceDocuments } from './resource-summary.mjs';
import * as extractor from './resource-extract.mjs';
import { MemoryStore } from './memory.mjs';
import { runLibrarian } from './librarian.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-pdf-cache-'));
  const library = new ResourceLibrary(root, { openImpl: async () => {} });
  const state = { text: '锟斤拷锟斤拷旧解析乱码', calls: 0 };
  const documents = new ResourceDocuments(library, { extractImpl: async () => {
    state.calls++;
    return { parser: 'fixture-pdf', pages: [{ locator: '第1页', page: 1, text: state.text }], warnings: [] };
  } });
  t.after(() => {
    library.close();
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('taotao-pdf-cache-'));
    rmSync(absolute, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const upload = async (name = '报告.pdf') => (await library.upload(Object.assign(
    Readable.from([Buffer.from('%PDF-fixture-original-bytes')]), { headers: {} }), name)).file;
  const ageExtraction = file => {
    const row = library.db.prepare('SELECT data FROM resource_extractions WHERE resource_id=? AND sha256=?').get(file.id, file.sha256);
    const data = JSON.parse(row.data); delete data.extractorVersion;
    library.db.prepare('UPDATE resource_extractions SET data=? WHERE resource_id=? AND sha256=?').run(JSON.stringify(data), file.id, file.sha256);
  };
  const ageDraft = id => {
    const row = library.db.prepare('SELECT data FROM resource_summaries WHERE id=?').get(id);
    const data = JSON.parse(row.data); delete data.extractorVersion;
    library.db.prepare('UPDATE resource_summaries SET data=? WHERE id=?').run(JSON.stringify(data), id);
  };
  return { root, library, documents, state, upload, ageExtraction, ageDraft };
}

test('old extraction caches rebuild without reusing garbled search rows or evidence identities', async t => {
  const { documents, library, state, upload, ageExtraction } = fixture(t);
  const file = await upload();
  const old = await documents.extract(file.id, 1);
  const previous = documents.chunks(old.file)[0];
  ageExtraction(file);
  state.text = '项目报告记载，研究预算为三百二十元。';
  const repaired = await documents.extract(file.id, 1);
  assert.equal(repaired.cached, false);
  assert.equal(repaired.extractorVersion, extractor.EXTRACTION_VERSION);
  assert.ok(Number.isSafeInteger(extractor.EXTRACTION_VERSION));
  assert.equal(state.calls, 2);
  assert.equal(repaired.file.sha256, old.file.sha256, 'the original PDF bytes and version did not change');
  assert.equal(repaired.file.version, 1);
  const current = documents.chunks(repaired.file)[0];
  assert.notEqual(current.indexId, previous.indexId, 'corrected original text needs a new immutable evidence identity');
  assert.notEqual(current.id, previous.id);
  assert.match(current.text, /预算为三百二十元/);
  assert.equal(library.db.prepare('SELECT count(*) n FROM resource_text WHERE resource_text MATCH ?').get('"旧解析乱码"').n, 0);
  assert.equal(library.db.prepare('SELECT count(*) n FROM resource_text WHERE resource_text MATCH ?').get('"研究预算"').n, 1);
  assert.equal((await documents.extract(file.id, 1)).cached, true);
  assert.equal(state.calls, 2, 'the repaired current-version cache is reusable');
});

test('old PDF drafts preserve their historical sources but require regeneration before intake', async t => {
  const { documents, ageDraft } = fixture(t);
  const pdfId = randomUUID(), textId = randomUUID(), sessionId = randomUUID();
  const source = { id: randomUUID(), kind: 'document', content: '旧解析内容保持为当时的证据。', document: { resourceId: randomUUID() } };
  documents.remember(pdfId, sessionId, { files: [{ id: source.document.resourceId, ext: 'pdf' }], text: '旧摘要', sources: [source] });
  ageDraft(pdfId);
  const stale = documents.draft(pdfId);
  assert.equal(stale.stale, true);
  assert.equal(stale.text, '旧摘要');
  assert.deepEqual(stale.sources, [source], 'old evidence must not silently become the repaired text');
  const stored = JSON.parse(documents.db.prepare('SELECT data FROM resource_summaries WHERE id=?').get(pdfId).data);
  assert.deepEqual(stored.sources, [source]);
  documents.remember(textId, sessionId, { files: [{ ext: 'txt' }], text: '原有文本摘要', sources: [source] });
  ageDraft(textId);
  assert.notEqual(documents.draft(textId).stale, true, 'a PDF parser fix does not invalidate unrelated text drafts');
  const newId = randomUUID();
  documents.remember(newId, sessionId, { files: [{ ext: 'pdf' }], text: '重新生成的摘要', sources: [source] });
  assert.equal(documents.draft(newId).extractorVersion, extractor.EXTRACTION_VERSION);
  assert.notEqual(documents.draft(newId).stale, true);
});

test('an authorized librarian refuses stale PDF evidence before any model or knowledge write', async t => {
  let memory; t.after(() => memory?.close());
  const { root } = fixture(t);
  memory = new MemoryStore(root);
  memory.setKnowledgePermission(true);
  const sessionId = randomUUID(), userId = randomUUID();
  const question = '收录这份旧PDF摘要';
  memory.saveUser({ sessionId, id: userId, content: question, agent: 'librarian' });
  let calls = 0;
  const result = await runLibrarian({ memory, question, apiKey: 'sk-fixture-only', model: 'fixture-model',
    userSourceId: userId, submission: { review_session: sessionId },
    documentDraft: { stale: true, files: [{ ext: 'pdf' }], sources: [{ id: randomUUID(), content: '旧的乱码证据' }] },
    fetchImpl: async () => { calls++; throw new Error('Stale evidence must not reach a model'); } });
  assert.equal(calls, 0);
  assert.equal(result.knowledge.saved, false);
  assert.match(result.text, /重新.*摘要|重新.*提取|更新/);
  assert.equal(memory.knowledgeStatus().claimsCount, 0);
});
