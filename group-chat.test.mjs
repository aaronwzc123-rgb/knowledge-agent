import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { parseAgentMentions } from './agents.mjs';
import { createServer } from './server.mjs';

test('group turns use their own guidance and require everyone to accept the latest proposal', async t => {
  const temporary = await realpath(tmpdir());
  const root = await mkdtemp(join(temporary, 'taotao-group-'));
  const calls = [];
  const replies = [
    { reply: '先验证需求。', proposal: '小范围上线。', accept: false },
    { reply: '上线前应设定止损条件。', proposal: '试点两周，成本超限就退出。', accept: false },
    { reply: '还需要考虑参与者的反馈。', proposal: '', accept: true },
    { reply: '两周能验证假设，我同意。', proposal: '', accept: true },
    { reply: '预算减半后，可以缩小试点规模。', proposal: '', accept: true },
    '',
    '~~~json\n{"reply":"可以先找三位使用者。","proposal":"只招募三位使用者。","accept":false}\n~~~',
    '这个范围合理，我同意。',
    { reply: '三位就够做第一轮访谈。', proposal: null, accept: true },
    { reply: '我同意先做访谈。', accept: true },
  ];
  const server = createServer({ memoryRoot: root, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const payload = JSON.parse(init.body);
    assert.deepEqual(payload.response_format, { type: 'json_object' });
    calls.push(payload);
    const reply = replies.shift();
    assert.notEqual(reply, undefined);
    return Response.json({ choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] });
  } });
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (dirname(root) === temporary && basename(root).startsWith('taotao-group-')) {
      await rm(root, { recursive: true, force: true, maxRetries: 2 });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const { ids: participants, text: question } = parseAgentMentions('＠乐观主义者@现实主义者 @理想主义者 @乐观 如何试点？');
  assert.deepEqual(participants, ['optimist', 'realist', 'idealist']);
  assert.equal(question, '如何试点？');
  assert.deepEqual(parseAgentMentions('a@qa.example').ids, []);
  for (const id of [...participants, 'pessimist']) {
    const config = await fetch(base + '/api/agents/' + id).then(response => response.json());
    assert.equal(Object.keys(config.components).length, 8);
    assert.equal(typeof config.components.system, 'string');
    assert.match(await readFile(join(root, '我的记忆库', config.files.system), 'utf8'), /你是/u);
  }
  await writeFile(join(root, '我的记忆库', '指导', '乐观主义者.md'), '自定义乐观视角');

  const sessionId = randomUUID();
  let userId = randomUUID();
  assert.equal((await post('/api/memory/user', { sessionId, id: userId, content: question, agent: 'optimist', participants })).status, 200);
  const messages = [{ role: 'user', content: question }];
  let proposal = '', accepted = [];
  const request = (agent, forUser = userId) => post('/api/chat', {
    agent, apiKey: 'fixture-key', model: 'fixture', messages, webSearch: true,
    discussion: { participants, userId: forUser, proposal, accepted },
    memory: { sessionId, id: randomUUID(), visible: true, curate: false },
  });
  assert.equal((await request('optimist', randomUUID())).status, 409);
  async function speak(agent, expected) {
    const response = await request(agent);
    const stream = await response.text();
    assert.equal(response.status, 200, stream);
    assert.match(stream, /data: \[DONE\]/u, stream);
    const result = stream.split('\n').filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6))).find(event => event.discussion);
    assert.deepEqual(result.discussion, expected);
    ({ proposal, accepted } = result.discussion);
    messages.push({ role: 'assistant', agent, content: result.choices[0].delta.content });
    return stream;
  }
  for (const [agent, expected] of [
    ['optimist', { proposal: '小范围上线。', accepted: ['optimist'], consensus: false }],
    ['realist', { proposal: '试点两周，成本超限就退出。', accepted: ['realist'], consensus: false }],
    ['idealist', { proposal: '试点两周，成本超限就退出。', accepted: ['realist', 'idealist'], consensus: false }],
    ['optimist', { proposal: '试点两周，成本超限就退出。', accepted: ['realist', 'idealist', 'optimist'], consensus: true }],
  ]) {
    await speak(agent, expected);
  }
  assert.match(calls[0].messages[0].content, /自定义乐观视角/u);
  const history = await fetch(base + '/api/memory/history?id=' + sessionId).then(response => response.json());
  assert.deepEqual(JSON.parse(history.messages[0].participants), participants);
  assert.deepEqual(history.messages.slice(1).map(message => message.agent), ['optimist', 'realist', 'idealist', 'optimist']);
  assert.match(history.messages.at(-1).content, /达成共识[\s\S]+试点两周/u);

  userId = randomUUID();
  const followUp = '如果预算减半呢？';
  assert.equal((await post('/api/memory/user', { sessionId, id: userId, content: followUp, agent: 'optimist', participants })).status, 200);
  messages.push({ role: 'user', content: followUp });
  proposal = ''; accepted = [];
  const firstReply = await speak('optimist', { proposal: '', accepted: [], consensus: false });
  assert.match(firstReply, /预算减半后，可以缩小试点规模/u);
  assert.equal(JSON.parse(calls[1].messages[1].content).currentDiscussion.at(-1).speaker, '乐观主义者');
  const input = JSON.parse(calls[4].messages[1].content);
  assert.equal(input.topic, followUp);
  assert.deepEqual(input.currentDiscussion, []);
  assert.match(input.priorConversation.at(-1).content, /达成共识/u);
  const newProposal = '只招募三位使用者。';
  const retried = await speak('realist', { proposal: newProposal, accepted: ['realist'], consensus: false });
  assert.match(retried, /重新准备发言/u);
  await speak('idealist', { proposal: newProposal, accepted: ['realist'], consensus: false });
  await speak('optimist', { proposal: newProposal, accepted: ['realist', 'optimist'], consensus: false });
  await speak('idealist', { proposal: newProposal, accepted: ['realist', 'optimist', 'idealist'], consensus: true });
  assert.equal(replies.length, 0);
  const final = await fetch(base + '/api/memory/history?id=' + sessionId).then(response => response.json());
  const followUpMessages = final.messages.slice(final.messages.findIndex(message => message.id === userId) + 1);
  assert.equal(followUpMessages.length, 5);
  assert.ok(followUpMessages.every(message => message.status === 'complete'));
});
