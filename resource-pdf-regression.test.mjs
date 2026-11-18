import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { extractDocument } from './resource-extract.mjs';

const root = import.meta.dirname;
const library = join(root, '资料库');
const python = process.env.TAOTAO_PYTHON || resolve(dirname(process.execPath), '../../python/python.exe');
const originals = existsSync(library) ? readdirSync(library) : [];
const chinese = originals.find(name => name.endsWith('简历.pdf'));
const english = originals.find(name => name.endsWith('简历_英文.pdf'));

function readableText(text, label) {
  const characters = [...text].filter(character => !/\s/u.test(character));
  const counts = new Map();
  for (const character of characters) counts.set(character, (counts.get(character) || 0) + 1);
  // Check shape without including private document text in assertion output.
  assert.ok(characters.length > 500, `${label}: expected a full text page`);
  assert.ok(counts.size > 40, `${label}: font mapping collapsed distinct characters`);
  assert.ok(Math.max(...counts.values()) / characters.length < 0.2, `${label}: excessive repeated glyphs`);
  assert.ok(!text.includes('\ufffd'), `${label}: unexpected replacement characters`);
}

test('real Chinese Type0 font PDF decodes distinct characters and preserves page locators',
  { skip: !chinese || !existsSync(python) }, async () => {
    const result = await extractDocument({ path: join(library, chinese) });
    assert.equal(result.parser, 'pypdf');
    assert.equal(result.pages.length, 2);
    for (const [index, page] of result.pages.entries()) {
      assert.equal(page.page, index + 1);
      assert.equal(page.locator, `第${index + 1}页`);
      readableText(page.text, `Chinese page ${index + 1}`);
      assert.ok([...page.text].filter(character => /\p{Script=Han}/u.test(character)).length > 400,
        'Chinese document retains real Han text');
      assert.ok(!page.ocr, 'A valid ToUnicode map needs no lossy OCR');
    }
    assert.ok(result.pages[0].text.includes('教育背景'), 'A generic section heading decodes correctly');
    assert.ok(result.pages[1].text.includes('其他项目'), 'The second page remains readable');
  });

test('real English Type0 font PDF decodes words instead of repeated ligatures',
  { skip: !english || !existsSync(python) }, async () => {
    const result = await extractDocument({ path: join(library, english) });
    assert.equal(result.parser, 'pypdf');
    assert.equal(result.pages.length, 2);
    for (const [index, page] of result.pages.entries()) {
      readableText(page.text, `English page ${index + 1}`);
      assert.ok((page.text.match(/[a-z]/gi) || []).length > 2000, 'English words survive decoding');
      assert.ok(!page.ocr, 'Valid mapped text should not require OCR');
    }
    for (const heading of ['Education', 'Technical Skills', 'Selected Projects']) {
      assert.ok(result.pages[0].text.includes(heading), `Generic heading ${heading} is readable`);
    }
    assert.ok(result.pages[1].text.includes('Additional Projects'), 'The second page has its own text');
  });

test('PDF quality detection catches legal-Unicode glyph collapse and accepts ordinary bilingual text',
  { skip: !existsSync(python) }, () => {
    const script = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('resource_extract', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
checks = [
    ('repeated_ligature', '\u0153' * 2300, True),
    ('mixed_collapsed_mapping', 'c' * 35 + '\u7962' * 6 + '\u9c4a' * 637 + '\u0153' * 496 + '\uc252' * 171, True),
    ('normal_english', 'Education and technical skills. This report explains a local document extraction system, preserves source citations, and keeps the original page numbers for later review.', False),
    ('normal_chinese', '\u6559\u80b2\u80cc\u666f\u4e0e\u9879\u76ee\u7ecf\u5386\u3002\u672c\u6587\u6863\u4ecb\u7ecd\u8d44\u6599\u5e93\u7684\u6587\u5b57\u63d0\u53d6\u6d41\u7a0b\uff0c\u4fdd\u7559\u9875\u7801\u4e0e\u6bb5\u843d\u4f4d\u7f6e\uff0c\u65b9\u4fbf\u4eba\u5de5\u56de\u67e5\u539f\u59cb\u8d44\u6599\u3002', False),
]
print(json.dumps([{'case': name, 'actual': module.text_looks_suspicious(value), 'expected': expected} for name, value, expected in checks]))
`;
    const result = JSON.parse(execFileSync(python, ['-c', script, join(root, 'resource-extract.py')],
      { windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
    for (const check of result) assert.equal(check.actual, check.expected, check.case);
  });

test('nonempty collapsed font mapping falls back to OCR and recovers rendered words',
  { skip: !existsSync(python) || process.platform !== 'win32' }, async t => {
    const temporary = await mkdtemp(join(tmpdir(), 'taotao-pdf-garbled-check-'));
    t.after(async () => {
      const absolute = resolve(temporary);
      assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('taotao-pdf-garbled-check-'));
      await rm(absolute, { recursive: true, force: true, maxRetries: 3 });
    });
    const setup = String.raw`
import json, pathlib, sys
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, DecodedStreamObject
folder = pathlib.Path(sys.argv[1])
source = folder / 'normal.pdf'
c = canvas.Canvas(str(source), pagesize=(720, 500))
c.setFont('Helvetica', 32)
for y in [440, 370, 300, 230, 160]:
    c.drawString(50, y, 'LOCAL PDF OCR TEST 2026')
c.save()
writer = PdfWriter()
writer.append(PdfReader(str(source)))
font = writer.pages[0]['/Resources']['/Font']['/F1'].get_object()
codes = list(range(65, 91)) + list(range(97, 123))
mapping = '\n'.join(f'<{code:02X}> <0153>' for code in codes)
cmap = ('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
        '/CMapName /CollapsedUnicode def\n/CMapType 2 def\n'
        '1 begincodespacerange\n<00> <FF>\nendcodespacerange\n'
        f'{len(codes)} beginbfchar\n{mapping}\nendbfchar\n'
        'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n')
stream = DecodedStreamObject()
stream.set_data(cmap.encode('ascii'))
font[NameObject('/ToUnicode')] = writer._add_object(stream)
destination = folder / 'collapsed-map.pdf'
with destination.open('wb') as output:
    writer.write(output)
raw = PdfReader(str(destination)).pages[0].extract_text()
print(json.dumps({'nonempty': bool(raw.strip()), 'ligatures': raw.count('\u0153'), 'hasOriginalWords': 'LOCAL PDF OCR TEST' in raw}))
`;
    const raw = JSON.parse(execFileSync(python, ['-c', setup, temporary],
      { windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
    assert.equal(raw.nonempty, true, 'The old empty-only fallback would not run');
    assert.ok(raw.ligatures >= 75, 'The synthetic ToUnicode map genuinely collapses letters');
    assert.equal(raw.hasOriginalWords, false);
    const result = await extractDocument({ path: join(temporary, 'collapsed-map.pdf') });
    assert.equal(result.parser, 'pypdf');
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].page, 1);
    assert.equal(result.pages[0].ocr, true);
    assert.ok(result.pages[0].text.includes('LOCAL PDF OCR TEST 2026'), 'OCR restores the rendered source words');
    assert.ok(result.warnings.some(warning => warning.includes('乱码')), 'The font-mapping failure is disclosed');
  });
