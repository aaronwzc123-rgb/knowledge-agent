import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from './server.mjs';

const modelReply = value => Response.json({choices: [{message: {content: JSON.stringify(value)}}]});
const questions = ['波形怎样表达振动', '振幅怎样衡量偏移', '周期怎样衡量重复', '频率与周期怎样换算'];
const titles = ['如何描述波形与振幅', '重复的快慢怎样量化'];
const rootTitle = '振动怎样从形状读到快慢';
const prompt = '专题研究：机械振动的基本参数';
const quote = q => `教材对「${q}」给出了可核对的解释与适用条件。`;
const outputPath = q => `wiki/知识点/${q}.md`;
const originPath = 'https://example.org/';
const lookup = async () => [{address: '93.184.216.34', family: 4}];

test('专题从聊天入口写库，搜索故障可恢复，服务重启后只补剩余问题', async t => {
  const root = await mkdtemp(join(tmpdir(), 'taotao-topic-'));
  let app;
  t.after(async () => {
    await app?.close();
    await rm(root, {recursive: true, force: true, maxRetries: 4});
  });
  const sessionId = randomUUID(), taskId = randomUUID();
  let plans = 0, failures = 0, fallback = 0, hasRecovered = false, holdSearch = null;
  const searches = [];
  function provider(value, options) {
    const url = String(value).replace(/\/$/, '');
    if (url.startsWith(originPath)) {
      const q = questions[Number(url.at(-1))];
      return new Response(quote(q) + '这是公开教材的完整段落，可以供管理员验证和引用。每个参数对应一个独立问题。', {
        headers: {'content-type': 'text/plain; charset=utf-8'},
      });
    }
    if (url.startsWith('https://www.bing.com/search')) {
      fallback++;
      const q = new URL(url).searchParams.get('q');
      const i = questions.indexOf(q.replace(' 教材',''));
      return new Response(hasRecovered && i===3 ? `<rss><channel><item><title>教材</title><link>${originPath}3</link></item></channel></rss>` : '<rss/>');
    }
    assert.match(url, /^https:\/\/api\.deepseek\.com\//);
    const payload = JSON.parse(options.body);
    if (url.endsWith('/search')) {
      const q = payload.query.replace(' 教材', '');
      searches.push(q);
      const i = questions.indexOf(q);
      assert.ok(i >= 0, q);
      if (i === 3 && holdSearch) {
        holdSearch.started();
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => {
            holdSearch.aborted();
            reject(options.signal.reason);
          }, {once:true});
        });
      }
      if (i === 3) return Response.json({}, {status: 404});
      return Response.json({results: [{url: originPath + i}]});
    }
    const system = payload.messages[0].content, input = JSON.parse(payload.messages.at(-1).content);
    if (system.startsWith('你是专题研究规划员')) {
      plans++;
      assert.equal(input.task,prompt);
      return modelReply({title:rootTitle, sections:titles.map((title,i)=>({
        title, questions:questions.slice(i*2,i*2+2).map(question=>({question, query:question+' 教材'})),
      }))});
    }
    if (system.startsWith('检查已有笔记')) return modelReply({path:'',quote:'',gap:''});
    if (system.startsWith('你是资料审阅员')) return modelReply({evidence:[{url: input.sources[0].url, quote:quote(input.question)}]});
    if (system.startsWith('你是 Wiki 知识点编辑')) {
      if (input.question === questions[0] && failures++ === 0) return Response.json({}, {status: 503});
      return modelReply({pages:[{path:outputPath(input.question),paragraphs:[{
        text:quote(input.question), evidence:[{id:input.material[0].id,quote:quote(input.question)}],
      }]}]});
    }
    if (system.startsWith('你是证据审阅员')) return modelReply({approved:true});
    if (system.startsWith('你是 Wiki 目录编辑')) {
      return modelReply({pages:[{path:input.target,paragraphs:[{
        text: `先理解 [[${input.required[0].slice(0,-3)}|第一个概念]]，再从 ${input.required.slice(1).map(p=>`[[${p.slice(0,-3)}|下一个概念]]`).join('、')} 理解它们的关系。`,
        evidence:input.required.map(path=>{const row=input.material.find(r=>r.path===path);return {id:row.id,quote:row.text.slice(0,45)};}),
      }]}]});
    }
    throw new Error('Unexpected model step: '+system.slice(0,35));
  }
  async function start() {
    const server = createServer({memoryRoot: root, fetchImpl:provider, documentLookup:lookup});
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      base,
      async post(path,body) {
        const response = await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify(body)});
        if (!response.ok) assert.fail(await response.text());
        return response;
      },
      close() { server.closeAllConnections(); return new Promise(resolve=>server.close(resolve)); },
    };
  }
  app=await start();
  const answer = async content => {
    const response=await app.post('/api/chat',{
      agent:'librarian',apiKey:'sk-fixture-only',model:'fixture',webSearch:true,
      memory:{sessionId,id:randomUUID(),visible:true,curate:false},
      messages:[{role:'user',content}],
    });
    const frames=(await response.text()).split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
    const reply=frames.find(frame=>frame.knowledge)?.knowledge;
    assert.ok(reply, JSON.stringify(frames.slice(-4)));
    return reply;
  };
  await app.post('/api/knowledge/permission',{enabled:true});
  await app.post('/api/memory/user',{id:taskId,sessionId,content:'@知识库管理员 '+prompt,agent:'librarian'});
  const first=await answer(prompt);
  assert.equal(first.pending,true);
  assert.equal(first.pages.filter(page=>page.path.startsWith('wiki/知识点/')).length,3);
  assert.equal(failures,2,'503 is retried, then work continues');
  const history=()=>fetch(app.base+'/api/memory/history?id='+sessionId).then(r=>r.json());
  assert.equal((await history()).messages.at(-1).resumable,1);

  await app.close();
  app=await start();
  hasRecovered=true;
  const before=searches.length;
  await app.post('/api/memory/user',{id:randomUUID(),sessionId,content:'@知识库管理员 继续',agent:'librarian'});
  const second=await answer('继续');
  assert.equal(plans,1);
  assert.deepEqual(searches.slice(before),[questions[3]]);
  assert.ok(fallback>=2);
  assert.equal(second.pending,false,JSON.stringify(second.gaps));
  assert.equal((await history()).messages.at(-1).resumable,0);
  const note=async path=>(await (await fetch(app.base+'/api/memory/note?path='+encodeURIComponent(path))).json()).content;
  assert.match(await note(`wiki/主题导读/${rootTitle}.md`),new RegExp(titles[1]));
  assert.match(await note(outputPath(questions[3])),/原文存档/);

  // An explicit stop travels to the current upstream request, even after restarting.
  const cancellationSession = randomUUID();
  await app.post('/api/memory/user',{id:randomUUID(),sessionId:cancellationSession,content:prompt,agent:'librarian'});
  const started = Promise.withResolvers(), aborted = Promise.withResolvers();
  holdSearch = {started:started.resolve,aborted:aborted.resolve};
  const controller = new AbortController();
  const response = await fetch(app.base+'/api/chat',{
    method:'POST', headers:{'content-type':'application/json',origin:app.base}, signal:controller.signal,
    body:JSON.stringify({agent:'librarian',apiKey:'sk-fixture-only',model:'fixture',webSearch:true,
      memory:{sessionId:cancellationSession,id:randomUUID(),visible:true,curate:false},messages:[{role:'user',content:prompt}]}),
  });
  await started.promise;
  controller.abort();
  await aborted.promise;
  await assert.rejects(response.text(), {name:'AbortError'});
});
