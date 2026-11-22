import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { createServer } from './server.mjs';

const installed = existsSync(new URL('./vendor/harness2/harness2/core/schedule.py', import.meta.url));

test('Harness² runs the Google scheduler through chat, cites Wiki and reuses accepted experience',
  { skip: installed ? false : 'Google Harness² source is optional. See README.' }, async t => {
  const temporaryRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryRoot, 'taotao-harness-test-'));
  const wikiPath = 'wiki/保修期限.md';
  const note = '适用范围内，保修期限为 30 天。';
  let useMemory = true, preferFinal = true, calls = 0, withPrior = false;
  const mock = async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(options.body);
    const system = body.messages[0].content;
    const input = JSON.parse(body.messages[1].content);
    assert.equal(body.model, 'fixture');
    calls++;
    let output;
    if (system.startsWith('你正在调整')) {
      withPrior ||= input.prior_experience.some(value => value.lesson.includes('先核对期限'));
      output = { prompt: '先核对期限，写出适用条件后附 Wiki 引用。', notes: '注明期限和条件' };
    } else if (system.startsWith('对比 base1')) {
      assert.ok(Object.keys(input.rollouts).some(path => path.endsWith('/c1.md')));
      output = { prefer: preferFinal ? 'final' : 'base', cue: '带期限的问题', lesson: '先核对期限',
        evidence: '候选保留了证据明确支持的条件' };
    } else {
      assert.equal(input.wiki.length, useMemory ? 1 : 0);
      if (useMemory) assert.ok(input.wiki[0].content.includes(note));
      output = { answer: useMemory && system.includes('先核对期限') ? note + ' 〔Wiki 1〕' : '需要确认适用期限。' };
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
  };
  const server = createServer({ memoryRoot: root, fetchImpl: mock });
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (dirname(root) === temporaryRoot && basename(root).startsWith('taotao-harness-test-')) {
      await rm(root, { recursive: true, force: true, maxRetries: 2 });
    }
  });
  const notes = join(root, '我的记忆库', 'wiki');
  await mkdir(notes, { recursive: true });
  await writeFile(join(notes, '保修期限.md'), '# 保修期限\n\n' + note);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const agents = await (await fetch(base + '/api/agents')).json();
  assert.equal(agents.agents.find(item => item.id === 'harness2').name, 'Wiki 对照助手');

  async function ask() {
    const question = '保修期限是多少？';
    const sessionId = randomUUID();
    if (useMemory) {
      const saved = await post('/api/memory/user', { sessionId, id: randomUUID(), content: question, agent: 'harness2' });
      assert.equal(saved.status, 200);
    }
    const reply = await post('/api/chat', {
      apiKey: 'fixture-key', model: 'fixture', agent: 'harness2', webSearch: true,
      messages: [{ role: 'user', content: question }],
      ...(useMemory ? { memory: { sessionId, id: randomUUID(), visible: true, curate: false } } : {}),
    });
    const wire = await reply.text();
    assert.equal(reply.status, 200, wire);
    assert.match(wire, /data: \[DONE\]/, wire);
    const frames = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    const text = frames.find(frame => frame.choices)?.choices[0].delta.content;
    assert.ok(text, JSON.stringify(frames));
    return { text, frames };
  }

  const first = await ask();
  assert.ok(first.text.includes(note));
  assert.ok(first.text.includes('[[' + wikiPath + ']]'));
  assert.ok(first.frames.some(frame => frame.activity?.detail?.includes('已保存可复用经验')));
  assert.equal(calls, 8);
  const library = join(root, 'data', 'harness2');
  assert.equal((await readdir(library)).length, 1);
  assert.equal(withPrior, false);

  preferFinal = false;
  assert.equal((await ask()).text, '需要确认适用期限。');
  assert.equal(withPrior, true);
  assert.equal((await readdir(library)).length, 1);

  useMemory = false;
  withPrior = false;
  assert.equal((await ask()).text, '需要确认适用期限。');
  assert.equal(withPrior, false);
  assert.equal((await readdir(library)).length, 1);
});
