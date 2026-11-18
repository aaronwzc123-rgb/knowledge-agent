import { normalizeClaimPolicy } from './knowledge-policy.mjs';

const inline = value => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/([\[\]`])/g, '\\$1').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const calendarDate = value => /^\d{4}-\d{2}-\d{2}/.test(String(value)) ? String(value).slice(0, 10) : inline(value);

export function renderKnowledgeNote(page, sources, { headingLevel = 1, includeLinks = true, numberOffset = 0 } = {}) {
  const sourceMap = sources instanceof Map ? sources : new Map((sources || []).map(source => [source.id, source]));
  const ids = [...new Set(page.claims.flatMap(claim => claim.evidence.map(evidence => evidence.sourceId)))];
  const numbers = new Map(ids.map((id, index) => [id, numberOffset + index + 1]));
  const title = page.path.split('/').at(-1).replace(/\.md$/, '');
  const paragraphs = page.claims.map(claim => {
    let text = claim.text;
    const policy = normalizeClaimPolicy(claim);
    if (claim.status === 'uncertain' && !/不确定|尚未|待核|可能|分歧|未证实/.test(text)) text = `尚未证实，${text}`;
    if (claim.status === 'user_statement' && !/用户|本人|我(?:的|是|叫|住|喜欢|不喜欢)/.test(text)) text = `用户曾表示，${text}`;
    if (claim.status === 'reviewed') {
      if (policy.kind === 'personal' && !/用户|本人|我(?:的|是|叫|住|学|曾|参与|参加|喜欢)/.test(text)) text = `用户${text}`;
      if (['opinion', 'experience', 'analysis', 'hypothesis'].includes(policy.kind) && !text.includes(policy.attribution)) {
        const verb = { opinion: '认为', experience: '的经验是', analysis: '认为', hypothesis: '提出假设' }[policy.kind];
        text = `${policy.attribution}${verb}：${text}`;
      }
      if (policy.kind === 'fact' && policy.basis === 'attributed' && !text.includes(policy.attribution)) text = `${policy.attribution}记载：${text}`;
      if (policy.reviewState === 'needs_context' && !/待补充|尚缺|缺少|有待/.test(text)) text += '（相关条件待补充。）';
      if (policy.reviewState === 'disputed' && !/分歧|争议|冲突|不同观点/.test(text)) text += '（现有资料对此存在分歧。）';
    }
    const citations = [...new Set(claim.evidence.map(evidence => evidence.sourceId))].map(id => `[^${numbers.get(id)}]`).join('');
    return `${text}${citations}`;
  });
  const sections = [`${'#'.repeat(headingLevel)} ${title}`, ...paragraphs];
  if (includeLinks && page.links?.length) sections.push(`## 相关笔记\n\n${page.links.map(link => `- [[${link.path.replace(/\.md$/, '')}]]${link.relation ? ` · ${inline(link.relation)}` : ''}`).join('\n')}`);
  const references = ids.map(id => {
    const source = sourceMap.get(id);
    if (!source) return `[^${numbers.get(id)}]: 来源暂不可用。`;
    const title = inline(source.title || '原始资料');
    const label = source.url ? `[${title}](<${source.url}>)` : title;
    const dates = [];
    if (source.publishedAt) dates.push(`发布于 ${calendarDate(source.publishedAt)}`);
    if (source.updatedAt && calendarDate(source.updatedAt) !== calendarDate(source.publishedAt)) dates.push(`更新于 ${calendarDate(source.updatedAt)}`);
    if (source.retrievedAt) dates.push(`获取于 ${calendarDate(source.retrievedAt)}`);
    if (source.kind === 'document') dates.unshift(`${inline(source.document.locator)} · v${source.document.version}`);
    const qualifications = [...new Set(page.claims.filter(claim => claim.evidence.some(evidence => evidence.sourceId === id)).flatMap(claim => {
      const conditions = [];
      if (claim.scope && !/^(?:用户|本人|用户本人|用户明确|真实用户)(?:的)?(?:陈述|自述|原话)$/.test(claim.scope) && !claim.text.includes(claim.scope)) conditions.push(`适用于${claim.scope}`);
      if (claim.asOf && !claim.text.includes(claim.asOf)) conditions.push(`内容截至 ${claim.asOf}`);
      return conditions;
    }))];
    const record = source.ref ? ` [[${source.ref.replace(/\.md$/, '')}|本地证据]]` : '';
    return `[^${numbers.get(id)}]: ${inline(source.publisher || '未注明')}，${label}${dates.length ? `。${dates.join('，')}` : ''}${qualifications.length ? `。${qualifications.map(inline).join('，')}` : ''}。${record}`;
  });
  if (references.length) sections.push(`## 来源\n\n${references.join('\n\n')}`);
  return sections.join('\n\n') + '\n';
}

export function queryTerms(query) {
  const lower = String(query).toLowerCase();
  return [...new Set([...(lower.match(/[a-z0-9]{2,}/g) || []), ...[...lower.matchAll(/(?=([\u4e00-\u9fff]{2}))/g)].map(match => match[1])])];
}

export function quotedContext(content, quotes) {
  const ranges = [];
  for (const quote of quotes) {
    const at = content.indexOf(quote);
    if (at < 0) return content; // Whitespace-normalized quotes still need their original context.
    ranges.push([Math.max(0, at - 150), Math.min(content.length, at + quote.length + 150)]);
  }
  const merged = [];
  for (const range of ranges.sort((a, b) => a[0] - b[0])) {
    if (merged.length && range[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], range[1]);
    else merged.push(range);
  }
  return merged.length ? merged.map(([start, end]) => content.slice(start, end)).join('\n[其他段落省略]\n') : content;
}

export function selectKnowledgeClaims(claims, query, limit = 3) {
  const terms = queryTerms(query);
  const ranked = claims.map((claim, index) => ({ claim, index, score: terms.reduce((score, term) => score + (`${claim.text} ${claim.scope}`.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const matching = ranked.filter(item => item.score > 0);
  return (matching.length ? matching : ranked).slice(0, limit).sort((a, b) => a.index - b.index).map(item => item.claim);
}
