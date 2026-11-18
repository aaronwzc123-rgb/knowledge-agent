import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { readDocument, extractDocument } from './documents.mjs';

test('native HTTP empty or invalid statuses fail as promises without crashing the service', async t => {
  let status = 204;
  const replacement = t.mock.method(https, 'request', (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = status; response.headers = { 'content-type': 'text/html' };
      callback(response); response.emit('end');
    });
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { replacement.mock.restore(); syncBuiltinESMExports(); });
  const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
  for (status of [204, 205, 304, 600]) await assert.rejects(() => readDocument('https://example.org/source', { lookupImpl }));
});

test('original publication dates are independent of retrieval time and HTML instructions are not executed', () => {
  const document = extractDocument('<title>来源</title><meta property="article:published_time" content="2021-01-01"><script>doSomething()</script><article><h1>结论</h1><p>这是原始证据 &amp; 原文。</p></article>');
  assert.equal(document.publishedAt, '2021-01-01');
  assert.match(document.content, /原始证据 & 原文/);
  assert.doesNotMatch(document.content, /doSomething/);
  assert.equal(document.updatedAt, null);
});
