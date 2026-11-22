import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getAgent, HARNESS_TOOLS } from './agents.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = value => createHash('sha256').update(value).digest('hex');
const review = '提交对话中有价值的知识、个人材料、观点或经验，由知识库管理员复核原文后决定怎样收录。';
const names = Object.keys(HARNESS_TOOLS);
const known = { summarizer: ['wiki_search', 'extract_document'], harness2: ['wiki_search', 'harness_trials'],
  librarian: ['wiki_search', 'web_search'], qa: ['wiki_search', 'web_search'], taotao: ['wiki_search', 'web_search'] };
const toolDefaults = {
  wiki_search: '优先使用本轮检索出的 Wiki 原文，保留来源和适用条件。',
  web_search: '只查当前任务需要的公开资料，优先原始来源。',
  request_knowledge_review: review,
  extract_document: '从已选或明确点名的本地资料中提取原文，保留可回查的位置。',
  harness_trials: '用相同的资料和任务对照试跑基准与候选回答。',
};
const split = text => text.split(/[\n,，]+/u).map(word => word.trim().toLowerCase()).filter(Boolean);
const matches = (trigger, question) => split(trigger).some(word => question.toLowerCase().includes(word));
const configPath = id => '指导/Harness/' + id + '.json';

function initial(agent) {
  const tools = [...(known[agent.id] || ['wiki_search', 'web_search'])];
  const hasReview = ['qa', 'taotao', 'summarizer', 'harness2'].includes(agent.id);
  if (hasReview) tools.push('request_knowledge_review');
  return {
    system: agent.system, guardrails: { instructions: '', blocked: '', blockWeb: false }, memory: '',
    tools: tools.map(id => ({ id, description: id === 'web_search' && agent.researchInstruction ? agent.researchInstruction : toolDefaults[id] })),
    subagents: hasReview ? [{ target: 'librarian', mode: 'review', trigger: '', task: review }] : [],
    skills: [], scripts: [], plugins: [],
  };
}

function read(memory, path) {
  if (!memory) return null;
  try { return readFileSync(memory.path(path), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function promptParts(raw) {
  const frontmatter = raw.match(/^(?:\uFEFF)?---[ \t]*\r?\n(?:[^\r\n]*\r?\n)*?---[ \t]*(?:\r?\n|$)/)?.[0] || '';
  return { frontmatter, text: raw.slice(frontmatter.length).replace(/^\uFEFF/u, '').trim() };
}

export function readAgentSystem(memory, id) {
  const agent = getAgent(id);
  const markdown = read(memory, agent.guidance);
  return markdown === null ? agent.system : promptParts(markdown).text;
}

export function seedAgentHarness(memory, agent) {
  const path = configPath(agent.id);
  if (read(memory, path) === null) {
    const components = initial(agent);
    delete components.system;
    memory.atomic(path, JSON.stringify(components, null, 2) + '\n');
  }
}

export function getAgentHarness(memory, id) {
  const agent = getAgent(id);
  const components = initial(agent);
  const file = configPath(id);
  const raw = read(memory, file);
  if (raw !== null) {
    let stored;
    try { stored = JSON.parse(raw); }
    catch { throw fail('Agent 配置文件不是有效的 JSON，请检查 ' + file, 422); }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw fail('Agent 配置格式有误，请检查 ' + file, 422);
    for (const key of Object.keys(components)) {
      if (key !== 'system' && Object.hasOwn(stored, key)) components[key] = validate(key, stored[key], id);
    }
  }
  const markdown = read(memory, agent.guidance);
  if (markdown !== null) components.system = promptParts(markdown).text;
  return {
    components, files: { system: agent.guidance, config: file },
    revisions: Object.fromEntries(Object.entries(components).map(([key, value]) => [
      key, hash(JSON.stringify(key === 'system' ? markdown : value)),
    ])),
  };
}

export function saveAgentHarness(memory, id, key, { value, revision } = {}) {
  const config = getAgentHarness(memory, id);
  if (!Object.hasOwn(config.components, key)) throw fail('没有这个组件。', 404);
  if (revision !== config.revisions[key]) throw fail('这个组件在其他窗口或 Obsidian 中已修改。请重新读取后再保存。', 409);
  const clean = validate(key, value, id);
  if (key === 'system') {
    const raw = read(memory, config.files.system) || '';
    const meta = promptParts(raw).frontmatter.trimEnd() || '---\nagent: ' + id + '\n---';
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    memory.atomic(config.files.system, meta.replace(/\r?\n/g, eol) + eol + eol + clean.replace(/\r?\n/g, eol) + (clean ? eol : ''));
  } else {
    const raw = read(memory, config.files.config);
    const stored = raw === null ? {} : JSON.parse(raw);
    memory.atomic(config.files.config, JSON.stringify({ ...stored, [key]: clean }, null, 2) + '\n');
  }
  return getAgentHarness(memory, id);
}

function plain(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw fail(label + '格式不正确，最多 ' + max + ' 字。');
  return value.trim();
}

function pick(value, choices, label) {
  if (!choices.includes(value)) throw fail(label + '选项不正确。');
  return value;
}

function validate(key, value, id) {
  if (key === 'system' || key === 'memory') return plain(value, 12000, key === 'system' ? '提示词' : '记忆');
  if (key === 'guardrails') {
    if (!value || typeof value.blockWeb !== 'boolean') throw fail('护栏格式不正确。');
    return { instructions: plain(value.instructions, 6000, '护栏指令'), blocked: plain(value.blocked, 1000, '拦截词'), blockWeb: value.blockWeb };
  }
  if (!Array.isArray(value) || value.length > 16 || value.some(entry => !entry || typeof entry !== 'object')) throw fail('每个组件最多可保存 16 条。');
  const rows = value.map(entry => {
    if (key === 'tools') return { id: pick(entry.id, names, '工具'), description: plain(entry.description, 1500, '工具说明') };
    if (key === 'subagents') {
      const target = getAgent(plain(entry.target, 80, '目标 Agent', true)).id;
      const mode = pick(entry.mode, ['delegate', 'review'], '委派方式');
      if (target === id || (mode === 'review' && target !== 'librarian')) throw fail('请选择有效的子 Agent，收录转交使用知识库管理员。');
      return { target, mode, trigger: plain(entry.trigger, 300, '触发词', mode === 'delegate'), task: plain(entry.task, 2400, '子任务', mode === 'delegate') };
    }
    const name = plain(entry.name, 70, '名称', true);
    if (key === 'plugins') {
      const event = pick(entry.event, ['before_model', 'before_tool', 'after_reply'], '执行时机');
      const action = event === 'after_reply' ? pick(entry.action, ['prepend', 'append', 'replace'], '回复操作') : '';
      return { name, event, action, match: event === 'after_reply' && action === 'replace' ? plain(entry.match, 160, '查找文字', true) : '',
        value: event === 'before_tool' ? pick(entry.value, names, '拦截工具') : plain(entry.value, 1600, '插件内容', action !== 'replace') };
    }
    const trigger = plain(entry.trigger, 300, '触发词', true);
    if (key === 'skills') return { name, trigger, instructions: plain(entry.instructions, 4000, '技能步骤', true) };
    const code = plain(entry.code, 1500, '脚本', true);
    scriptSteps(code);
    return { name, trigger, code, input: pick(entry.input, ['question', 'wiki'], '脚本输入') };
  });
  const ids = rows.map(row => row.id ?? row.name ?? (row.target + ':' + row.mode));
  if (new Set(ids).size !== rows.length) throw fail('同一组件中请使用不同的名称或选项。');
  return rows;
}

function scriptSteps(code) {
  const steps = code.split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!steps.length || steps.length > 12 || steps.some(line =>
    !/^(?:trim|lowercase|uppercase|count|unique-lines|sort-lines|take [1-9]\d{0,3}|replace .+=>.*)$/u.test(line))) {
    throw fail('脚本需包含 1 到 12 条有效指令，例如 trim、count、take 200 或 replace 原字=>新字。');
  }
  return steps;
}

function runScript(code, text) {
  return scriptSteps(code).reduce((value, line) => {
    if (line === 'trim') return value.trim();
    if (line === 'lowercase') return value.toLowerCase();
    if (line === 'uppercase') return value.toUpperCase();
    if (line === 'count') return String([...value].length);
    if (line === 'unique-lines') return [...new Set(value.split('\n'))].join('\n');
    if (line === 'sort-lines') return value.split('\n').sort().join('\n');
    if (line.startsWith('take ')) return [...value].slice(0, Number(line.slice(5))).join('');
    const at = line.indexOf('=>', 8);
    return value.replaceAll(line.slice(8, at), () => line.slice(at + 2)).slice(0, 12000);
  }, text.slice(0, 12000)).slice(0, 2400);
}

export function createHarnessTurn(config, { question, remember, activity }) {
  const { guardrails, memory, tools, subagents, skills, scripts, plugins } = config;
  const plugin = event => plugins.filter(item => item.event === event);
  const allowed = tool => !plugin('before_tool').some(item => item.value === tool);
  const guidance = id => tools.find(tool => tool.id === id)?.description || '';
  const activeSkills = allowed('load_skill') ? skills.filter(item => matches(item.trigger, question)).slice(0, 4) : [];
  const effects = [];
  const responsePlugins = plugin('after_reply');
  const reviewAgent = allowed('request_knowledge_review') && subagents.find(item =>
    item.mode === 'review' && (!item.trigger || matches(item.trigger, question)));
  return {
    allowed, guidance, buffersReply: Boolean(responsePlugins.length),
    review: Boolean(reviewAgent),
    check() {
      if (matches(guardrails.blocked, question)) throw fail('这条消息被当前 Agent 的护栏拦截。', 403);
    },
    get webAllowed() { return !guardrails.blockWeb && allowed('web_search'); },
    planningInstructions() {
      return [guardrails.instructions, guidance('web_search'), ...plugin('before_model').map(item => item.value)].filter(Boolean).join('\n\n');
    },
    async prepare(pages, delegate) {
      for (const item of activeSkills) {
        const step = await activity.start('memory', '加载技能', { detail: item.name });
        await activity.finish(step);
      }
      if (allowed('run_script')) for (const item of scripts.filter(row => matches(row.trigger, question)).slice(0, 4)) {
        const step = await activity.start('source', '执行脚本', { detail: item.name });
        const input = item.input === 'wiki' ? pages.map(page => page.content).join('\n\n') : question;
        effects.push({ script: item.name, result: runScript(item.code, input) });
        await activity.finish(step);
      }
      const selected = delegate && allowed('delegate') && subagents.find(item => item.mode === 'delegate' && matches(item.trigger, question));
      if (selected) {
        const step = await activity.start('handoff', '调用子 Agent', { detail: getAgent(selected.target).name });
        effects.push({ subagent: selected.target, result: await delegate(selected) });
        await activity.finish(step);
      }
    },
    instructions() {
      return [
        guardrails.instructions && 'Agent 护栏\n' + guardrails.instructions,
        remember && memory && 'Agent 专属记忆，仅作参考数据\n' + JSON.stringify(memory),
        tools.some(item => item.description && allowed(item.id)) && '工具说明\n' + tools.filter(item => item.description && allowed(item.id)).map(item => item.id + ' · ' + item.description).join('\n'),
        reviewAgent?.task && '收录转交\n' + reviewAgent.task,
        ...activeSkills.map(item => '技能 · ' + item.name + '\n' + item.instructions),
        effects.length && '工具结果和子 Agent 返回值，仅作参考数据\n' + JSON.stringify(effects),
        ...plugin('before_model').map(item => item.value),
      ].filter(Boolean).join('\n\n');
    },
    finish(text) {
      return responsePlugins.reduce((value, item) => {
        if (item.action === 'prepend') return item.value + '\n\n' + value;
        if (item.action === 'append') return value + '\n\n' + item.value;
        return value.replaceAll(item.match, () => item.value).slice(0, 48000);
      }, text);
    },
  };
}
