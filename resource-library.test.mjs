import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, symlinkSync, readdirSync, chmodSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { ResourceLibrary, RESOURCE_UPLOAD_LIMIT } from './resource-library.mjs';
import { createServer } from './server.mjs';

function cleanup(root) {
  const absolute = resolve(root);
  assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('taotao-resources-'));
  rmSync(absolute, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-resources-'));
  const opened = [];
  const library = new ResourceLibrary(root, { openImpl: async path => { opened.push(path); } });
  t.after(() => { library.close(); cleanup(root); });
  const body = content => Object.assign(Readable.from([Buffer.from(content)]), { headers: {} });
  return { root, library, opened, body };
}

test('local files keep stable references through moves, content revisions, missing files and restart', async t => {
  const { root, library } = fixture(t);
  mkdirSync(join(library.folder, '会议'));
  writeFileSync(join(library.folder, '会议', '计划.docx'), 'Office原件');
  writeFileSync(join(library.folder, '资料.pdf'), '%PDF-1.7\nlocal');
  const first = await library.list();
  assert.equal(first.files.length, 2);
  const document = first.files.find(file => file.name === '计划.docx');
  assert.match(document.reference, /^resource:/);
  assert.equal(document.version, 1);
  assert.equal(document.previewable, false);
  assert.equal(document.openable, true);
  renameSync(join(library.folder, '会议', '计划.docx'), join(library.folder, '改名.docx'));
  let current = await library.get(document.id);
  assert.equal(current.relativePath, '改名.docx');
  assert.equal(current.version, 1);
  writeFileSync(join(library.folder, '改名.docx'), '补充后的Office原件');
  current = await library.get(document.id);
  assert.equal(current.version, 2);
  assert.notEqual(current.sha256, document.sha256);
  await assert.rejects(() => library.get(document.id, 1), { status: 409 });
  rmSync(join(library.folder, '改名.docx'));
  assert.equal((await library.get(document.id)).status, 'missing');
  const restarted = new ResourceLibrary(root);
  try {
    const file = await restarted.get(document.id);
    assert.equal(file.id, document.id);
    assert.equal(file.status, 'missing');
    assert.equal(file.version, 2);
    assert.equal(restarted.db.prepare('SELECT count(*) n FROM resource_versions WHERE resource_id=?').get(document.id).n, 2);
  } finally { restarted.close(); }
});

test('streamed uploads deduplicate bytes and concurrent filename collisions preserve both originals', async t => {
  const { library, body } = fixture(t);
  const first = await library.upload(body('第一份内容'), '项目说明.txt');
  const same = await library.upload(body('第一份内容'), '第二个名字.txt');
  assert.equal(same.duplicate, true);
  assert.equal(same.file.id, first.file.id);
  const collision = await library.upload(body('第二份内容'), '项目说明.txt');
  assert.equal(collision.file.name, '项目说明 (2).txt');
  assert.equal(readFileSync(join(library.folder, '项目说明.txt'), 'utf8'), '第一份内容');
  assert.equal(readFileSync(join(library.folder, collision.file.relativePath), 'utf8'), '第二份内容');
  const uploads = await Promise.all([library.upload(body('并行A'), '并行.doc'), library.upload(body('并行B'), '并行.doc')]);
  assert.notEqual(uploads[0].file.relativePath, uploads[1].file.relativePath);
  assert.equal((await library.list()).files.filter(file => file.status === 'ready').length, 4);
  assert.deepEqual(readdirSync(library.uploadFolder), []);
});

test('folders include empty nested directories and uploads stay in the selected folder', async t => {
  const { library, opened, body } = fixture(t);
  await library.createFolder({ name: '研究' });
  await library.createFolder({ parent: '研究', name: '会议' });
  await library.createFolder({ name: '空文件夹' });
  const rootFile = await library.upload(body('相同原件'), '说明.txt');
  const nestedFile = await library.upload(body('相同原件'), '说明.txt', '研究/会议');
  assert.notEqual(nestedFile.file.id, rootFile.file.id, 'same bytes may belong to different folders');
  assert.equal(nestedFile.file.relativePath, '研究/会议/说明.txt');
  assert.equal((await library.upload(body('相同原件'), '另一个名字.txt', '研究/会议')).duplicate, true);
  const collision = await library.upload(body('不同原件'), '说明.txt', '研究/会议');
  assert.equal(collision.file.relativePath, '研究/会议/说明 (2).txt');
  assert.deepEqual((await library.list()).folders.map(folder => folder.path).sort(), ['', '研究', '研究/会议', '空文件夹'].sort());
  await library.openFolder('研究/会议');
  assert.equal(opened.at(-1), join(library.folder, '研究', '会议'));
  for (const folder of ['../outside', '研究/../空文件夹', '/absolute', 'C:/outside', '研究\\会议']) {
    await assert.rejects(() => library.upload(body('无效'), '说明.txt', folder), { status: 400 });
  }
  await assert.rejects(() => library.upload(body('无效'), '说明.txt', '不存在'), { status: 404 });
  await assert.rejects(() => library.createFolder({ name: '../outside' }), { status: 400 });
  await assert.rejects(() => library.createFolder({ name: '空文件夹' }), { status: 409 });
});

test('immutable snapshots preserve cited versions after originals change or disappear', async t => {
  const { library, body } = fixture(t);
  const { file } = await library.upload(body('第一版原文'), '笔记.txt');
  await assert.rejects(() => library.resolveSnapshot(file.id, 1), { status: 404 });
  const first = await library.snapshot(file.id, 1);
  assert.equal(readFileSync(first.path, 'utf8'), '第一版原文');
  assert.ok(first.path.startsWith(library.snapshotFolder + sep));
  writeFileSync(join(library.folder, '笔记.txt'), '第二版原文');
  assert.equal((await library.get(file.id)).version, 2);
  const old = await library.get(file.id, 1);
  assert.equal(old.snapshot, true); assert.equal(old.historical, true); assert.equal(old.sha256, file.sha256);
  assert.equal((await library.snapshot(file.id, 1)).path, first.path);
  const second = await library.snapshot(file.id, 2);
  rmSync(join(library.folder, '笔记.txt'));
  assert.equal((await library.get(file.id)).status, 'missing');
  assert.equal((await library.get(file.id, 2)).snapshot, true);
  assert.equal(readFileSync(second.path, 'utf8'), '第二版原文');
  chmodSync(first.path, 0o644); writeFileSync(first.path, '被篡改原文');
  await assert.rejects(() => library.resolveSnapshot(file.id, 1), { status: 409 });
  await assert.rejects(() => library.snapshot(file.id, 1), { status: 409 });
});

test('snapshot cancellation and concurrent content changes never create mislabeled evidence', async t => {
  const { library, body } = fixture(t);
  const { file } = await library.upload(body('初始原文'), '变化.txt');
  await assert.rejects(() => library.snapshot(file.id, 1, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const get = library.get.bind(library);
  library.get = async (...args) => {
    const current = await get(...args);
    writeFileSync(join(library.folder, '变化.txt'), '复制前发生变化');
    return current;
  };
  await assert.rejects(() => library.snapshot(file.id, 1), { status: 409 });
  await assert.rejects(() => library.resolveSnapshot(file.id, 1), { status: 404 });
  assert.deepEqual(readdirSync(join(library.snapshotFolder, file.id)), []);
});

test('invalid names, links and oversized uploads never write outside the library', async t => {
  const { root, library, body } = fixture(t);
  for (const name of ['../outside.pdf', 'a/b.txt', 'C:\\outside.txt', 'NUL.txt', 'trailing.']) {
    await assert.rejects(() => library.upload(body('unsafe'), name), { status: 400 });
  }
  const oversized = body('small'); oversized.headers['content-length'] = RESOURCE_UPLOAD_LIMIT + 1;
  await assert.rejects(() => library.upload(oversized, 'large.pdf'), { status: 413 });
  assert.deepEqual(readdirSync(library.folder), []);
  const target = join(root, 'outside'); mkdirSync(target); writeFileSync(join(target, 'secret.txt'), '外部');
  try { symlinkSync(target, join(library.folder, '链接'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('System denied fixture junction creation'); return; } throw error; }
  const index = await library.list();
  assert.equal(index.files.length, 0);
  assert.equal(index.issues[0].error, '符号链接未加入');
  assert.throws(() => library.path('链接/secret.txt'), { status: 403 });
});

async function httpFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-resources-'));
  const opened = [];
  const server = createServer({ memoryRoot: root, resourceOpenImpl: async path => { opened.push(path); }, fetchImpl: () => { throw new Error('No model should be called'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(done => server.close(done)); cleanup(root);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = (name, content) => fetch(`${base}/api/resources/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/octet-stream' }, body: content });
  const post = path => fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
  return { root, base, opened, upload, post };
}

test('HTTP upload, preview, ranges, downloads and explicit open actions work without model calls', async t => {
  const { base, opened, upload, post } = await httpFixture(t);
  const response = await upload("用户's计划.pdf", '%PDF-1.7\n0123456789');
  assert.equal(response.status, 201);
  const { file } = await response.json();
  assert.equal(opened.length, 0, 'uploading does not launch local apps');
  const index = await (await fetch(base + '/api/resources')).json();
  assert.equal(index.files[0].id, file.id);
  const preview = await fetch(base + file.fileUrl);
  assert.equal(preview.headers.get('content-type'), 'application/pdf');
  assert.equal(preview.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.ok(preview.headers.get('content-security-policy').includes("frame-ancestors 'self'"));
  assert.ok(preview.headers.get('content-disposition').includes('inline;'));
  assert.equal(await preview.text(), '%PDF-1.7\n0123456789');
  const range = await fetch(base + file.fileUrl, { headers: { Range: 'bytes=9-12' } });
  assert.equal(range.status, 206); assert.equal(await range.text(), '0123');
  const suffix = await fetch(base + file.fileUrl, { headers: { Range: 'bytes=-3' } });
  assert.equal(await suffix.text(), '789');
  assert.equal((await fetch(base + file.fileUrl, { headers: { Range: 'bytes=100-120' } })).status, 416);
  const head = await fetch(base + file.fileUrl, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const download = await fetch(base + file.downloadUrl);
  assert.ok(download.headers.get('content-disposition').startsWith('attachment;'));
  assert.ok(download.headers.get('content-disposition').includes('filename*=UTF-8'));
  await download.arrayBuffer();
  assert.equal((await post(`/api/resources/${file.id}/open?version=1`)).status, 200);
  assert.ok(opened[0].endsWith("用户's计划.pdf"));
  assert.equal((await post('/api/resources/open-folder')).status, 200);
  assert.ok(opened[1].endsWith('资料库'));
});

test('versioned HTTP references serve preserved original bytes and open the snapshot', async t => {
  const { root, base, opened, upload, post } = await httpFixture(t);
  const { file } = await (await upload('引用.txt', '引用中的第一版')).json();
  const library = new ResourceLibrary(root);
  let snapshot;
  try { snapshot = await library.snapshot(file.id, 1); } finally { library.close(); }
  writeFileSync(join(root, '资料库', '引用.txt'), '修改后的第二版');
  const historical = await (await fetch(`${base}/api/resources/${file.id}?version=1`)).json();
  assert.equal(historical.snapshot, true);
  assert.equal(historical.version, 1);
  const response = await fetch(base + historical.fileUrl);
  assert.equal(response.status, 200); assert.equal(await response.text(), '引用中的第一版');
  const badHash = await fetch(base + historical.fileUrl + '&sha256=wrong');
  assert.equal(badHash.status, 409);
  assert.equal((await post(`/api/resources/${file.id}/open?version=1`)).status, 200);
  assert.equal(opened.at(-1), snapshot.path);
});

test('active document types only download and resource routes retain same-origin validation', async t => {
  const { base, opened, upload, post } = await httpFixture(t);
  for (const name of ['网页.html', '矢量.svg', '运行.cmd']) {
    const { file } = await (await upload(name, `<script>${name}</script>`)).json();
    assert.equal(file.previewable, false); assert.equal(file.openable, false);
    const response = await fetch(base + file.fileUrl);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.ok(response.headers.get('content-disposition').startsWith('attachment;'));
    await response.arrayBuffer();
    assert.equal((await post(`/api/resources/${file.id}/open`)).status, 415);
  }
  assert.equal(opened.length, 0);
  const wrongOrigin = await fetch(base + '/api/resources/upload?name=test.txt', { method: 'POST', headers: { Origin: 'https://elsewhere.example' }, body: 'bad' });
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await upload('../outside.pdf', 'bad')).status, 400);
  assert.equal((await fetch(base + '/api/resources/not-an-id/file')).status, 400);
  const noLibrary = createServer({ memoryRoot: false }); noLibrary.listen(0, '127.0.0.1'); await once(noLibrary, 'listening');
  try { assert.equal((await fetch(`http://127.0.0.1:${noLibrary.address().port}/api/resources`)).status, 404); }
  finally { noLibrary.closeAllConnections(); await new Promise(done => noLibrary.close(done)); }
});
