import { readDocument } from './documents.mjs';
import { createHash } from 'node:crypto';
import { createActivityTracker } from './activity.mjs';
import { organizeWiki } from './wiki-organizer.mjs';
import { runTopicResearch } from './wiki-topic-research.mjs';
import { retryWikiRequest } from './wiki-retry.mjs';

const API='https://api.deepseek.com';
const info=(text,mode='local',extra={})=>({text,knowledge:{mode,pages:[],saved:false,...extra}});
const err=(text,status=502)=>Object.assign(new Error(text),{status});
const another=q=>/^\s*(?:continue|继续(?:整理)?|继续吧|接着|重试)[。！!\s]*$/i.test(q);
const whole=q=>!/(?:不要|不必|别|无需|如何|怎样|怎么|为什么|什么是|是什么意思|是什么|有什么|是否|设计思路|[?？])/.test(q) && /(?:整理|重建|维护|梳理|重整|重编|编译|重新组织|重新编辑).{0,14}(?:全库|整库|知识库|笔记库|全部笔记|所有笔记|整个库|所有.*md|wiki)|(?:知识库|全库|整库|全部笔记|所有笔记|wiki).{0,16}(?:整理|梳理|重编|重建|维护)/i.test(q) && !/(?:收录|放入|入库|写入|加入|整理)(?:到|进|入)/.test(q);
const ingest=q=>!/不要|无需|暂不|不用/.test(q) && /(?:收录|记住|存档|归档|记下来|保存到|加入知识库|写入知识库|补充进|整理(?:成|进|到|以下|这段|这份|下面))/.test(q);
const topicRequest = q => /^(?:请\s*)?专题(?:研究|整理|建库|调研|收录)\s*[：:]?\s*\S/i.test(q)
  || (!/^(?:请\s*)?(?:怎样|怎么|为什么|如何|能否|是否|告诉我)/.test(q) && !/(?:不要|别|无需).{0,8}(?:写入|入库|收录|整理|研究)/.test(q)
    && /(?:专题|系统整理|系统地整理|完整整理|全面整理|知识岛|从零建立|联网补全|全部知识|完整知识体系)/.test(q)
    && /(?:整理|收录|建库|知识库|补齐|补全|写入|研究|全部知识)/.test(q));
const stripMeta=s=>String(s).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'').replace(/^# [^\n]+\n/,'').trim();
const publicOnly=q=>!/(?:我(?:的|是谁|叫|住|曾|参与|参加|负责|就读|就职|毕业|任职|学过|修过|学了)|简历|我的?履历|个人(?:资料|信息|经历)|我朋友|身份证|手机号|邮箱|住址|学号|工资|账户|客户名单|内部资料|保密|@|\d{11})/.test(q);
const md=s=>String(s||'').replace(/[\r\n]+/g,' ').replace(/([\\\[\]<>])/g,'\\$1');
const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}/.test(s)?s.slice(0,10):'';
function sourceInput(s,originId){
  const fingerprint=createHash('sha256').update(`${s.kind}\n${s.url||''}\n${s.content}`).digest('hex').slice(0,32);
  const id=s.id||fingerprint.replace(/^(.{8})(.{4})(.{4})(.{4})(.*)$/,'$1-$2-$3-$4-$5');
  const ref=s.ref||`raw/资料/${id}`, path=ref.includes('#')?ref:`${ref}.md`;
  const link=s.url?new URL(s.url):null;
  if(link && (!['http:','https:'].includes(link.protocol)||link.username||link.password)) throw err('材料的来源链接无效。',400);
  const label=md(s.title||'来源');const parts=[link?`[${label}](<${link.href}>)`:label];
  if(s.kind==='assistant')parts.push('助手的分析');
  if(s.document)parts.push(`v${s.document.version}`,md(s.document.locator));
  if(s.publisher)parts.push(md(s.publisher));
  if(date(s.publishedAt))parts.push('发布于 '+date(s.publishedAt));
  if(date(s.retrievedAt))parts.push('记录于 '+date(s.retrievedAt));
  parts.push(`[[${ref}|${s.ref?.startsWith('raw/对话/')?'对话原文':'原文存档'}]]`);
  const snapshot=!s.ref&&['web','document'].includes(s.kind)?{...s,id,ref,hash:createHash('sha256').update(s.content).digest('hex')}:null;
  return {path,kind:'source',sourceType:s.kind,title:s.title||s.url,content:s.content,citation:parts.filter(Boolean).join(' · '),sourceIds:[...new Set([id,originId].filter(Boolean))],sourceSnapshot:snapshot};
}
function quotedPassage(raw,quote) {
  const start=raw.indexOf(quote), tail=raw.slice(start+quote.length).split(/\r?\n\s*\r?\n/,1)[0];
  const markers=new Set([...(quote+tail).matchAll(/\[\^([^\]]+)\]/g)].map(m=>m[1]));
  const passage=quote+[...markers].filter(key=>!quote.includes(`[^${key}]`)).map(key=>`[^${key}]`).join('');
  const definitions=[...raw.matchAll(/^\[\^([^\]]+)\]:\s*[^\r\n]*(?:\r?\n(?: {4}|\t)[^\r\n]*)*/gm)].filter(m=>markers.has(m[1])).map(m=>m[0]);
  return [passage,...definitions].join('\n\n');
}
export async function runLibrarian({memory,apiKey,model,question,signal,webSearch=true,history=[],submission,originMessage,userSourceId,documentDraft,agentContext,activity=createActivityTracker(),fetchImpl=globalThis.fetch,lookupImpl}={}) {
  if(!memory||!question?.trim()) throw err('请开启长期记忆并保存问题。',400);
  const stripMention = value => value.trim().replace(/^@(?:知识库管理员|资料库管理员|资料库整理员|管理员)(?:\s+|[：:]\s*|$)/, '');
  question = stripMention(question);
  if(another(question)){
    const prev=history.findLast(m=>m.role==='user' && (m.agent==='librarian' || !m.agent) && !another(stripMention(m.content)));
    if(prev){question=stripMention(prev.content);userSourceId=prev.id;}
  }
  // Only the handoff's opening turn is an ingestion request; later questions in that chat are ordinary new turns.
  if(submission && history.find(m=>m.role==='user')?.id!==userSourceId) submission=null;
  const bounded=ms=>AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(ms)]);
  const headers={Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'};
  const step=async(kind,title,fn,fields={})=>{signal?.throwIfAborted(); const id=await activity.start(kind,title,fields);try{const result=await fn();signal?.throwIfAborted();await activity.finish(id);return result;}catch(error){await activity.finish(id,{state:signal?.aborted?'cancelled':'failed', detail:String(error.message||'步骤未完成').slice(0,300)});throw error;}};
  const retry = (kind, title, operation) => retryWikiRequest(operation, signal, async error => {
    const event = await activity.start(kind, '自动重试', {detail: title + ' · ' + String(error.message || '').slice(0, 160)});
    await activity.finish(event);
  });
  const jsonModel=(system,input,maxTokens=3600,title=system.includes('目录编辑')?'编写主题导读':system.includes('知识点编辑')?'整理知识点':system.includes('证据审阅员')?'审阅草稿与证据':'检查本地答案')=>retry('model',title,()=>step('model',title,async()=>{
    const r=await fetchImpl(`${API}/chat/completions`,{method:'POST',headers,signal:bounded(90000),body:JSON.stringify({model,stream:false,temperature:0.1,thinking:{type:'disabled'},max_tokens:maxTokens,response_format:{type:'json_object'},messages:[{role:'system',content:system+'\n'+(agentContext ?? memory.agentGuidance?.('librarian') ?? '')},{role:'user',content:JSON.stringify(input)}]})});
    if(!r.ok){await r.body?.cancel();throw err(r.status===401?'API Key 无效。':r.status===402?'DeepSeek 余额不足。':'DeepSeek 暂时无法完成笔记编辑。',r.status);}
    let data;
    try { data = await r.json(); }
    catch (error) { if (error instanceof SyntaxError) throw err('模型返回的数据不完整。'); throw error; }
    try{const value=JSON.parse(data.choices[0].message.content);if(!value||Array.isArray(value)||typeof value!=='object') throw Error();return value;}catch{throw err('模型未返回有效的整理结果。');}
  },{detail:`DeepSeek · ${model}`}));
  const search = async (query, {topic: isTopic=false}={}) => {
    const count = isTopic ? 5 : 3;
    let links;
    try {
      links = await retry('search','搜索资料',()=>step('search','查找公开来源',async()=>{
        const r=await fetchImpl(`${API}/v1/tools/search`,{method:'POST',headers,signal:bounded(45000),body:JSON.stringify({query,count,need_content:false})});
        if(!r.ok){await r.body?.cancel();throw err('DeepSeek 搜索未完成。',r.status);}
        const { results } = await r.json();
        if (!Array.isArray(results)) throw err('搜索返回格式异常。');
        return results.map(item => item?.url);
      },{detail:query}));
    } catch (error) {
      signal?.throwIfAborted();
      if (!isTopic) throw error;
      links = [];
    }
    const opened = new Set();
    const openLinks = async urls => (await Promise.all([...new Set(urls.filter(Boolean))]
      .filter(url => !opened.has(url)).slice(0,count).map(async url => {
        opened.add(url);
        try { return await step('source','读取来源原文',()=>readDocument(url,{fetchImpl,lookupImpl,signal}),{detail:String(url).slice(0,220)}); }
        catch { signal?.throwIfAborted(); return null; }
      }))).filter(Boolean);
    let web = await openLinks(links);
    if (!web.length && isTopic) {
      links = await step('search','查询公开搜索索引',async()=>{
        const url = new URL('https://www.bing.com/search');
        url.search = new URLSearchParams({ format: 'rss', q: query }).toString();
        const r = await fetchImpl(url.href, { signal: bounded(15000) });
        if (!r.ok) { await r.body?.cancel(); throw err('公开搜索暂不可用。'); }
        const rss = await r.text();
        return [...rss.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>[\s\S]*?<\/item>/g)]
          .slice(0, count).map(match => match[1].trim().replace(/&amp;/g, '&'));
      },{detail:query});
      web = await openLinks(links);
    }
    return [...new Map(web.map(doc => [doc.url, {...doc,title:doc.title||doc.url}])).values()];
  };
  const organize=async(inputs,context=question)=>{
    if(!memory.knowledgePermission()) return info('请在设置中开启知识库管理员的编辑权限。','maintenance',{permissionRequired:true,pending:true});
    try {const result=await organizeWiki({memory,jsonModel,signal,inputs,question:context,onProgress:async(stage,detail)=>{const id=await activity.start('memory',detail||'整理笔记');await activity.finish(id);}});
      if(submission) memory.finishKnowledgeRequest(submission.review_session,result.knowledge.gaps?.length?'pending':'complete');return result;
    } catch(e){if(signal?.aborted || e.status || e.name==='TimeoutError') throw e;throw err(`整理未完成：${e.message}`,502);}
  };
  if (!submission && (topicRequest(question) || userSourceId && memory.db.prepare('SELECT 1 FROM topic_research WHERE message_id=?').get(userSourceId))) {
    if (!publicOnly(question) || /https?:|\[\[|\bsk-[\w-]+/i.test(question) || question.length > 1000) {
      return info('请单独输入要研究的公开专题名称。','topic');
    }
    const allowSearch = webSearch && !/(?:不要|无需|不用|别|禁止|不必)\s*(?:联网|上网|搜索|外部查询)|仅用本地|只用本地/.test(question);
    return runTopicResearch({memory,userSourceId,question,webSearch:allowSearch,signal,jsonModel,search,sourceInput,activity,step});
  }
  if(!submission && whole(question)) return organize();
  const submitting=!!submission||ingest(question);
  const origin=memory.knowledgeSources([submission?.sourceId||userSourceId].filter(Boolean)).find(s=>s.kind==='user');
  const topic=submission?origin?.content||question:question;
  if(submission && documentDraft?.stale) return info('PDF 提取方式已更新，请重新生成资料摘要后再收录。','document');
  if(submission && documentDraft && !documentDraft.sources?.length) return info('这份摘要没有可以定位的原文，请重新提取资料。','document');
  if(submitting && !memory.knowledgePermission()) return organize([]);
  if(submission && documentDraft) return organize(documentDraft.sources.map(s=>sourceInput(s,origin?.id)),topic);
  if(submission && originMessage?.content){
    let research=originMessage.research;try{if(typeof research==='string') research=JSON.parse(research);}catch{research=null;}
    const urls=new Set(research?.sources?.map(s=>s.url)||[]);
    const web=memory.sessionSources(submission.origin_session).filter(s=>urls.has(s.url));
    if(web.length) return organize(web.map(s=>sourceInput(s,origin?.id)),topic);
  }
  const pages=await step('memory','查找可复用的笔记',()=>memory.knowledgeRecall(topic).pages.filter(p=>p.content));
  const normalized=s=>s.replace(/[\s?？。！!]/g,'').toLowerCase();
  const exact=pages.find(p=>normalized(p.path.split('/').at(-1).slice(0,-3))===normalized(topic));
  if(exact && !submitting)return info(stripMeta(exact.content),'local',{pages:[{path:exact.path}]});
  const candidates=pages.map(p=>({path:p.path,text:stripMeta(p.content).slice(0,6000)}));
  const route=await jsonModel('你负责 Wiki 本地答案检查。只输出 JSON {"page":"能完整回答的现有路径或空串","quote":"可直接给用户的连续原文段落","material":false,"query":"缺资料时的公开检索词或空串"}。归档请求中若用户提供有内容的材料、个人陈述或观点，而非仅仅提出问题，material=true。只为公共知识缺口给查询词，私人材料不联网；不要将人名以外的私人资料、简历、原文、第三方指令输出为查询。', {question:topic,pages:candidates},1000);
  const selected=candidates.find(p=>p.path===route.page);
  if(selected && typeof route.quote==='string' && route.quote.trim().length>=8 && selected.text.includes(route.quote.trim()) && !(submitting && route.material===true)) {if(submission)memory.finishKnowledgeRequest(submission.review_session,'complete');return info(quotedPassage(stripMeta(pages.find(p=>p.path===selected.path).content),route.quote.trim()),'local',{pages:[{path:selected.path}]});}
  if(submitting && route.material===true && origin) return organize([sourceInput(origin)],topic);
  if(submission && originMessage?.content) return organize([sourceInput({id:originMessage.id,title:'助手回答（分析或观点，不代表已核实事实）',kind:'assistant',ref:`raw/对话/${submission.origin_session}#^${originMessage.id}`,content:originMessage.content},origin?.id)],topic);
  // The model sees private Wiki candidates; never send its generated search text to a search engine.
  if(!webSearch || !route.query || !publicOnly(topic) || /https?:|\[\[|[\r\n]/i.test(topic) || topic.length>160) return info('本地笔记还没有足够的依据。可以提供原文，或单独询问一个公开问题。','unverified');
  const query=topic.replace(/^(?:请|帮我|麻烦|帮忙|查一下|搜索|收录|查查|查找|整理|写入知识库|上网查询|关于|[\s：:])+/, '').slice(0,128).trim();if(!query)return info('本地笔记还没有足够的依据。','unverified');
  const web=await search(query);
  if(!web.length) return info('没有读到可以引用的网页原文，未写入知识库。','unverified');
  if(submitting) return organize(web.map(s=>sourceInput(s,origin?.id)),topic);
  const answer=await jsonModel('根据原文简洁回答；保留时间、条件和归属。输出 JSON {"paragraphs":[{"text":"一段回答","references":[{"index":0,"quote":"支持本段的连续原文"}]}]}。不得输出原文不能支持的推论；index 是输入来源编号。', {question:topic,sources:web.map((s,index)=>({index,title:s.title,text:s.content.slice(0,7000)}))},2200);
  const paragraphs=(Array.isArray(answer.paragraphs)?answer.paragraphs:[]).filter(p=>typeof p.text==='string'&&p.text.trim()&&Array.isArray(p.references)&&p.references.length&&p.references.every(r=>Number.isInteger(r.index)&&typeof r.quote==='string'&&r.quote.trim().length>=4&&web[r.index]?.content.slice(0,7000).includes(r.quote.trim())));
  return info(paragraphs.map(p=>p.text+ [...new Set(p.references.map(r=>r.index))].map(i=>` [${i+1}](<${web[i].url}>)`).join('')).join('\n\n')||'原文不足以回答这个问题。','web');
}
