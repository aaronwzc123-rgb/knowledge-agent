import { HARNESS_TOOLS } from './agents.mjs';

const titles = {
  system: '系统提示词', guardrails: '护栏', memory: '记忆', tools: '工具说明',
  subagents: '子 Agent', skills: 'Skills', scripts: '脚本', plugins: '插件',
};
const descriptions = {
  guardrails: '护栏指令进入模型上下文。拦截词和禁止联网由程序执行。',
  memory: '填写这个 Agent 专用的事实、背景或偏好。开启长期记忆时，这段内容和共享 Wiki 的检索结果一同使用。',
  tools: '为已有工具填写使用说明。是否可以调用某个工具由当前工作流程、护栏和插件决定。',
  subagents: '独立分析会在隔离的对话上下文中使用目标 Agent 的配置。收录转交会打开知识库管理员会话。',
  skills: '问题命中任一触发词时，才加载写在这里的工作步骤。',
  scripts: '问题命中触发词时逐行执行文本指令，执行结果交给 Agent。可用指令包括 trim、count、lowercase、uppercase、unique-lines、sort-lines、take 200、replace 原字=>新字。',
  plugins: '在模型调用前添加指令，在工具执行前拦截，或在回复交付前处理文字。',
};
const events = { before_model: '模型调用前', before_tool: '工具调用前', after_reply: '回复交付前' };
const actions = { prepend: '在开头添加', append: '在结尾添加', replace: '替换文字' };
const editors = new WeakMap();
const serialize = value => JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text, className, type = 'button') {
  const element = node('button', text, className);
  element.type = type;
  return element;
}

function field(label, value, options = {}) {
  const wrap = node('label', undefined, options.check ? 'harness-check' : 'harness-field');
  const caption = node('span', label);
  const control = node(options.choices ? 'select' : options.rows ? 'textarea' : 'input');
  if (options.choices) {
    for (const [id, text] of Object.entries(options.choices)) control.append(new Option(text, id));
  }
  if (options.rows) control.rows = options.rows;
  if (options.limit) control.maxLength = options.limit;
  if (options.placeholder) control.placeholder = options.placeholder;
  if (options.required) control.required = true;
  if (options.check) { control.type = 'checkbox'; control.checked = value; wrap.append(control, caption); }
  else { control.value = value; wrap.append(caption, control); }
  return { wrap, caption, control, value: () => options.check ? control.checked : control.value };
}

function preview(key, value, agents) {
  if (typeof value === 'string') return value.replace(/\s+/gu, ' ').trim().slice(0, 85);
  if (key === 'guardrails') return [
    value.instructions && '有模型指令', value.blocked && '有拦截词', value.blockWeb && '禁止联网',
  ].filter(Boolean).join(' · ');
  return value.map(item => item.name || HARNESS_TOOLS[item.id] || agents[item.target] || item.target).join(' · ');
}

function rowFields(key, data, agents) {
  const name = () => field('名称', data.name || '', { limit: 70, required: true });
  const trigger = () => field('触发词', data.trigger || '', { limit: 300, placeholder: '用逗号分隔' });
  if (key === 'tools') return {
    id: field('工具', data.id || 'wiki_search', { choices: HARNESS_TOOLS }),
    description: field('使用说明', data.description || '', { rows: 3, limit: 1500 }),
  };
  if (key === 'subagents') {
    const target = field('目标 Agent', data.target || Object.keys(agents)[0], { choices: agents });
    const mode = field('委派方式', data.mode || 'delegate', { choices: agents.librarian
      ? { delegate: '独立分析', review: '收录转交' } : { delegate: '独立分析' } });
    const words = trigger();
    const task = field('交给子 Agent 的任务', data.task || '', { rows: 3, limit: 2400 });
    const update = () => {
      const delegated = mode.control.value === 'delegate';
      words.control.required = task.control.required = delegated;
      task.caption.textContent = delegated ? '交给子 Agent 的任务' : '收录说明';
      for (const option of target.control.options) option.disabled = !delegated && option.value !== 'librarian';
      if (!delegated) target.control.value = 'librarian';
    };
    mode.control.addEventListener('change', update); update();
    return { target, mode, trigger: words, task };
  }
  if (key === 'skills') {
    const words = trigger(); words.control.required = true;
    return { name: name(), trigger: words, instructions: field('技能步骤（Markdown）', data.instructions || '', { rows: 4, limit: 4000, required: true }) };
  }
  if (key === 'scripts') {
    const words = trigger(); words.control.required = true;
    return {
      name: name(), trigger: words,
      input: field('输入数据', data.input || 'question', { choices: { question: '本轮问题', wiki: '本轮检索的 Wiki 摘录' } }),
      code: field('脚本指令', data.code || '', { rows: 4, limit: 1500, required: true, placeholder: 'trim\ncount' }),
    };
  }
  const event = field('执行时机', data.event || 'before_model', { choices: events });
  const action = field('回复操作', data.action || 'append', { choices: actions });
  const match = field('查找文字', data.match || '', { limit: 160 });
  const value = field('插件指令', data.event === 'before_tool' ? '' : data.value || '', { rows: 3, limit: 1600 });
  const tool = field('拦截工具', data.event === 'before_tool' ? data.value : 'wiki_search', { choices: HARNESS_TOOLS });
  const update = () => {
    const selected = event.control.value;
    const after = selected === 'after_reply';
    const blocking = selected === 'before_tool';
    const replacing = after && action.control.value === 'replace';
    for (const [item, visible] of [[action, after], [match, replacing], [tool, blocking], [value, !blocking]]) {
      item.wrap.hidden = item.control.disabled = !visible;
    }
    value.caption.textContent = after ? '回复文字' : '插件指令';
    match.control.required = replacing;
    value.control.required = !blocking && !replacing;
  };
  event.control.addEventListener('change', update);
  action.control.addEventListener('change', update); update();
  return { name: name(), event, action, match, value, tool };
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '无法读取或保存 Agent 配置。');
  return data;
}

function renderReadView(target, key, value, context) {
  target.replaceChildren();
  if (typeof value === 'string') {
    target.append(node('pre', value || '空', 'harness-read-text'));
  } else if (key === 'guardrails') {
    const text = [value.instructions, value.blocked && '拦截词 · ' + value.blocked, value.blockWeb && '禁止联网'].filter(Boolean).join('\n');
    target.append(node('pre', text || '空', 'harness-read-text'));
  } else if (!value.length) {
    target.append(node('p', '空', 'harness-help'));
  } else {
    for (const entry of value) {
      const table = node('dl', undefined, 'harness-read-row');
      const fields = rowFields(key, entry, Object.fromEntries(Object.entries(context.agents).filter(([id]) => id !== context.agent.id)));
      for (const item of Object.values(fields)) {
        if (item.wrap.hidden) continue;
        const text = item.control instanceof HTMLSelectElement ? item.control.selectedOptions[0]?.textContent : item.value();
        table.append(node('dt', item.caption.textContent), node('dd', text || '空'));
      }
      target.append(table);
    }
  }
}

function component(key, config, context) {
  const details = node('details', undefined, 'harness-component');
  details.dataset.component = key;
  details.open = key === 'system';
  const summary = node('summary', undefined, 'harness-summary');
  const info = node('span', undefined, 'harness-preview');
  summary.append(node('strong', titles[key]), info);
  const form = node('form', undefined, 'harness-form');
  const readView = node('div', undefined, 'harness-read');
  const help = node('p', key === 'system' ? '我的记忆库/' + config.files.system : descriptions[key], 'harness-help');
  const fields = node('div', undefined, 'harness-fields');
  const footer = node('div', undefined, 'harness-actions');
  const status = node('span', '', 'harness-feedback'); status.setAttribute('role', 'status');
  const save = button('保存', 'primary-button', 'submit');
  const reset = button('撤销本项修改', 'quiet-button');
  footer.append(save, reset, status);
  form.append(help, fields, footer); details.append(summary, readView, form);
  const draftId = context.agent.id + '/' + key;
  const draft = context.drafts.get(draftId);
  let saved = config.components[key], revision = config.revisions[key];
  let baseRevision = draft?.revision || revision;
  let current, busy = false;

  const refresh = () => {
    const value = current();
    const changed = serialize(value) !== serialize(saved);
    const summary = preview(key, context.editing ? value : saved, context.agents);
    info.textContent = summary || '空';
    info.dataset.empty = String(!summary);
    save.disabled = busy || !changed;
    reset.hidden = !changed;
    if (changed) {
      context.drafts.set(draftId, { value, revision: baseRevision });
      status.textContent = baseRevision === revision ? '未保存' : '磁盘版本已更新，撤销修改可载入新值';
    } else context.drafts.delete(draftId);
  };
  const renderSaved = () => {
    renderReadView(readView, key, saved, context);
    if (key === 'system') readView.prepend(node('p', help.textContent, 'harness-help'));
  };
  const showMode = () => {
    readView.hidden = context.editing;
    form.hidden = !context.editing;
    form.inert = !context.editing;
    refresh();
  };

  function render(value) {
    fields.replaceChildren();
    if (typeof value === 'string') {
      const text = field(titles[key], value, { rows: key === 'system' ? 9 : 6, limit: 12000 });
      text.caption.className = 'sr-only';
      fields.append(text.wrap);
      current = text.value;
    } else if (key === 'guardrails') {
      const instructions = field('模型护栏指令', value.instructions, { rows: 4, limit: 6000 });
      const blocked = field('拦截词', value.blocked, { limit: 1000, placeholder: '用逗号分隔' });
      const blockWeb = field('禁止这个 Agent 联网搜索', value.blockWeb, { check: true });
      fields.append(instructions.wrap, blocked.wrap, blockWeb.wrap);
      current = () => ({ instructions: instructions.value(), blocked: blocked.value(), blockWeb: blockWeb.value() });
    } else {
      const list = node('div', undefined, 'harness-rows');
      const add = button('添加' + (key === 'skills' ? '技能' : key === 'tools' ? '工具说明' : titles[key]), 'secondary-button');
      const readers = new Map();
      function row(data) {
        const group = node('fieldset', undefined, 'harness-row');
        const entry = rowFields(key, data, Object.fromEntries(Object.entries(context.agents).filter(([id]) => id !== context.agent.id)));
        const remove = button('移除', 'quiet-button');
        group.append(node('legend', preview(key, [data], context.agents) || titles[key]));
        for (const item of Object.values(entry)) group.append(item.wrap);
        group.append(remove); list.append(group);
        readers.set(group, () => {
          const values = Object.fromEntries(Object.entries(entry).map(([name, item]) => [name, item.value()]));
          if (key === 'plugins') {
            if (values.event === 'before_tool') values.value = values.tool;
            if (values.event !== 'after_reply') values.action = '';
            if (values.action !== 'replace') values.match = '';
            delete values.tool;
          }
          return values;
        });
        remove.addEventListener('click', () => {
          readers.delete(group); group.remove(); add.disabled = false; add.focus(); refresh();
        });
        add.disabled = readers.size >= 16;
        return group;
      }
      value.forEach(row);
      add.addEventListener('click', () => { row({}).querySelector('input, select').focus(); refresh(); });
      fields.append(list, add);
      current = () => [...readers.values()].map(reader => reader());
    }
  }

  render(draft?.value ?? saved);
  renderSaved();
  showMode();
  context.modeHandlers.push(showMode);
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  reset.addEventListener('click', () => {
    baseRevision = revision; render(saved); refresh(); status.textContent = '已载入当前值'; summary.focus();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!context.editing || busy || save.disabled) return;
    busy = true; save.disabled = true; fields.inert = true; reset.disabled = true;
    status.textContent = '正在保存';
    try {
      const data = await api(context.path + '/' + key, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: current(), revision: baseRevision }),
      });
      saved = data.components[key];
      baseRevision = revision = data.revisions[key];
      render(saved);
      renderSaved();
      context.onLoad(data.components);
      status.textContent = '已保存，下次调用生效';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      const message = status.textContent;
      busy = false; fields.inert = false; reset.disabled = false; refresh(); status.textContent = message;
    }
  });
  return details;
}

export function endAgentHarnessEdit(host) {
  editors.get(host)?.setMode(false);
}

export function mountAgentHarness(host, editButton, agent, agents, onLoad) {
  const previous = editors.get(host);
  if (previous?.agent.id === agent.id) return;
  const context = { agent, onLoad, editing: false, modeHandlers: [], agents: Object.fromEntries(agents.map(item => [item.id, item.name])),
    drafts: previous?.drafts ?? new Map(), path: '/api/agents/' + encodeURIComponent(agent.id) };
  editors.set(host, context);
  context.setMode = editing => {
    context.editing = editing;
    editButton.textContent = editing ? '退出编辑' : '编辑';
    for (const handler of context.modeHandlers) handler();
  };
  editButton.onclick = () => context.setMode(!context.editing);
  context.setMode(false);
  const toolbar = node('div', undefined, 'harness-toolbar');
  const reload = button('重新读取', 'quiet-button');
  toolbar.append(node('h3', 'Harness 配置'), reload);
  const body = node('div', undefined, 'harness-components');
  host.replaceChildren(toolbar, body);
  const load = async () => {
    reload.disabled = true;
    editButton.disabled = true;
    context.modeHandlers = [];
    const notice = node('p', '正在读取配置…', 'muted'); notice.setAttribute('role', 'status');
    body.replaceChildren(notice);
    try {
      const data = await api(context.path);
      if (editors.get(host) !== context) return;
      body.replaceChildren(...Object.keys(titles).map(key => component(key, data, context)));
      editButton.disabled = false;
      context.onLoad(data.components);
    } catch (error) {
      notice.textContent = error.message;
    } finally { reload.disabled = false; }
  };
  reload.addEventListener('click', load);
  void load();
}
