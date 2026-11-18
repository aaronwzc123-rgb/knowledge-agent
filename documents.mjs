import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !([0, 10, 127].includes(a) || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && [0, 168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b)));
  }
  if (isIP(address) !== 6) return false;
  // Only global unicast IPv6, without embedded IPv4 or transition addresses.
  return /^[23][0-9a-f]{0,3}:/i.test(address) && !address.toLowerCase().startsWith('2001:db8:') && !address.includes('.') && !address.toLowerCase().startsWith('2002:');
}

async function publicURL(value, lookupImpl) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))
    || /(^|\.)(localhost|local|internal|test|invalid)$/i.test(hostname)) throw new Error('来源地址不可访问。');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookupImpl(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('来源必须是公开网页。');
  return { url, address: addresses[0] };
}

async function pinnedResponse(url, address, signal) {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal, family: address.family, autoSelectFamily: false,
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      headers: { 'User-Agent': 'TaotaoKnowledge/1.0', Accept: 'text/html,application/xhtml+xml,text/plain', 'Accept-Encoding': 'identity' },
    }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { res.destroy(new Error('来源正文过大。')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve(new Response([204, 205, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), { status: res.statusCode, headers: res.headers }));
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end();
  });
}

function decode(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code) => {
    if (!code.startsWith('#')) return named[code.toLowerCase()] || entity;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity;
  });
}

export function extractDocument(html, type = 'text/html') {
  const meta = new Map();
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = new Map([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(m => [m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4])]));
    if (attrs.has('content')) meta.set(attrs.get('property') || attrs.get('name'), attrs.get('content'));
  }
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value.slice(0, 80) : null;
  const published = meta.get('article:published_time') || html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1];
  const updated = meta.get('article:modified_time') || html.match(/"dateModified"\s*:\s*"([^"]+)"/i)?.[1];
  const title = decode((meta.get('og:title') || html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]*>/g, '')).trim().slice(0, 200);
  const content = type.includes('plain') ? html : decode(html
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/(?:p|div|section|article|li|h[1-6]|tr|blockquote)>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '));
  return { title, publisher: (meta.get('og:site_name') || meta.get('author') || '').slice(0, 180), publishedAt: date(published), updatedAt: date(updated),
    content: content.replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 80000) };
}

export async function readDocument(value, { fetchImpl = globalThis.fetch, lookupImpl = lookup, signal } = {}) {
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(16000)]);
  let current = value;
  for (let redirects = 0; redirects <= 3; redirects++) {
    bounded.throwIfAborted();
    const { url, address } = await publicURL(current, lookupImpl);
    const response = fetchImpl === globalThis.fetch ? await pinnedResponse(url, address, bounded)
      : await fetchImpl(url.href, { signal: bounded, redirect: 'manual', headers: { Accept: 'text/html,text/plain' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      current = new URL(response.headers.get('location'), url).href; await response.body?.cancel(); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error('来源原文无法读取。'); }
    const type = response.headers.get('content-type') || '';
    if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(type)) { await response.body?.cancel(); throw new Error('来源暂不支持正文提取。'); }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('来源正文过大。');
    const declared = type.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]
      || Buffer.from(bytes).subarray(0, 2000).toString('ascii').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
    let decoded;
    try { decoded = new TextDecoder(declared).decode(bytes); }
    catch { decoded = new TextDecoder('utf-8').decode(bytes); }
    const document = extractDocument(decoded, type);
    if (document.content.length < 40) throw new Error('来源没有足够的可读正文。');
    return { ...document, url: url.href, retrievedAt: new Date().toISOString(), kind: 'web' };
  }
  throw new Error('来源跳转过多。');
}
