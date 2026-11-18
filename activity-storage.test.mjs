import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from './memory.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'taotao-activity-storage-'));
  const store = new MemoryStore(root);
  const sessionId = randomUUID(), userId = randomUUID(), messageId = randomUUID();
  store.saveUser({ sessionId, id: userId, content: '查询APEC资料。', agent: 'qa' });
  store.beginAssistant(sessionId, messageId, true, 'qa');
  t.after(() => {
    try { store.close(); } catch {}
    const path = resolve(root);
    assert.ok(path.startsWith(resolve(tmpdir()) + sep) && path.includes('taotao-activity-storage-'));
    rmSync(path, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  return { root, store, sessionId, userId, messageId };
}

const event = (extra = {}) => ({ id: 'search-1', kind: 'search', state: 'running', title: '联网搜索', detail: 'APEC是什么',
  at: '2026-11-17T01:00:00.000Z', startedAt: '2026-11-17T01:00:00.000Z', ...extra });

test('activity updates retain one operation and survive history, raw export and restart', t => {
  const { root, store, sessionId, messageId } = fixture(t);
  store.activity(messageId, event());
  store.activity(messageId, event({ state: 'complete', at: '2026-11-17T01:00:02.000Z', elapsedMs: 2000,
    items: [{ label: 'APEC原始资料', url: 'https://example.org/apec' }, { label: 'APEC是什么', path: 'wiki/主题/APEC是什么.md' }] }));
  store.append(messageId, 'APEC是亚太经济合作组织。');
  store.finish(messageId, 'complete');
  const history = store.history(sessionId).messages.find(message => message.id === messageId);
  const activity = JSON.parse(history.activity);
  assert.equal(activity.length, 1);
  assert.equal(activity[0].state, 'complete');
  assert.equal(activity[0].elapsedMs, 2000);
  assert.equal(history.content, 'APEC是亚太经济合作组织。');
  const raw = readFileSync(join(store.vault, 'raw/对话', sessionId + '.md'), 'utf8');
  assert.match(raw, /<details><summary>动态<\/summary>/);
  assert.match(raw, /联网搜索 · 完成 · 2\.0秒/);
  assert.match(raw, /https:\/\/example.org\/apec/);
  assert.match(raw, /\[\[wiki\/主题\/APEC是什么\|APEC是什么\]\]/);
  const restarted = new MemoryStore(root);
  try { assert.deepEqual(JSON.parse(restarted.history(sessionId).messages.find(message => message.id === messageId).activity), activity); }
  finally { restarted.close(); }
});

test('activity keeps only bounded allowlisted fields and safe references', t => {
  const { store, messageId, userId } = fixture(t);
  assert.throws(() => store.activity(userId, event()), /助手/);
  assert.throws(() => store.activity(messageId, event({ kind: 'reasoning' })), /格式/);
  store.activity(messageId, event({
    title: 'x'.repeat(500), detail: 'Bearer fixture-token sk-secret-key-123456 ' + 'y'.repeat(1600),
    apiKey: 'sk-secret-key-123456', reasoning: 'private chain of thought', prompt: 'full system prompt', elapsedMs: Infinity,
    items: [
      { label: '可执行URL', url: 'javascript:alert(1)' },
      { label: '带凭据URL', url: 'https://user:secret@example.org/' },
      { label: '合法来源', url: 'https://example.org/doc?token=secret&article=1', content: 'source body' },
      { label: '越界文件', path: 'wiki/../../outside.md' },
      { label: 'Windows路径', path: 'D:\\secret.md' },
      { label: '合法笔记', path: 'wiki/主题/APEC.md' },
      ...Array.from({ length: 20 }, () => ({ label: 'extra' })),
    ],
  }));
  const saved = JSON.parse(store.db.prepare('SELECT activity FROM messages WHERE id=?').get(messageId).activity)[0];
  assert.equal(saved.title.length, 120);
  assert.equal(saved.detail.length, 800);
  assert.equal(saved.items.length, 8);
  assert.equal(saved.items[0].url, undefined);
  assert.equal(saved.items[1].url, undefined);
  assert.equal(saved.items[2].url, 'https://example.org/doc?article=1');
  assert.equal(saved.items[3].path, undefined);
  assert.equal(saved.items[4].path, undefined);
  assert.equal(saved.items[5].path, 'wiki/主题/APEC.md');
  assert.doesNotMatch(JSON.stringify(saved), /fixture-token|sk-secret|private chain|system prompt|source body/);
  assert.equal(saved.elapsedMs, undefined);
  for (let index = 0; index < 65; index++) store.activity(messageId, event({ id: `operation-${index}`, state: 'complete' }));
  const bounded = JSON.parse(store.db.prepare('SELECT activity FROM messages WHERE id=?').get(messageId).activity);
  assert.equal(bounded.length, 60);
  assert.equal(bounded[0].id, 'operation-5');
});

test('interruptions and restarts terminate pending activity without claiming completion', t => {
  const { root, store, sessionId, messageId } = fixture(t);
  store.activity(messageId, event());
  store.finish(messageId, 'interrupted');
  assert.equal(JSON.parse(store.history(sessionId).messages.find(message => message.id === messageId).activity)[0].state, 'cancelled');
  const next = randomUUID();
  store.beginAssistant(sessionId, next, true, 'qa');
  store.activity(next, event({ id: 'model-1', kind: 'model', title: '生成回答' }));
  const restarted = new MemoryStore(root);
  try {
    const history = restarted.history(sessionId).messages.find(message => message.id === next);
    assert.equal(history.status, 'interrupted');
    assert.equal(JSON.parse(history.activity)[0].state, 'cancelled');
  } finally { restarted.close(); }
  const failed = randomUUID();
  store.beginAssistant(sessionId, failed, true, 'qa');
  store.activity(failed, event()); store.finish(failed, 'failed');
  assert.equal(JSON.parse(store.history(sessionId).messages.find(message => message.id === failed).activity)[0].state, 'failed');
});

test('old databases migrate and manual raw edits remain intact while activity stays in SQLite', t => {
  const { root, store, sessionId, messageId } = fixture(t);
  store.finish(messageId, 'complete');
  store.db.exec('ALTER TABLE messages DROP COLUMN activity');
  const migrated = new MemoryStore(root);
  try {
    assert.equal(migrated.history(sessionId).messages.find(message => message.id === messageId).activity, '[]');
    const raw = join(migrated.vault, 'raw/对话', sessionId + '.md');
    const manual = readFileSync(raw, 'utf8') + '\n手动批注，请保留。\n';
    writeFileSync(raw, manual);
    migrated.activity(messageId, event({ state: 'complete' }));
    assert.equal(readFileSync(raw, 'utf8'), manual);
    assert.equal(JSON.parse(migrated.history(sessionId).messages.find(message => message.id === messageId).activity).length, 1);
    assert.match(migrated.status().exportErrors[0].export_error, /手动修改/);
  } finally { migrated.close(); }
});
