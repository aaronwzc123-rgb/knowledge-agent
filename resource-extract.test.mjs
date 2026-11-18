import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { extractDocument } from './resource-extract.mjs';

const python = process.env.TAOTAO_PYTHON || resolve(dirname(process.execPath), '../../python/python.exe');
const root = mkdtempSync(join(tmpdir(), 'taotao-extract-check-'));
const setup = String.raw`
import os,sys
from reportlab.pdfgen import canvas
from docx import Document
from PIL import Image,ImageDraw,ImageFont
root=sys.argv[1]
im=Image.new('RGB',(1400,300),'white')
draw=ImageDraw.Draw(im)
draw.text((50,80),'LOCAL OCR TEST 2026',font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',70),fill='black')
im.save(os.path.join(root,'scan.png'))
c=canvas.Canvas(os.path.join(root,'mixed.pdf'))
c.drawString(60,700,'Page one keeps exact text and citations.');c.showPage()
c.drawImage(os.path.join(root,'scan.png'),50,500,width=500,height=107);c.showPage();c.save()
d=Document();d.add_heading('Project plan',1);d.add_paragraph('The research budget is 320 yuan.')
t=d.add_table(rows=1,cols=2);t.cell(0,0).text='Milestone';t.cell(0,1).text='December 2026'
d.save(os.path.join(root,'sample.docx'))
`;

test.after(() => {
  const absolute = resolve(root);
  assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('taotao-extract-check-'));
  rmSync(absolute, { recursive: true, force: true, maxRetries: 3 });
});

test('text decoding and explicit truncation never disguise partial extraction', async () => {
  const path = join(root, 'unicode.txt');
  writeFileSync(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文资料与原文引用', 'utf16le')]));
  const result = await extractDocument({ path });
  assert.equal(result.pages[0].text, '中文资料与原文引用');
  writeFileSync(path, '资料'.repeat(600000));
  const long = await extractDocument({ path });
  assert.equal(long.pages[0].text.length, 1000000);
  assert.equal(long.truncated, true);
  assert.ok(long.warnings.some(warning => warning.includes('上限')));
});

test('real old DOC is parsed as data without starting Office', async () => {
  const result = await extractDocument({ path: join(import.meta.dirname, 'tools/document-extract/fixtures/sample.doc') });
  assert.equal(result.parser, 'word-extractor');
  assert.ok(result.pages.some(page => page.text.includes('This is a test of reviewing')));
  assert.equal(result.pages[0].locator, '第1段');
});

test('real PDF/DOCX and image OCR retain page, paragraph and table locators', { skip: !existsSync(python) || process.platform !== 'win32' }, async () => {
  execFileSync(python, ['-c', setup, root], { windowsHide: true });
  const progress = [];
  const pdf = await extractDocument({ path: join(root, 'mixed.pdf'), onProgress: event => progress.push(event) });
  assert.equal(pdf.pages.length, 2);
  assert.equal(pdf.pages[0].page, 1);
  assert.equal(pdf.pages[0].locator, '第1页');
  assert.ok(pdf.pages[0].text.includes('Page one keeps exact text'));
  assert.equal(pdf.pages[1].page, 2);
  assert.equal(pdf.pages[1].ocr, true);
  assert.match(pdf.pages[1].text, /LOCAL OCR TEST 2026/);
  assert.ok(progress.some(event => event.stage === 'ocr'));
  const docx = await extractDocument({ path: join(root, 'sample.docx') });
  assert.ok(docx.pages.some(page => page.locator.includes('第2段') && page.text.includes('320 yuan')));
  assert.ok(docx.pages.some(page => page.locator.includes('表1') && page.text.includes('December 2026')));
  assert.ok(docx.pages.every(page => page.page === undefined), 'DOCX does not invent layout page numbers');
  const image = await extractDocument({ path: join(root, 'scan.png') });
  assert.match(image.pages[0].text, /LOCAL OCR TEST 2026/);
  assert.equal(image.pages[0].ocr, true);
  const cancelled = new AbortController();
  await assert.rejects(() => extractDocument({ path: join(root, 'mixed.pdf'), signal: cancelled.signal,
    onProgress: event => { if (event.current === 1) cancelled.abort(); } }), { name: 'AbortError' });
});

test('unsupported, broken, empty and cancelled documents fail honestly', async () => {
  const path = join(root, 'broken.pdf'); writeFileSync(path, 'not a pdf');
  await assert.rejects(() => extractDocument({ path }), { status: 422 });
  await assert.rejects(() => extractDocument({ path, ext: 'exe' }), { status: 415 });
  const empty = join(root, 'empty.txt'); writeFileSync(empty, '');
  await assert.rejects(() => extractDocument({ path: empty }), { status: 422 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => extractDocument({ path, signal: controller.signal }), { name: 'AbortError' });
});
