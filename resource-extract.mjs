import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const EXTRACTION_VERSION = 2;
const MAX_PAGES = 200, MAX_CHARS = 1000000, MAX_OCR = 30;
const textTypes = new Set(['txt', 'md', 'csv', 'log', 'json', 'xml', 'yaml', 'yml']);
const imageTypes = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'heic', 'tif', 'tiff']);
const failure = (message, status = 422) => Object.assign(new Error(message), { status });

async function pythonPath() {
  const candidates = [process.env.TAOTAO_PYTHON, resolve(dirname(process.execPath), '../../python/python.exe')];
  const programs = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Python');
  if (programs) for (const entry of await readdir(programs).catch(() => [])) candidates.push(join(programs, entry, 'python.exe'));
  const apps = join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps');
  for (const entry of (await readdir(apps).catch(() => [])).filter(name => name.startsWith('OpenAI.CodexPrimaryRuntime.')).sort().reverse()) {
    candidates.push(join(apps, entry, 'dependencies', 'python', 'python.exe'));
  }
  return candidates.find(candidate => candidate && existsSync(candidate)) || (process.platform === 'win32' ? null : 'python3');
}

async function run(command, args, { signal, onProgress, timeout = 180000 } = {}) {
  signal?.throwIfAborted();
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  let timeoutHit = false, errorText = '', result;
  child.stdout.setEncoding('utf8');
  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timeoutHit = true; child.kill(); }, timeout); timer.unref();
  const exited = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, stopSignal) => done({ code, stopSignal })); });
  // Attach before consuming output so a missing executable never creates an unhandled rejection.
  void exited.catch(() => {});
  child.stderr.on('data', chunk => { if (errorText.length < 2000) errorText += chunk.toString('utf8'); });
  let buffer = '', outputBytes = 0;
  try {
    const consume = async line => {
      if (!line.trim()) return;
      let value; try { value = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { return; }
      if (value.progress) await onProgress?.(value.progress);
      if (value.result) result = value.result;
      if (value.error) throw failure(value.error);
    };
    for await (const chunk of child.stdout) {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 16000000) { child.kill(); throw failure('提取内容过多，请将资料分成较小的文件。'); }
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) { await consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    }
    if (buffer.trim()) await consume(buffer);
    const exit = await exited;
    signal?.throwIfAborted();
    if (timeoutHit) throw failure('本地提取超时，请分批处理较小的文件。', 408);
    if (exit.code !== 0 || !result) throw failure('本地提取失败，文件可能损坏、加密或格式不受支持。');
    return result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (child.exitCode === null) child.kill(); }
}

function bound(result) {
  let used = 0;
  const pages = result.pages.slice(0, MAX_PAGES).map(page => {
    const text = String(page.text || '').replace(/\u0000/g, '').trim();
    const available = Math.max(0, MAX_CHARS - used); used += Math.min(available, text.length);
    if (text.length > available) result.truncated = true;
    return { locator: String(page.locator || '正文').slice(0, 300), ...(page.page ? { page: page.page } : {}), text: text.slice(0, available), ...(page.ocr ? { ocr: true } : {}) };
  });
  if (result.pages.length > MAX_PAGES) result.truncated = true;
  const warnings = [...new Set(result.warnings || [])];
  if (result.truncated && !warnings.some(warning => /上限|截断|前\s*\d/.test(warning))) warnings.push(`已达到提取上限（${MAX_PAGES} 段/页或 ${MAX_CHARS} 字符），其余内容未提取。`);
  if (!pages.some(page => page.text)) throw failure(warnings[0] || '未能提取可用文字，文件可能为空、加密或图片识别失败。');
  return { parser: result.parser, pages, warnings, truncated: !!result.truncated, ...(result.totalPages ? { totalPages: result.totalPages } : {}) };
}

export async function extractDocument({ path, ext = extname(path).slice(1), signal, onProgress } = {}) {
  signal?.throwIfAborted();
  ext = String(ext).replace(/^\./, '').toLowerCase();
  const info = await stat(path);
  if (!info.isFile()) throw failure('找不到这份资料。', 404);
  if (info.size > 200 * 1024 * 1024) throw failure('提取文件上限为 200 MB，请拆分后处理。', 413);
  await onProgress?.({ stage: 'extract', detail: '提取原文' });
  if (textTypes.has(ext)) {
    const bytes = await readFile(path);
    const decoder = bytes[0] === 0xff && bytes[1] === 0xfe ? new TextDecoder('utf-16le') : bytes[0] === 0xfe && bytes[1] === 0xff ? new TextDecoder('utf-16be') : new TextDecoder('utf-8');
    return bound({ parser: 'text', pages: [{ locator: '正文', text: decoder.decode(bytes) }], warnings: [] });
  }
  if (ext === 'doc') return bound(await run(process.execPath, [fileURLToPath(import.meta.url), '--doc-worker', resolve(path)], { signal, onProgress }));
  if (!['pdf', 'docx'].includes(ext) && !imageTypes.has(ext)) throw failure('这类文件暂不支持文字提取。', 415);
  const temporary = await mkdtemp(join(tmpdir(), 'taotao-extract-'));
  try {
    let result;
    if (imageTypes.has(ext)) result = { parser: 'windows-ocr', pages: [{ locator: '第1张图', page: 1, text: '', ocrImage: resolve(path) }], warnings: [] };
    else {
      const python = await pythonPath();
      if (!python) throw failure('未找到本地文档解析环境：请安装 Python 3 后运行 pip install pypdf pypdfium2，或设置 TAOTAO_PYTHON 指向 python.exe。', 503);
      result = await run(python, [join(ROOT, 'resource-extract.py'), resolve(path), ext, temporary, String(MAX_PAGES), String(MAX_CHARS), String(MAX_OCR)], { signal, onProgress });
    }
    const images = result.pages.map((page, index) => ({ index, path: page.ocrImage })).filter(image => image.path);
    if (images.length) {
      if (process.platform !== 'win32') result.warnings.push('当前系统没有 Windows OCR，图片页面尚未提取文字。');
      else {
        await onProgress?.({ stage: 'ocr', detail: `识别 ${images.length} 页图片` });
        const manifest = join(temporary, 'ocr.json'); await writeFile(manifest, JSON.stringify(images));
        try {
          const recognized = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'resource-extract.ps1'), '-Manifest', manifest], { signal, onProgress, timeout: 180000 });
          for (const page of recognized.pages || []) {
            if (page.text) { result.pages[page.index].text = page.text; result.pages[page.index].ocr = true; }
            else result.warnings.push(`${result.pages[page.index].locator} 未识别到文字。`);
          }
          if (recognized.warnings?.length) result.warnings.push(`${recognized.warnings.length} 页图片无法识别，请对照原件。`);
          result.warnings.push('OCR 文字可能存在识别错误，引用前请对照原件。');
        } catch (err) { signal?.throwIfAborted(); result.warnings.push(/Windows OCR/.test(err.message) ? '本机没有可用的 Windows 文字识别语言包。' : `图片文字识别未完成：${err.message}`); }
      }
    }
    signal?.throwIfAborted();
    return bound(result);
  } finally {
    const absolute = resolve(temporary);
    if (absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('taotao-extract-')) await rm(absolute, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[2] === '--doc-worker') {
  try {
    const require = createRequire(new URL('./tools/document-extract/package.json', import.meta.url));
    const WordExtractor = require('word-extractor');
    const document = await new WordExtractor().extract(process.argv[3]);
    const original = { filterUnicode: false };
    const parts = [document.getBody(original), document.getHeaders(original), document.getFootnotes(original), document.getEndnotes(original), document.getTextboxes(original)].filter(Boolean);
    const text = parts.join('\n\n');
    const pages = text.split(/\n\s*\n/).filter(part => part.trim()).map((part, index) => ({ locator: `第${index + 1}段`, text: part }));
    process.stdout.write(JSON.stringify({ result: bound({ parser: 'word-extractor', pages, warnings: ['DOC 按段落定位，未使用排版页码；修订及隐藏内容请对照原件。'] }) }) + '\n');
  } catch (error) {
    // 新机器上最容易踩的其实是少装一个包，不要报成"文件损坏"。
    const missing = /Cannot find module|MODULE_NOT_FOUND/.test(String(error?.message || error));
    const message = missing
      ? '这台电脑还没有安装 DOC 解析组件：在项目的 tools/document-extract 文件夹里运行 npm install，然后重试。'
      : 'DOC 文件无法解析，文件可能损坏、加密或不是 Word 文档。';
    process.stdout.write(JSON.stringify({ error: message }) + '\n'); process.exitCode = 1;
  }
}
