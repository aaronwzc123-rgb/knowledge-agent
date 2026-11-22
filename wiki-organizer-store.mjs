// Storage interface shared with the two wiki editors. Paths are vault-relative, including .md.
// scanWiki(memory) => { pages:[{path,title,content,hash,kind:'source'|'atom'|'guide',writable,processed}], skipped:[{path,reason}] }
// commitWiki(memory,{writes:[{path,content,baseHash:null|string,sources:[path],summary?:string}],processed:[{path,hash}],signal?, agent:'librarian'}) => {written:[path]}
// New destinations: wiki/知识点/<title>.md or wiki/主题导读/<title>.md. Existing non-manual wiki notes may be updated in place. No deletion.
import { readdirSync, readFileSync, lstatSync, existsSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
const hash = s => createHash('sha256').update(s).digest('hex');
const fail = (msg,status=409) => { throw Object.assign(new Error(msg),{status}); };
const digest = f => existsSync(f) ? hash(readFileSync(f)) : null;
const table = 'wiki_organizer_seen';
const rootFiles = new Set(['欢迎.md','wiki-schema.md','知识库准则.md']);
const derived = p => ['wiki/index.md','wiki/log.md'].includes(p) || p.startsWith('wiki/分类/');
const action = (db,key) => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
export function wikiSourcePath(p) {
  return typeof p==='string' && p.toLowerCase().endsWith('.md') && !rootFiles.has(p) && !derived(p) && !/^(?:raw|指导)\//i.test(p) && p.split('/').every(part=>part && !part.startsWith('.') && !/[\\:"<>|?*\u0000-\u001f]/u.test(part) && !/[ .]$/u.test(part) && !/^(?:con|nul|prn|aux|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function checkedFile(m,p) {
  if(lstatSync(m.vault).isSymbolicLink()) fail('记忆库不能是文件系统链接。');
  const f=m.path(p);
  // existsSync follows symlinks and reports dangling ones as absent.
  for(let i=1,parts=p.split('/');i<=parts.length;i++){
    const stat=lstatSync(m.path(parts.slice(0,i).join('/')),{throwIfNoEntry:false});
    if(stat?.isSymbolicLink()) fail(`跳过符号链接：${p}`);
  }
  return f;
}
const blockedSources=m=>new Set(m.db.prepare('SELECT id FROM sources WHERE suppressed=1 UNION SELECT id FROM knowledge_sources WHERE suppressed=1').all().map(r=>r.id));
export function scanWiki(m) {
  const pages=[],skipped=[];
  m.db.exec(`CREATE TABLE IF NOT EXISTS ${table}(path TEXT PRIMARY KEY, hash TEXT NOT NULL)`);
  const seen=new Map(m.db.prepare(`SELECT * FROM ${table}`).all().map(r=>[r.path,r.hash]));
  const rows=new Map(m.db.prepare('SELECT * FROM pages').all().map(r=>[r.path,r]));
  const blocked=blockedSources(m), live=new Set(m.knowledgeSources().map(s=>s.id));
  const ids=new Map([...rows.values()].map(r=>[r.id,r]));
  const walk=(dir='')=>{
    for(const e of readdirSync(dir?checkedFile(m,dir):m.vault,{withFileTypes:true})){
      if(e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const p=dir?`${dir}/${e.name}`:e.name;
      if(e.isDirectory()){if(!['raw','指导','wiki/分类'].includes(p)) walk(p);continue;}
      if(!e.isFile() || !wikiSourcePath(p))continue;
      const f=checkedFile(m,p), row=rows.get(p);if(row?.deleted || row && JSON.parse(row.sources).some(id=>blocked.has(id)))continue;
      if(row && m.knowledgeDetail(row,live).content!==row.content){skipped.push({path:p,reason:'含已失效的来源'});continue;}
      if(lstatSync(f).size>8*1024*1024){skipped.push({path:p,reason:'超过 8 MB，请分卷'});continue;}
      let content;const bytes=readFileSync(f);try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{skipped.push({path:p,reason:'不是 UTF-8 Markdown'});continue;}
      const fingerprint=hash(bytes), declaring=content.match(/^memory_id: ([\w-]{8,80})\r?$/m)?.[1];
      if(declaring && ids.has(declaring) && ids.get(declaring).path!==p){skipped.push({path:p,reason:'记忆编号重复或文件已移动'});continue;}
      const kind=p.startsWith('wiki/主题导读/')?'guide':p.startsWith('wiki/')?'atom':'source';
      pages.push({path:p,title:p.split('/').at(-1).slice(0,-3),content,hash:fingerprint,kind,writable:kind!=='source' && !!row && !row.protected && row.hash===fingerprint,processed:seen.get(p)===fingerprint});
    }
  };
  if(lstatSync(m.vault).isSymbolicLink()) fail('记忆库不能是文件系统链接。');
  walk();return {pages:pages.sort((a,b)=>a.path.localeCompare(b.path)),skipped};
}
const validNew=p=>/^wiki\/(知识点|主题导读)\/[^/]{1,120}\.md$/u.test(p) && !/[#^[\]]/u.test(p);
const linksOf=content=>[...new Set([...content.split(/^## (?:参考来源|来源|原始依据)\s*$/m)[0].matchAll(/\[\[(wiki\/[^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]*)?\]\]/g)].map(m=>m[1].replace(/\.md$/,'')+'.md'))].map(path=>({path,relation:'延伸阅读'}));
const managedIndex='# 知识库索引';
export function refreshWikiIndex(m, originalIndex, write=(path,text)=>m.atomic(path,text)) {
  const live=new Set(m.knowledgeSources().map(s=>s.id));
  const rows=m.db.prepare('SELECT * FROM pages WHERE deleted=0 ORDER BY path').all().filter(p=>m.knowledgeDetail(p,live).content);
  const list=guide=>rows.filter(p=>p.path.startsWith('wiki/主题导读/')===guide && !derived(p.path)).map(({path})=>`- [[${path.slice(0,-3)}|${path.split('/').at(-1).slice(0,-3)}]]`).join('\n') || '暂无。';
  let p=action(m.db,'wiki-organizer-index-path') || 'wiki/index.md';
  const read=path=>{const file=checkedFile(m,path);return existsSync(file)?readFileSync(file,'utf8'):null;};
  let old=read(p);
  const previous=action(m.db,'wiki-organizer-index');
  const legacy=action(m.db,'wiki-legacy-index-hash');
  if(old!==null && (previous ? hash(old)!==previous : hash(old)!==legacy && old!==(originalIndex??m.navigation({legacyIndexOnly:true})))) {
    // A custom directory belongs to the user. Use a separate managed index instead.
    let suffix=0;
    do {p='wiki/分类/全库索引'+(suffix?' '+suffix:'')+'.md';suffix++;old=read(p);} while(old!==null);
  }
  const content=`${managedIndex}\n\n## 主题导读\n\n${list(true)}\n\n## 知识笔记\n\n${list(false)}\n\n[[wiki/log|整理记录]]\n`;
  if(content!==old)write(p,content);
  m.db.prepare("INSERT OR REPLACE INTO meta VALUES('wiki-organizer-index',?)").run(hash(content));
  m.db.prepare("INSERT OR REPLACE INTO meta VALUES('wiki-organizer-index-path',?)").run(p);
  return p;
}
export function commitWiki(m,{agent,writes=[],processed=[],readHashes=[],retryPaths=[],signal,generation,sourceIds=[],sourceSnapshots=[],onCommit}) {
  signal?.throwIfAborted();if(agent!=='librarian' || !m.knowledgePermission()) fail('只有已授权的知识库管理员可以整理 Wiki。',403);
  if(generation!==undefined && m.generation!==generation) fail('整理期间知识库已更改，请重新整理。');
  const rows=new Map(m.db.prepare('SELECT * FROM pages').all().map(r=>[r.path,r]));
  const required=new Map(processed.map(p=>[p.path,p.hash]));
  for(const {path,hash:expected} of [...processed,...readHashes]){if(!wikiSourcePath(path) || digest(checkedFile(m,path))!==expected || rows.get(path)?.deleted)fail(`原笔记已变化，未提交：${path}`);}
  const prepared=new Map();
  for(const w of writes){
    if(!wikiSourcePath(w.path) || !w.path.startsWith('wiki/') || !w.content?.trim() || Buffer.byteLength(w.content)>128*1024 || prepared.has(w.path.toLowerCase()))fail('整理稿路径、大小或内容不符合要求。');
    const row=rows.get(w.path), file=checkedFile(m,w.path), actual=digest(file);
    if(actual!==w.baseHash || (actual===null ? row || !validNew(w.path) : !row || row.deleted || row.protected || row.hash!==actual))fail(`笔记已变化、被保护或曾删除：${w.path}`);
    if(actual===null && [...rows.keys()].some(p=>p.toLowerCase()===w.path.toLowerCase()))fail(`笔记名称冲突：${w.path}`);
    const id=row?.id || randomUUID();const text=w.content.trim().replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'');
    const metadata=row?.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]||'';
    const extra=metadata.split(/\r?\n/).filter(line=>! /^(?:memory_id|agent|updated):(?:\s|$)/.test(line)).join('\n').trim();
    const content=`---\nmemory_id: ${id}\nagent: librarian\n${extra ? extra+'\n':''}---\n\n${text.trim()}\n`;
    prepared.set(w.path.toLowerCase(),{...w,file,row,id,content,hash:hash(content)});
  }
  const blocked=blockedSources(m);
  const snapshots=prepared.size && sourceSnapshots.length ? m.prepareSourceSnapshots(sourceSnapshots).supplied : new Map();
  for(const s of snapshots.values()){
    if(!['web','document'].includes(s.kind))fail('只能保存引用的网页或资料原件。');
    const f=checkedFile(m,s.ref+'.md');
    if(existsSync(f) && !m.db.prepare('SELECT 1 FROM knowledge_sources WHERE id=? AND suppressed=0').get(s.id)){
      const original=m.db.prepare("SELECT content,ref FROM sources WHERE id=? AND kind='web' AND suppressed=0").get(s.id);
      if(!original || original.ref!==s.ref || original.content!==s.content || !readFileSync(f,'utf8').includes(s.content))fail('原始资料路径已占用。');
    }
  }
  const originalIndex=action(m.db,'wiki-organizer-index')?undefined:m.navigation({legacyIndexOnly:true});
  const installed=[], written=[], updated=new Date().toISOString();
  const set=(p,txt)=>{const f=checkedFile(m,p), before=existsSync(f)?readFileSync(f):null; m.atomic(p,txt);installed.push({p,before,after:hash(txt)});};
  const allIds=(w,visited=new Set())=>{
    if(visited.has(w.path))return []; visited.add(w.path);
    const ids=new Set([...(w.row?JSON.parse(w.row.sources):[]),...sourceIds,...(w.sourceIds||[]),...snapshots.keys()]);
    for(const p of w.sources||[]){const from=prepared.get(p.toLowerCase()), row=rows.get(p);if(row?.deleted)fail('引用的笔记已被删除。');if(p!==w.path && (from || row))ids.add(`wiki-page:${from?.id || row.id}`);for(const id of from?allIds(from,visited):JSON.parse(row?.sources||'[]'))ids.add(id);}
    if([...ids].some(id=>blocked.has(id)))fail('整理期间引用来源已被移除。');
    return [...ids];
  };
  try {m.transaction(()=>{
    m.storeSourceSnapshots(snapshots,updated,set);
    const mark=m.db.prepare(`INSERT OR REPLACE INTO ${table}(path,hash) VALUES(?,?)`);
    for(const [p,h] of required)mark.run(p,h);
    for(const w of prepared.values()){
      signal?.throwIfAborted();if(digest(w.file)!==w.baseHash)fail(`笔记已变化：${w.path}`);
      if(w.row)m.db.prepare('INSERT INTO revisions(page_id,content,kind,created) VALUES(?,?,?,?)').run(w.id,w.row.content,'before-wiki-edit',updated);
      set(w.path,w.content);
      m.db.prepare('INSERT INTO pages VALUES(?,?,?,?,?,0,0,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content,hash=excluded.hash,sources=excluded.sources,updated=excluded.updated').run(w.id,w.path,w.content,w.hash,JSON.stringify(allIds(w)),updated);
      m.db.prepare('INSERT OR REPLACE INTO knowledge_pages(page_id,summary,links,page_hash,legacy) VALUES(?,?,?,?,?)').run(w.id,w.summary||m.knowledgeTextExcerpt(w.content,'').slice(0,180),JSON.stringify(linksOf(w.content)),w.hash,'');
      mark.run(w.path,w.hash);written.push(w.path);
    }
    for(const p of retryPaths)m.db.prepare(`DELETE FROM ${table} WHERE path=?`).run(p);
    refreshWikiIndex(m,originalIndex,set);
    m.db.prepare("INSERT OR REPLACE INTO meta VALUES('wiki-organizer-active','1')").run();
    if(written.length){
      const runId=randomUUID(), detail='整理 Wiki：'+written.join('、');
      m.db.prepare('INSERT INTO runs(id,status,detail,created) VALUES(?,?,?,?)').run(runId,'complete',detail,updated);
      const log='wiki/log.md',f=checkedFile(m,log),old=existsSync(f)?readFileSync(f,'utf8'):'# 整理记录\n';
      set(log,old.trimEnd()+'\n\n- '+updated+' · '+detail+'\n');
    }
    signal?.throwIfAborted();
    onCommit?.(written);
  });}catch(err){for(const {p,before,after} of installed.reverse()){const f=checkedFile(m,p);if(digest(f)!==after)continue;if(before===null)unlinkSync(f);else m.atomic(p,before);}throw err;}
  return {written};
}
