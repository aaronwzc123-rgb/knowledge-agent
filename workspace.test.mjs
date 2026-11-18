import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.mjs';
import { MemoryStore } from './memory.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const results = join(root, 'test-results');
const sleep = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function eventually(fn, description, timeout = 14000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error.message; }
    await sleep(60);
  }
  throw new Error(`Timed out: ${description}; ${JSON.stringify(last)}`);
}
async function browserExecutable() {
  for (const file of [process.env.BROWSER_EXE,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean)) {
    try { await access(file); return file; } catch {}
  }
  throw new Error('Edge or Chrome is required for workspace checks.');
}
class CDP {
  constructor(socket) {
    this.socket = socket; this.id = 0; this.pending = new Map(); this.exceptions = [];
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (data.method === 'Runtime.exceptionThrown') this.exceptions.push(data.params.exceptionDetails);
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id); clearTimeout(pending.timer);
      data.error ? pending.reject(new Error(data.error.message)) : pending.resolve(data.result);
    });
  }
  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, reject) => {
      socket.addEventListener('open', resolveOpen, { once: true }); socket.addEventListener('error', reject, { once: true });
    });
    return new CDP(socket);
  }
  call(method, params = {}) {
    return new Promise((resolveCall, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
      this.pending.set(id, { resolve: resolveCall, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const response = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
}
function installSpeechMock() {
  const mock = window.__speech = { started: [], ended: [], cancelled: 0, active: null, utteranceMs: 120 };
  const voice = { name: '测试中文声音', lang: 'zh-CN', voiceURI: 'fixture-zh', localService: true };
  class Utterance { constructor(text) { this.text = text; } }
  const synth = {
    getVoices: () => [voice], addEventListener() {},
    speak(value) {
      mock.active = value; mock.started.push(value.text);
      value.onstart?.({ type: 'start' });
      value.timer = setTimeout(() => { if (mock.active === value) mock.active = null; mock.ended.push(value.text); value.onend?.({ type: 'end' }); }, mock.utteranceMs);
    },
    cancel() {
      mock.cancelled++; const previous = mock.active; mock.active = null;
      if (previous) { clearTimeout(previous.timer); setTimeout(() => previous.onend?.({ type: 'end' }), 20); }
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance });
}

function installClipboardMock() {
  window.__copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async text => { window.__copied.push(String(text)); },
  } });
}

function onePagePDF() {
  const content = 'BT /F1 12 Tf 72 720 Td (Resource library fixture) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n'; const offsets = [];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const start = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body);
}

await mkdir(results, { recursive: true });
const profile = await mkdtemp(join(results, 'workspace-profile-'));
const memoryRoot = join(profile, 'memory');
const uploadRoot = join(profile, 'uploads');
const docName = '项目资料[初稿].docx';
const uploadFiles = new Map([
  ['研究报告.pdf', onePagePDF()],
  [docName, Buffer.from('PK\x03\x04local docx original fixture\x00\xff', 'latin1')],
  ['资料正文.txt', Buffer.from('本地资料正文。\n资料库只保存原文件，尚未提取和摘要。', 'utf8')],
  ['参考图片.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64')],
]);
await mkdir(uploadRoot, { recursive: true });
for (const [name, bytes] of uploadFiles) await writeFile(join(uploadRoot, name), bytes);
const fixture = new MemoryStore(memoryRoot); fixture.close();
await mkdir(join(memoryRoot, '我的记忆库/wiki/主题'), { recursive: true });
await writeFile(join(memoryRoot, '我的记忆库/wiki/主题/测试知识.md'), '# 测试知识\n\n资料正文与引用。\n\n<script>window.__noteExecuted=true</script>\n\n[来源](https://example.org/source)\n');
let browser, cdp, server;
let browserLog = '';
const calls = [];
const openedResources = [];
let nextReplyGate = null;
function holdNextReply(fail = false) {
  let release;
  const gate = { fail, started: false, cancelled: false, promise: new Promise(resolveGate => { release = resolveGate; }) };
  gate.release = release;
  nextReplyGate = gate;
  return gate;
}
async function waitForReply(gate, signal) {
  gate.started = true;
  await new Promise((resolveGate, rejectGate) => {
    const abort = () => { gate.cancelled = true; rejectGate(new DOMException('已取消', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    gate.promise.then(() => { signal.removeEventListener('abort', abort); resolveGate(); });
    if (signal.aborted) abort();
  });
}
try {
  server = createServer({ memoryRoot, resourceOpenImpl: async (...args) => { openedResources.push(args); }, fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'deepseek-flash' }] });
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (url.endsWith('/search')) return Response.json({ results: [] });
    if (!body.stream) {
      const prompt = body.messages[0].content;
      const input = JSON.parse(body.messages.at(-1).content);
      if (prompt.includes('逐段核对摘要')) return Response.json({ choices: [{ message: { content: JSON.stringify({ approved: input.paragraphs.map(paragraph => paragraph.index), gaps: [] }) } }] });
      if (prompt.includes('你是资料摘要助手')) {
        const source = input.sources?.[0];
        const paragraphs = source ? [{ text: '这份资料记录了直接存入本地资料库的文件。', evidence: [{ sourceId: source.sourceId, quote: '这份文件直接放入本地资料库。' }] }] : input.drafts?.flatMap(draft => draft.paragraphs || []) || [];
        return Response.json({ choices: [{ message: { content: JSON.stringify({ paragraphs, gaps: [] }) } }] });
      }
      if (prompt.includes('知识覆盖检查')) return Response.json({ choices: [{ message: { content: JSON.stringify({ answerable: false, needsRefresh: false, claimIds: [], gaps: ['缺少原始证据'], queries: ['测试知识原始资料'], reason: '笔记尚未查证' }) } }] });
      if (prompt.includes('知识证据整理')) return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: '', pages: [], gaps: ['尚无法证实'] }) } }] });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ query: '测试知识原始资料', focus: '核实测试知识' }) } }] });
    }
    const gate = nextReplyGate; nextReplyGate = null;
    if (gate) {
      await waitForReply(gate, options.signal);
      if (gate.fail) return Response.json({ error: { message: 'fixture rate limit' } }, { status: 429 });
    }
    const taotao = body.messages.some(m => m.role === 'system' && m.content.includes('你是“滔滔”'));
    const content = taotao ? `连续讲述第${calls.length}段。第一句谈背景。第二句谈应用。` : `问答完成第${calls.length}次。可以交给管理员核查。`;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(await browserExecutable(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  browser.stderr.on('data', data => { browserLog = (browserLog + data).slice(-8000); });
  const port = await eventually(async () => Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'browser startup');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = await CDP.open(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await cdp.call('Page.enable'); await cdp.call('Runtime.enable');
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `(${installSpeechMock.toString()})()` });
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `(${installClipboardMock.toString()})()` });
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.navigate', { url: origin });
  const evaluate = code => cdp.evaluate(code);
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const input = (id, value) => evaluate(`(() => { const element = document.getElementById(${JSON.stringify(id)}); element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const check = (id, checked) => evaluate(`(() => { const element = document.getElementById(${JSON.stringify(id)}); element.checked = ${checked}; element.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const submit = async text => { await input('topic', text); await evaluate(`document.getElementById('composer').requestSubmit()`); };
  await eventually(() => evaluate(`document.readyState === 'complete' && !!document.getElementById('nav-chat')`), 'workspace startup');
  await sleep(200);
  assert.equal(await evaluate(`document.getElementById('settings-dialog').open`), false, 'settings are closed by default');
  for (const id of ['nav-chat', 'nav-agents', 'nav-library', 'nav-resources']) assert.ok(await evaluate(`!!document.getElementById('${id}')`));
  await click('settings-btn');
  assert.equal(await evaluate(`document.getElementById('settings-dialog').open`), true);
  await input('api-key', 'sk-workspace-fixture-only'); await click('connect-btn');
  await eventually(() => evaluate(`/已连接|连接成功/.test(document.getElementById('connection-status').textContent)`), 'DeepSeek connection');
  await check('web-search', false);
  await click('settings-close');
  const initialReply = holdNextReply();
  await submit('介绍测试知识。');
  await eventually(() => initialReply.started && evaluate(`!!document.querySelector('.message.assistant:last-child .activity-panel[open] .activity-steps [data-state="running"]')`), 'live activity appears before the answer');
  assert.equal(await evaluate(`document.querySelector('.message.assistant:last-child .message-body').textContent`), '', 'progress does not impersonate answer content');
  assert.ok(await evaluate(`document.querySelector('.message.assistant:last-child .activity-panel').textContent.includes('DeepSeek')`), 'the active model call is visible');
  const initialElapsed = await evaluate(`document.querySelector('.message.assistant:last-child .activity-elapsed').textContent`);
  await eventually(() => evaluate(`document.querySelector('.message.assistant:last-child .activity-elapsed').textContent !== ${JSON.stringify(initialElapsed)}`), 'elapsed time advances while a model response is pending', 3000);
  const waitingShot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(results, 'activity-waiting.png'), Buffer.from(waitingShot.data, 'base64'));
  initialReply.release();
  await eventually(() => evaluate(`document.getElementById('conversation').textContent.includes('问答完成')`), 'single Q&A answer');
  await eventually(() => evaluate(`!document.querySelector('.message.assistant:last-child .activity-panel').open && !document.querySelector('.message.assistant:last-child .activity-steps [data-state="running"]')`), 'completed activity folds and stops running');
  await evaluate(`document.querySelector('.message.assistant:last-child .activity-panel summary').click()`);
  assert.ok(await evaluate(`document.querySelector('.message.assistant:last-child .activity-steps').textContent.includes('笔记')`), 'completed steps retain the local lookup');
  const completeShot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(results, 'activity-complete.png'), Buffer.from(completeShot.data, 'base64'));
  const afterQA = calls.length;
  await sleep(900);
  assert.equal(calls.length, afterQA, 'Q&A does not automatically continue');
  assert.equal(await evaluate('__speech.started.length'), 0, 'Q&A is text by default');
  assert.ok(await evaluate(`document.querySelectorAll('#session-list .session-row').length >= 1`), 'chat history is visible');
  assert.ok(!(await evaluate('JSON.stringify(localStorage)')).includes('sk-workspace-fixture-only'));

  await click('nav-agents');
  await eventually(() => evaluate(`document.querySelectorAll('#agent-list .agent-row').length === 4`), 'four agent definitions');
  await evaluate(`document.querySelector('#agent-list .agent-row').click()`);
  assert.ok(await evaluate(`document.getElementById('agent-skills').textContent.length > 0`));
  assert.ok(await evaluate(`document.getElementById('agent-prompt').textContent.includes('你是')`));
  await click('nav-library');
  await eventually(() => evaluate(`document.querySelectorAll('#wiki-list .wiki-row').length >= 1`), 'Wiki list');
  await evaluate(`Array.from(document.querySelectorAll('#wiki-list .wiki-row')).find(row => row.textContent.includes('测试知识')).click()`);
  await eventually(() => evaluate(`document.getElementById('knowledge-content').textContent.includes('资料正文与引用')`), 'Wiki reading');
  assert.equal(await evaluate('window.__noteExecuted === true'), false, 'stored Markdown cannot execute HTML');
  const beforeHistory = calls.length;
  await click('nav-chat');
  await evaluate(`document.querySelector('#session-list .session-row').click()`);
  await eventually(() => evaluate(`document.getElementById('conversation').textContent.includes('问答完成')`), 'history restores content');
  await sleep(500);
  assert.equal(calls.length, beforeHistory, 'restoring history does not call the model');
  assert.ok(await evaluate(`document.querySelector('.message.assistant:last-child .activity-panel .activity-steps').children.length >= 2`), 'history restores activity without repeating work');

  const pausedReply = holdNextReply();
  await submit('暂停测试。');
  await eventually(() => pausedReply.started && evaluate(`!!document.querySelector('.message.assistant:last-child .activity-steps [data-state="running"]')`), 'a pending answer can be stopped');
  await click('pause-btn');
  await eventually(() => pausedReply.cancelled, 'pause aborts the pending upstream call');
  await eventually(() => evaluate(`!!document.querySelector('.message.assistant:last-child .activity-steps [data-state="cancelled"]')`), 'stopped work remains visible');
  const pausedTime = await evaluate(`document.querySelector('.message.assistant:last-child .activity-elapsed').textContent`);
  await sleep(1100);
  assert.equal(await evaluate(`document.querySelector('.message.assistant:last-child .activity-elapsed').textContent`), pausedTime, 'stopped activity no longer advances its timer');
  assert.equal(await evaluate(`document.querySelector('.message.assistant:last-child .message-body').textContent`), '', 'a stopped empty answer retains its process card');

  const failedReply = holdNextReply(true);
  await submit('失败测试。');
  await eventually(() => failedReply.started, 'failure fixture begins an actual model request');
  failedReply.release();
  await eventually(() => evaluate(`!!document.querySelector('.message.assistant:last-child .activity-steps [data-state="failed"]') && !document.getElementById('error-banner').hidden`), 'failed work is visible with its error');
  const failedTime = await evaluate(`document.querySelector('.message.assistant:last-child .activity-elapsed').textContent`);
  await sleep(1100);
  assert.equal(await evaluate(`document.querySelector('.message.assistant:last-child .activity-elapsed').textContent`), failedTime, 'failed activity no longer advances its timer');
  const beforeFailedHistory = calls.length;
  await click('nav-agents'); await click('nav-chat');
  await evaluate(`document.querySelector('#session-list .session-row').click()`);
  await eventually(() => evaluate(`!!document.querySelector('.message.assistant:last-child .activity-steps [data-state="failed"]')`), 'empty failed answers and their activity survive history restoration');
  assert.equal(calls.length, beforeFailedHistory, 'restoring failed activity does not retry a model call');

  await input('topic', '@');
  await eventually(() => evaluate(`document.querySelectorAll('#mention-menu .mention-option').length === 4 && !document.getElementById('mention-menu').hidden`), 'mention menu');
  await evaluate(`document.querySelector('#mention-menu .mention-option[data-agent="taotao"]').click()`);
  await click('settings-btn'); await check('web-search', false); await click('settings-close');
  await evaluate('__speech.utteranceMs = 450');
  const speechBeforeTaotao = await evaluate('__speech.started.length');
  await submit('@滔滔 继续讲测试知识。');
  await eventually(() => evaluate(`__speech.started.length > ${speechBeforeTaotao}`), '@Taotao starts reading the visible reply');
  const visibleActivityBeforePrefetch = await evaluate(`document.querySelectorAll('.message.assistant .activity-panel').length`);
  const prefetchedReply = holdNextReply();
  await eventually(() => prefetchedReply.started, 'Taotao prepares a following paragraph');
  assert.equal(await evaluate(`document.querySelectorAll('.message.assistant .activity-panel').length`), visibleActivityBeforePrefetch, 'background preparation does not insert a visible process card');
  prefetchedReply.release();
  await eventually(() => evaluate(`__speech.started.length >= ${speechBeforeTaotao + 4}`), '@Taotao speaks and continues');
  await click('pause-btn');
  const afterPause = calls.length;
  const speechAfterPause = await evaluate('__speech.started.length');
  await sleep(1000);
  assert.equal(calls.length, afterPause, 'pause stops continuation');
  assert.equal(await evaluate('__speech.started.length'), speechAfterPause, 'pause stops speech');
  await submit('@问答助手 再回答一个问题。');
  await eventually(() => evaluate(`document.querySelector('.message.assistant:last-child')?.textContent.includes('问答完成')`), '@Q&A routes a new turn');
  const mixed = await (await fetch(origin + '/api/memory/status')).json();
  const selected = mixed.sessions.find(s => s.title.includes('介绍测试知识'));
  const history = await (await fetch(origin + '/api/memory/history?id=' + selected.id)).json();
  const agents = history.messages.filter(m => m.role === 'assistant').map(m => m.agent);
  assert.ok(agents.includes('qa') && agents.includes('taotao'), 'one conversation can include different agents');
  await evaluate(`document.querySelector('.message.assistant:last-child button[data-action="collect"]').click()`);
  await eventually(() => evaluate(`document.getElementById('conversation').textContent.includes('知识库管理员')`), 'collection opens administrator dialogue');
  await eventually(async () => {
    const status = await (await fetch(origin + '/api/memory/status')).json();
    return status.sessions.some(s => s.agent === 'librarian');
  }, 'collection creates persisted administrator history');
  await eventually(() => evaluate(`document.querySelector('.message.assistant:last-child .activity-panel')?.textContent.includes('测试知识原始资料')`), 'administrator activity shows the actual search query');
  await sleep(300);
  const desktop = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(results, 'workspace-desktop.png'), Buffer.from(desktop.data, 'base64'));
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(150);
  const mobile = await evaluate(`({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth })`);
  assert.ok(mobile.document <= mobile.width + 1 && mobile.body <= mobile.width + 1, 'no mobile horizontal overflow');
  const mobileShot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(results, 'workspace-mobile.png'), Buffer.from(mobileShot.data, 'base64'));

  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const beforeResources = calls.length;
  let expectedResourceCalls = beforeResources;
  await click('nav-resources');
  await eventually(() => evaluate(`!document.getElementById('resources-view').hidden && !!document.getElementById('resource-upload')`), 'resource view opens');
  await cdp.call('DOM.enable');
  const documentNode = await cdp.call('DOM.getDocument');
  const fileInput = await cdp.call('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#resource-upload' });
  await cdp.call('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [...uploadFiles.keys()].map(name => join(uploadRoot, name)) });
  let resources;
  await eventually(async () => {
    resources = await (await fetch(origin + '/api/resources')).json();
    return resources.files?.filter(file => file.status === 'ready').length === uploadFiles.size;
  }, 'multi-file browser upload persists originals');
  await eventually(() => evaluate(`document.getElementById('resource-table').textContent.includes(${JSON.stringify(docName)})`), 'uploaded files appear in table');
  for (const file of resources.files) {
    const expected = uploadFiles.get(file.name); if (!expected) continue;
    const response = await fetch(new URL(file.downloadUrl, origin));
    assert.equal(response.status, 200, 'download uses a saved original');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, `${file.name} preserves its original bytes`);
  }
  await writeFile(join(memoryRoot, '资料库', '手放资料.md'), '# 文件夹资料\n\n这份文件直接放入本地资料库。\n');
  await click('resource-refresh');
  await eventually(() => evaluate(`document.getElementById('resource-table').textContent.includes('手放资料.md')`), 'refresh indexes a file copied directly into the local folder');
  assert.equal(calls.length, beforeResources, 'file storage and browsing do not contact a model');
  assert.equal(await evaluate(`document.querySelectorAll('#resource-list [data-resource-type]').length`), 0, 'resources are organized by folders');
  await click('resource-new-folder'); await input('resource-folder-name', '调研');
  await evaluate(`document.getElementById('resource-folder-form').requestSubmit()`);
  await eventually(() => evaluate(`!document.getElementById('resource-folder-dialog').open && !!document.querySelector('#resource-list [data-resource-folder="调研"]')`), 'a folder can be created from the library');
  await mkdir(join(memoryRoot, '资料库', '调研', '空目录'), { recursive: true });
  await click('resource-refresh');
  await eventually(() => evaluate(`!!document.querySelector('#resource-list [data-resource-folder="调研/空目录"]')`), 'nested empty folders are discovered');
  await evaluate(`document.querySelector('#resource-table button[data-resource-folder="调研"]').click()`);
  await eventually(() => evaluate(`!!document.querySelector('#resource-table button[data-resource-folder="调研/空目录"]') && !document.getElementById('resource-table').textContent.includes('研究报告.pdf')`), 'a folder shows only its immediate children');
  await evaluate(`document.querySelector('#resource-table button[data-resource-folder="调研/空目录"]').click()`);
  await eventually(() => evaluate(`!document.getElementById('resource-empty').hidden`), 'an empty folder remains browsable');
  await writeFile(join(uploadRoot, '目录资料.txt'), '文件夹里的本地资料');
  await cdp.call('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [join(uploadRoot, '目录资料.txt')] });
  await eventually(() => evaluate(`document.getElementById('resource-table').textContent.includes('目录资料.txt')`), 'uploads go into the current folder');
  assert.equal(await readFile(join(memoryRoot, '资料库', '调研', '空目录', '目录资料.txt'), 'utf8'), '文件夹里的本地资料');
  await click('resource-open-folder');
  await eventually(() => openedResources.some(args => JSON.stringify(args).includes('空目录')), 'the folder action opens the current local directory');
  await evaluate(`document.querySelector('#resource-list [data-resource-folder=""]').click()`);
  await input('list-search', '资料正文');
  await eventually(() => evaluate(`document.getElementById('resource-table').textContent.includes('资料正文.txt') && !document.getElementById('resource-table').textContent.includes('研究报告.pdf')`), 'resource name search');
  resources = await (await fetch(origin + '/api/resources')).json();
  const textFile = resources.files.find(file => file.name === '资料正文.txt');
  const docFile = resources.files.find(file => file.name === docName);
  const pdfFile = resources.files.find(file => file.name === '研究报告.pdf');
  const imageFile = resources.files.find(file => file.name === '参考图片.png');
  const chooseResource = file => evaluate(`document.querySelector('#resource-table button[data-resource-id="${file.id}"]').click()`);
  const summaryFile = resources.files.find(file => file.name === '手放资料.md');
  await input('list-search', ''); await chooseResource(summaryFile);
  await eventually(() => evaluate(`document.getElementById('resource-title').textContent === '手放资料.md'`), 'summary source opens');
  await evaluate(`(() => {
    const original = window.fetch;
    window.__extractCancelled = false;
    window.fetch = (path, options) => {
      if (String(path).endsWith('/extract')) {
        window.fetch = original;
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { window.__extractCancelled = true; reject(new DOMException('已停止', 'AbortError')); }, { once: true }));
      }
      return original(path, options);
    };
  })()`);
  await click('resource-extract');
  await eventually(() => evaluate(`document.getElementById('resource-extract').textContent === '停止'`), 'local extraction can be stopped');
  await click('resource-back');
  await eventually(() => evaluate(`window.__extractCancelled`), 'changing the document cancels extraction');
  await chooseResource(summaryFile);
  await eventually(() => evaluate(`document.getElementById('resource-title').textContent === '手放资料.md'`), 'the source reopens after cancellation');
  await click('resource-extract');
  await eventually(() => evaluate(`document.getElementById('resource-extraction-pages').textContent.includes('这份文件直接放入本地资料库')`), 'local extraction shows original paragraphs without an API call');
  assert.equal(calls.length, beforeResources, 'extracting a document does not call the model');
  const extractionShot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(results, 'resources-extraction-desktop.png'), Buffer.from(extractionShot.data, 'base64'));
  await click('resource-summarize');
  await eventually(() => evaluate(`document.getElementById('agent-picker').textContent.includes('资料摘要助手') && document.getElementById('resource-attachments').textContent.includes('手放资料.md')`), 'summarizing opens a conversation with its attached source');
  await submit('提炼这份文件的信息');
  await eventually(() => evaluate(`Array.from(document.querySelectorAll('.message.assistant .message-body')).some(node => node.textContent.includes('直接存入本地资料库')) && document.querySelectorAll('.message.assistant [data-action="collect"]').length`), 'the summary returns as a normal assistant reply');
  assert.ok(calls.some(call => call.body.messages?.[0].content.includes('你是资料摘要助手')), 'the selected summary agent runs');
  const summaryUser = await evaluate(`Array.from(document.querySelectorAll('.message.user .message-body')).at(-1).textContent`);
  assert.ok(summaryUser.includes('手放资料.md'), 'the user message preserves the selected document reference');
  const summaryLinks = await evaluate(`Array.from(document.querySelectorAll('.message.assistant .message-body a')).map(link => link.href)`);
  assert.ok(summaryLinks.some(url => url.includes(summaryFile.id) && url.includes('version=')), 'summary citations return to the original version');
  const summaryShot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(results, 'resources-summary-desktop.png'), Buffer.from(summaryShot.data, 'base64'));
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(120);
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= 321 && document.body.scrollWidth <= 321`), 'the cited summary and attachment composer fit a 320px phone');
  const summaryMobileShot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(results, 'resources-summary-mobile-320.png'), Buffer.from(summaryMobileShot.data, 'base64'));
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await submit('@问答助手');
  await eventually(() => evaluate(`document.getElementById('agent-picker').textContent.includes('问答助手') && document.getElementById('resource-attachments').textContent.includes('已移除资料')`), 'switching to a text agent clears attached documents explicitly');
  await click('attach-resource');
  await eventually(() => evaluate(`document.getElementById('resource-picker-dialog').open && document.getElementById('resource-picker-files').textContent.includes('资料正文.txt')`), 'a conversation can select local source files');
  await input('resource-picker-search', '资料正文');
  await evaluate(`document.querySelector('#resource-picker-files input').click()`); await click('resource-picker-confirm');
  assert.ok(await evaluate(`document.getElementById('resource-attachments').textContent.includes('资料正文.txt')`), 'file selection appears in the composer');
  assert.ok(await evaluate(`document.getElementById('agent-picker').textContent.includes('资料摘要助手')`), 'selecting documents routes to the document-reading agent');
  await evaluate(`document.querySelectorAll('#resource-attachments button').forEach(button => button.click())`);
  assert.equal(await evaluate(`document.getElementById('resource-attachments').hidden`), true, 'selected sources can be removed');
  await evaluate(`document.querySelector('.message.assistant:last-child [data-action="collect"]').click()`);
  await eventually(() => evaluate(`document.getElementById('agent-picker').textContent.includes('知识库管理员') && !!document.querySelector('.message.assistant[data-agent="librarian"] .activity-panel[data-state="complete"]')`), 'a document summary hands its sources to the administrator conversation');
  expectedResourceCalls = calls.length;
  await click('nav-resources'); await input('list-search', '资料正文');
  await evaluate(`document.querySelector('#resource-table button[data-resource-id="${textFile.id}"]').focus()`);
  assert.equal(await evaluate(`document.activeElement?.dataset.resourceId`), textFile.id, 'file buttons receive keyboard focus');
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await eventually(() => evaluate(`document.getElementById('resource-preview').textContent.includes('本地资料正文')`), 'plain text previews as text');
  await input('list-search', '研究报告');
  await eventually(() => evaluate(`!document.getElementById('resource-overview').hidden && document.getElementById('resource-table').textContent.includes('研究报告.pdf') && !document.getElementById('resource-table').textContent.includes('资料正文.txt')`), 'searching from a preview returns to matching files');
  await input('list-search', '');
  await chooseResource(pdfFile);
  await eventually(() => evaluate(`!!document.querySelector('#resource-preview iframe') && document.querySelector('#resource-preview iframe').src.includes('${pdfFile.id}')`), 'PDF uses the saved file in its preview');
  await click('resource-back'); await chooseResource(imageFile);
  await eventually(() => evaluate(`(() => { const image = document.querySelector('#resource-preview img'); return image?.complete && image.naturalWidth === 1; })()`), 'image preview loads the original');
  await click('resource-back'); await chooseResource(docFile);
  await eventually(() => evaluate(`document.getElementById('resource-title').textContent.includes(${JSON.stringify(docName)})`), 'Office document details open');
  await click('resource-open');
  await eventually(() => openedResources.some(args => JSON.stringify(args).includes(docName)), 'open uses the selected original through the injected native opener');
  await click('resource-copy');
  const copied = await eventually(() => evaluate('window.__copied.at(-1)'), 'resource reference copies');
  assert.ok(copied.includes(docFile.id) && copied.includes(`version=${docFile.version}`), 'resource references bind a stable ID and version');
  assert.ok(copied.includes('项目资料\\[初稿\\].docx'), 'resource references escape brackets in file names');
  assert.ok(await evaluate(`document.getElementById('resource-download').href.includes('${docFile.id}')`));
  await click('resource-open-folder');
  await eventually(() => openedResources.length >= 2, 'the library folder uses the injected opener');

  const resourceURL = `${origin}/?resource=${textFile.id}&version=${textFile.version}`;
  await writeFile(join(memoryRoot, '我的记忆库/wiki/主题/测试知识.md'), `# 测试知识\n\n资料正文与引用。\n\n[资料原件](${resourceURL})\n\n${copied}\n`);
  await click('nav-library');
  await eventually(() => evaluate(`Array.from(document.querySelectorAll('#wiki-list .wiki-row')).some(row => row.textContent.includes('测试知识'))`), 'resource citation note is indexed');
  await evaluate(`Array.from(document.querySelectorAll('#wiki-list .wiki-row')).find(row => row.textContent.includes('测试知识')).click()`);
  await eventually(() => evaluate(`Array.from(document.querySelectorAll('#knowledge-content a')).some(link => link.textContent === '资料原件')`), 'knowledge renders its document reference');
  await eventually(() => evaluate(`Array.from(document.querySelectorAll('#knowledge-content a')).some(link => link.textContent === ${JSON.stringify(docName)})`), 'Markdown renders a copied reference with literal brackets in its file name');
  await evaluate(`Array.from(document.querySelectorAll('#knowledge-content a')).find(link => link.textContent === ${JSON.stringify(docName)}).click()`);
  await eventually(() => evaluate(`!document.getElementById('resources-view').hidden && document.getElementById('resource-title').textContent === ${JSON.stringify(docName)}`), 'escaped-name references open their original resource');
  await click('nav-library');
  await evaluate(`Array.from(document.querySelectorAll('#wiki-list .wiki-row')).find(row => row.textContent.includes('测试知识')).click()`);
  await eventually(() => evaluate(`Array.from(document.querySelectorAll('#knowledge-content a')).some(link => link.textContent === '资料原件')`), 'knowledge source note reopens');
  await evaluate(`Array.from(document.querySelectorAll('#knowledge-content a')).find(link => link.textContent === '资料原件').click()`);
  await eventually(() => evaluate(`!document.getElementById('resources-view').hidden && document.getElementById('resource-preview').textContent.includes('本地资料正文')`), 'knowledge references open the source resource');

  await cdp.call('Page.navigate', { url: resourceURL });
  await eventually(() => evaluate(`!document.getElementById('resources-view').hidden && document.getElementById('resource-preview').textContent.includes('本地资料正文')`), 'resource permalink opens directly after a fresh page load');
  const updatedText = '更新后的本地资料正文。\n这份原件已经改写，旧版本引用需要由用户选择查看当前版本。';
  await writeFile(join(memoryRoot, '资料库', textFile.name), updatedText);
  await click('resource-refresh');
  await eventually(() => evaluate(`document.getElementById('resource-preview').textContent.includes('版本已更新')`), 'refreshing a cited preview reports an external file change');
  assert.ok(await evaluate(`document.getElementById('resource-download').hidden && !document.getElementById('resource-preview').textContent.includes('更新后的本地资料正文')`), 'a stale citation does not silently substitute the new document');
  await evaluate(`Array.from(document.querySelectorAll('#resource-preview button')).find(button => button.textContent === '当前版本').click()`);
  await eventually(() => evaluate(`document.getElementById('resource-preview').textContent.includes('更新后的本地资料正文')`), 'the current version is shown only after explicit selection');
  await click('resource-back'); await input('list-search', '');
  const resourceDesktop = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(results, 'resources-desktop.png'), Buffer.from(resourceDesktop.data, 'base64'));
  const resourceMobile = [];
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  for (const width of [390, 320]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(120);
    const dimensions = await evaluate(`({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth })`);
    assert.ok(dimensions.document <= width + 1 && dimensions.body <= width + 1, `resource view fits ${width}px`);
    assert.ok(await evaluate(`matchMedia('(pointer: coarse)').matches`), 'touch layout uses coarse pointer mode');
    const touchTargets = await evaluate(`Array.from(document.querySelectorAll('#resources-view button, #resources-view a')).filter(element => element.getClientRects().length).map(element => { const rect = element.getBoundingClientRect(); return { text: element.textContent, width: rect.width, height: rect.height }; })`);
    assert.ok(touchTargets.every(target => target.width >= 44 && target.height >= 44), 'resource touch targets are at least 44px');
    resourceMobile.push(dimensions);
    const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(results, `resources-mobile-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  await cdp.call('Page.navigate', { url: resourceURL });
  await eventually(() => evaluate(`!document.getElementById('resources-view').hidden && document.getElementById('resource-preview').textContent.includes('版本已更新')`), 'an old-version permalink preserves its version mismatch after reload');
  await eventually(() => evaluate(`document.getElementById('resource-count').textContent.includes('5')`), 'a stale permalink still loads the actual library count');
  const versionShot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(results, 'resources-version-warning.png'), Buffer.from(versionShot.data, 'base64'));
  await evaluate(`Array.from(document.querySelectorAll('#resource-preview button')).find(button => button.textContent === '当前版本').click()`);
  await eventually(() => evaluate(`document.getElementById('resource-preview').textContent.includes('更新后的本地资料正文')`), 'a stale permalink can explicitly open the latest document');
  assert.equal(calls.length, expectedResourceCalls, 'permalinks and library actions do not start an AI task');
  assert.deepEqual(cdp.exceptions, [], 'no unhandled browser exceptions');
  const report = { passed: true, checks: ['four navigation views', 'settings drawer', 'Q&A single answer', 'key privacy', 'agent skills and prompt', 'Wiki reading and HTML safety', 'history restoration without generation', '@agent menu and routing', 'Taotao continuation and pause', 'mixed agent conversation', 'collection handoff conversation', 'mobile layout', 'live activity before answer', 'completed and restored activity', 'cancelled and failed activity persistence', 'stopped activity timers', 'background preparation stays hidden', 'administrator search query activity', 'resource upload and original bytes', 'resource folders, empty directories, uploads and preview', 'local extraction and cancellation', 'cited document summary and administrator handoff', 'document picker and agent boundaries', 'resource native open and escaped reference', 'resource links from knowledge', 'resource permalink and mobile layout', 'resource version mismatch and explicit current version'], mobile, resourceMobile, screenshots: ['workspace-desktop.png', 'workspace-mobile.png', 'activity-waiting.png', 'activity-complete.png', 'resources-desktop.png', 'resources-extraction-desktop.png', 'resources-summary-desktop.png', 'resources-summary-mobile-320.png', 'resources-mobile-390.png', 'resources-mobile-320.png', 'resources-version-warning.png'] };
  await writeFile(join(results, 'workspace-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (cdp) {
    try { console.error('Workspace state:', JSON.stringify(await cdp.evaluate(`({ text:document.body.innerText.slice(-4000), error:document.getElementById('error-banner')?.textContent })`))); } catch {}
  }
  console.error(browserLog.slice(-1000));
  throw error;
} finally {
  if (cdp) { await cdp.call('Browser.close').catch(() => {}); cdp.socket.close(); }
  if (browser && browser.exitCode === null) { const exited = once(browser, 'exit').catch(() => {}); browser.kill(); await Promise.race([exited, sleep(2000)]); }
  if (server) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
  const target = resolve(profile);
  assert.ok(target.startsWith(resolve(results) + sep) && target.includes('workspace-profile-'));
  await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
