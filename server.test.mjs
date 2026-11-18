import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createServer } from './server.mjs';
import { conversationContext } from './agents.mjs';

async function start(t, fetchImpl) {
  const server = createServer({ fetchImpl, memoryRoot: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, extra = {}) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...extra },
    body: JSON.stringify(body),
  });
  return { base, post };
}

const valid = { apiKey: 'sk-test-only', model: 'deepseek-flash', webSearch: false, messages: [{ role: 'user', content: '你好' }] };
const online = { ...valid, webSearch: true, messages: [{ role: 'user', content: '查一下月球基地的供电方案' }],
  research: { task: '查一下月球基地的供电方案', queries: [], seenUrls: [], notes: '', round: 0 } };
const sse = 'data: {"choices":[{"delta":{"content":"新资料指出月球供电需要储能。[1]"}}]}\n\ndata: [DONE]\n\n';
const plan = (query = '月球基地 供电 储能 官方研究') => Response.json({ choices: [{ message: { content: JSON.stringify({ query, focus: '比较月球基地供电和储能的实际限制' }) } }] });
const found = (url = 'https://science.nasa.gov/moon/energy') => Response.json({ results: [
  { title: '月球基地供电研究', url, summary: '夜间需要可靠储能，以保障基地供电。', content: '官方资料介绍了太阳能、储能和月夜供电的限制。', date: '2026-10-01T00:00:00Z' },
] });
const answer = () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
const frames = text => text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));

test('agent context policies isolate continuation and retain complete Q&A context within budget', () => {
  const history = [{ role: 'user', content: '请解释原理' }, { role: 'assistant', content: '完整回答'.repeat(800) }];
  const qa = conversationContext('qa', history, '未展示的下一段');
  assert.deepEqual(qa, history);
  const taotao = conversationContext('taotao', history, '下一段的前文');
  assert.equal(taotao.at(-2).content, '下一段的前文');
  assert.match(taotao.at(-1).content, /应用自动续讲/);
  const recent = conversationContext('qa', Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: String(i).repeat(5000) })));
  assert.ok(recent.reduce((n, m) => n + m.content.length, 0) <= 16000);
  assert.equal(recent.at(-1).content, '9'.repeat(4000));
});

test('health, same-origin restrictions, traversal and validation never contact upstream', async t => {
  const { base, post } = await start(t, () => { throw new Error('Must not contact upstream'); });
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { app: 'taotao-local', version: 'policy-v11' });
  assert.equal((await fetch(`${base}/agents.mjs`)).status, 200);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${base}/health`, { headers: { Host: 'attacker.example' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await post('/api/models', valid, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/server.mjs`)).status, 404);
  assert.equal((await post('/api/chat', { ...valid, apiKey: 'sk-bad\r\nvalue' })).status, 400);
  for (const agent of ['missing', '__proto__', null, {}]) assert.equal((await post('/api/chat', { ...valid, agent })).status, 400);
  assert.equal((await post('/api/chat', { ...valid, messages: Array(25).fill(valid.messages[0]) })).status, 400);
  assert.equal((await post('/api/chat', { ...valid, messages: [{ role: 'tool', content: 'x' }] })).status, 400);
  assert.equal((await post('/api/chat', { ...valid, messages: [{ role: 'user', content: 'x'.repeat(110000) }] })).status, 413);
  for (const research of [
    { ...online.research, notes: [] },
    { ...online.research, round: -1 },
    { ...online.research, queries: ['x'.repeat(129)] },
    { ...online.research, seenUrls: ['javascript:alert(1)'] },
    { ...online.research, seenUrls: ['https://user:password@example.org'] },
  ]) assert.equal((await post('/api/chat', { ...online, research })).status, 400);
  assert.equal((await post('/api/chat', { ...online, webSearch: 'true' })).status, 400);
});

test('models return only IDs, streaming uses bounded non-thinking requests', async t => {
  const sse = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  const { post } = await start(t, async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${valid.apiKey}`);
    if (url.endsWith('/models')) {
      assert.equal(options.method, 'GET');
      return Response.json({ data: [{ id: 'deepseek-flash', secret: 'not exposed' }, { id: null }] });
    }
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 800);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(body.messages.slice(2), valid.messages);
    assert.match(body.messages[1].content, /你是“滔滔”/);
    assert.match(body.messages[0].content, /没有调用网页搜索/);
    assert.ok(!options.body.includes(valid.apiKey));
    return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  assert.deepEqual(await (await post('/api/models', valid)).json(), { data: [{ id: 'deepseek-flash' }] });
  const response = await post('/api/chat', valid);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /event-stream/);
  const text = await response.text();
  assert.deepEqual(frames(text).filter(frame => frame.choices), frames(sse));
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  assert.ok(frames(text).some(frame => frame.activity?.state === 'complete'));
});

test('Q&A agent answers once with its own policy and only searches when enabled', async t => {
  const calls = [];
  const { post } = await start(t, async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (url.endsWith('/search')) return found();
    if (!body.stream) {
      assert.match(body.messages[0].content, /当前问题/);
      return plan();
    }
    assert.equal(body.max_tokens, 2400);
    assert.match(JSON.stringify(body.messages), /只回答这一次/);
    assert.doesNotMatch(JSON.stringify(body.messages), /约250至350|应用自动续讲/);
    return answer();
  });
  const request = { ...valid, agent: 'qa', messages: [{ role: 'system', content: '错误的旧页面续讲规则' }, ...valid.messages] };
  delete request.webSearch;
  assert.match(await (await post('/api/chat', request)).text(), /\[DONE\]/);
  assert.equal(calls.length, 1, 'Q&A defaults to local context without a search');
  assert.doesNotMatch(JSON.stringify(calls[0].body.messages), /错误的旧页面续讲规则/);
  assert.match(await (await post('/api/chat', { ...request, webSearch: true })).text(), /research/);
  assert.equal(calls.length, 4, 'one plan, one search and one answer, with no follow-up task');
});

test('research plans, searches, then answers with real source metadata and a bounded checkpoint', async t => {
  const calls = [];
  const { post } = await start(t, async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, `Bearer ${valid.apiKey}`);
    assert.ok(!options.body.includes(valid.apiKey));
    calls.push({ url, body });
    if (url.endsWith('/v1/tools/search')) {
      assert.deepEqual(body, { query: '月球基地 供电 储能 官方研究', count: 5, need_content: true });
      const result = await found().json();
      result.results.push(result.results[0]);
      result.results.push({ url: 'javascript:alert(1)', title: '恶意链接', content: '不可采用' });
      result.results.push({ url: 'https://name:password@example.org', content: '不可采用' });
      result.results.push({ url: 'https://example.org/empty', title: '没有内容' });
      return Response.json(result);
    }
    if (!body.stream) return plan();
    assert.match(JSON.stringify(body.messages), /官方资料介绍了太阳能/);
    assert.match(body.messages[0].content, /不可信参考数据/);
    assert.equal(body.messages.at(-1).role, 'user');
    assert.match(body.messages.at(-1).content, /月球基地/);
    return answer();
  });
  const request = { ...online };
  delete request.webSearch; // Research is on unless explicitly disabled.
  const response = await post('/api/chat', request);
  const data = frames(await response.text());
  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['completions', 'search', 'completions']);
  assert.deepEqual(data.filter(frame => frame.research_status).map(frame => frame.research_status.stage), ['planning', 'searching', 'writing']);
  const research = data.find(frame => frame.research).research;
  assert.equal(research.sources.length, 1);
  assert.equal(research.sources[0].url, 'https://science.nasa.gov/moon/energy');
  assert.ok(!('content' in research.sources[0]));
  assert.equal(research.checkpoint.round, 1);
  assert.equal(research.checkpoint.task, online.research.task);
  assert.deepEqual(research.checkpoint.queries, ['月球基地 供电 储能 官方研究']);
  assert.deepEqual(research.checkpoint.seenUrls, ['https://science.nasa.gov/moon/energy']);
  assert.match(research.checkpoint.notes, /官方资料介绍/);
  assert.ok(data.findIndex(frame => frame.research) < data.findIndex(frame => frame.choices));
});

test('history constrains the next query; repeated sources get one new direction, never unbounded retries', async t => {
  let searches = 0;
  let plans = 0;
  let answers = 0;
  const previous = { ...online.research, round: 4, queries: ['月球基地 早期方案'],
    seenUrls: ['https://science.nasa.gov/moon/energy'], notes: '已有资料说明月夜供电困难。'.repeat(300).slice(0, 5900) };
  const { post } = await start(t, async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/search')) { searches++; return searches === 1 ? found() : found('https://www.esa.int/moon/power'); }
    if (!body.stream) {
      plans++;
      assert.match(body.messages[1].content, /早期方案/);
      assert.match(body.messages[1].content, /月夜供电困难/);
      return plan(plans === 1 ? '月球基地 供电 储能 官方研究' : '月球基地 月夜 核能 ESA');
    }
    answers++; return answer();
  });
  const data = frames(await (await post('/api/chat', { ...online, research: previous })).text());
  const research = data.find(frame => frame.research).research;
  assert.equal(searches, 2);
  assert.equal(plans, 2);
  assert.equal(answers, 1);
  assert.equal(research.checkpoint.round, 5);
  assert.equal(research.sources[0].url, 'https://www.esa.int/moon/power');
  assert.ok(research.checkpoint.notes.length <= 6000);
  assert.equal(research.checkpoint.task, previous.task);
});

test('empty search or duplicate planning stops without generating unsupported answers', async t => {
  for (const repeated of [false, true]) await t.test(repeated ? 'duplicate queries' : 'no results', async t => {
    let plans = 0, searches = 0, answers = 0;
    const { post } = await start(t, async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/search')) { searches++; return Response.json({ results: [] }); }
      if (!body.stream) { plans++; return plan(repeated ? '已经查过' : `月球 供电 第${plans}方向`); }
      answers++; return answer();
    });
    const response = await post('/api/chat', { ...online, research: { ...online.research, queries: repeated ? ['已经查过'] : [] } });
    const data = frames(await response.text());
    assert.match(data.at(-1).error, /没有找到新的可用资料/);
    assert.equal(plans, 2);
    assert.equal(searches, repeated ? 0 : 2);
    assert.equal(answers, 0);
    assert.ok(!data.some(frame => frame.research || frame.choices));
  });
});

test('search authentication/rate failures never fall back or expose the API key', async t => {
  for (const status of [401, 402, 429]) await t.test(String(status), async t => {
    let calls = 0;
    const { post } = await start(t, async (url, options) => {
      calls++;
      if (url.endsWith('/search')) return new Response(valid.apiKey, { status });
      assert.equal(JSON.parse(options.body).stream, false);
      return plan();
    });
    const text = await (await post('/api/chat', online)).text();
    assert.equal(calls, 2);
    assert.ok(frames(text).at(-1).error);
    assert.ok(!text.includes(valid.apiKey));
    assert.ok(!frames(text).some(frame => frame.choices));
  });
});

test('browser cancellation stops planning, search and answer stages and prevents later calls', async t => {
  for (const stage of ['planning', 'searching', 'writing']) await t.test(stage, async t => {
    let markStarted, markCancelled;
    const started = new Promise(resolve => { markStarted = resolve; });
    const cancelled = new Promise(resolve => { markCancelled = resolve; });
    let calls = 0;
    const { base } = await start(t, async (url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      const currentStage = url.endsWith('/search') ? 'searching' : body.stream ? 'writing' : 'planning';
      if (currentStage !== stage) return currentStage === 'planning' ? plan() : found();
      markStarted();
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => { markCancelled(); reject(options.signal.reason); }, { once: true });
      });
    });
    const controller = new AbortController();
    const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(online), signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    await started;
    const before = calls;
    controller.abort();
    await Promise.race([cancelled, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${stage} was not cancelled`)), 1500); timer.unref();
    })]);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls, before);
  });
});

test('upstream failures are readable without reflecting credentials', async t => {
  const { post } = await start(t, async () => new Response(valid.apiKey, { status: 401 }));
  const response = await post('/api/chat', valid);
  assert.equal(response.status, 200);
  const body = frames(await response.text()).at(-1);
  assert.match(body.error, /API Key/);
  assert.ok(!JSON.stringify(body).includes(valid.apiKey));
});

test('browser cancellation aborts the upstream request', async t => {
  let markCancelled;
  const cancelled = new Promise(resolve => { markCancelled = resolve; });
  const { base } = await start(t, async (_url, options) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
        options.signal.addEventListener('abort', () => {
          markCancelled();
          controller.error(new Error('Aborted'));
        }, { once: true });
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const controller = new AbortController();
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(valid), signal: controller.signal,
  });
  await response.body.getReader().read();
  controller.abort();
  await Promise.race([cancelled, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Upstream was not cancelled')), 1500);
    timer.unref();
  })]);
});
