import { NODE_TYPES, CONDITIONS, TEMPLATES, EMAIL_EXAMPLES, defaultNodeConfig, edgePorts, outputKeys } from './workflow-schema.mjs';
import { getAgent } from './agents.mjs';

const $ = id => document.getElementById(id);
const API = '/api/workflows';
const labels = { running: '运行中', complete: '已完成', failed: '失败', skipped: '已跳过', stopped: '已停止' };
const branches = { yes: 'IF', no: 'ELSE', next: '下一步' };
const make = (tag, classes, text) => {
  const item = document.createElement(tag);
  if (classes) item.className = classes;
  if (text !== undefined) item.textContent = text;
  return item;
};
const button = (text, action, classes = 'secondary-button') => {
  const item = make('button', classes, text);
  item.type = 'button';
  item.addEventListener('click', action);
  return item;
};
const timeLabel = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const printable = value => typeof value === 'string' ? value || '（空）' : JSON.stringify(value, null, 2);

export async function streamWorkflow(id, body, signal, apiError, receive) {
  const response = await fetch(API + '/' + id + '/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify(body),
  });
  if (!response.ok) throw await apiError(response);
  let pending = '';
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const records = (pending + value).split('\n');
    pending = records.pop();
    for (const line of records) receive(JSON.parse(line));
  }
}

export function mountWorkflowEditor({ jsonApi, apiError, getAgents, getConnection, openSettings, setTitle, closeList }) {
  const viewport = $('wf-viewport'), stage = $('wf-stage'), edges = $('wf-edges'), nodes = $('wf-nodes');
  const panel = $('wf-panel'), body = $('wf-panel-body'), dialog = $('wf-template-dialog');
  const add = $('wf-add'), name = $('wf-name');
  let workflows = [], flow = null, draft = null, run = null, chosen = null, detail = '', entries = null, inputs = {};
  let controller = null, saving = false, request = 0, historyRequest = 0, search = '', connection = null;
  let view = { x: 0, y: 0, zoom: 1 }, gesture = null, frame = 0;
  let fieldNumber = 0;
  const items = new Map();
  const graph = () => draft || run?.flow || flow;
  const busy = () => saving || !!controller;
  const failed = message => { const element = $('wf-error'); element.textContent = message; element.hidden = !message; };
  const safe = action => async (...args) => {
    failed('');
    try { await action(...args); } catch (error) { failed(error.message); }
  };
  const allowDiscard = () => !draft || JSON.stringify(draft) === JSON.stringify(flow) || confirm('放弃工作流中未保存的修改？');
  const nodeFor = id => graph()?.nodes.find(node => node.id === id);
  const stepFor = id => run?.steps.find(step => step.id === id);

  function toolbar() {
    const text = $('wf-state');
    const next = flow?.deleted ? '工作流已删除' : connection ? '选择目标输入端口' : draft ? '编辑中'
      : run ? labels[run.status] + ' · 版本 ' + run.flow.revision
      : flow ? flow.nodes.length + ' 个节点 · 版本 ' + flow.revision : '';
    if (next !== text.textContent) text.textContent = next;
    $('wf-edit').hidden = $('wf-test').hidden = $('wf-delete').hidden = !flow || flow.deleted || !!draft || !!controller;
    $('wf-edit').disabled = $('wf-test').disabled = $('wf-history').disabled = !flow || !!draft || busy();
    $('new-workflow').disabled = $('wf-empty-new').disabled = $('wf-delete').disabled = busy();
    $('wf-empty').hidden = !!flow;
    $('wf-stop').hidden = !controller;
    for (const element of [add, name, $('wf-save'), $('wf-cancel-edit')]) {
      element.hidden = !draft;
      element.disabled = saving;
    }
  }
  function filter(value) {
    search = value.toLowerCase().trim();
    const target = $('workflow-list');
    target.replaceChildren();
    const matches = workflows.filter(row => row.name.toLowerCase().includes(search));
    if (!matches.length && search) target.append(make('p', 'side-empty', '未找到工作流'));
    for (const item of matches) {
      const icon = make('span', 'row-avatar', '⑂'); icon.setAttribute('aria-hidden', 'true');
      const row = button('', safe(async () => {
        if (busy() || !allowDiscard()) return;
        const sequence = ++request;
        const selected = await jsonApi(API + '/' + item.id);
        if (sequence !== request) return;
        activate(selected);
        closeList();
      }), 'agent-row' + (item.id === flow?.id ? ' selected' : ''));
      row.disabled = busy();
      if (item.id === flow?.id) row.setAttribute('aria-current', 'true');
      row.append(icon, make('span', 'row-title', item.name));
      target.append(row);
    }
  }
  async function refreshCatalog() {
    workflows = await jsonApi(API);
    filter(search);
  }
  function activate(selected) {
    flow = selected;
    draft = run = chosen = connection = null;
    detail = '';
    delete viewport.dataset.connecting;
    inputs = {};
    setTitle(flow?.name || '工作流');
    render();
    filter(search);
    requestAnimationFrame(fit);
  }
  async function open() {
    const sequence = ++request;
    await refreshCatalog();
    if (sequence !== request) return;
    if (flow && (flow.deleted || workflows.some(item => item.id === flow.id))) {
      setTitle(flow.name); requestAnimationFrame(drawEdges); return;
    }
    if (!workflows.length) { activate(null); return; }
    const selected = await jsonApi(API + '/' + workflows[0].id);
    if (sequence === request) activate(selected);
  }
  async function openExecution(id, runId) {
    if (busy() || !allowDiscard()) return;
    const sequence = ++request;
    const [selected, execution] = await Promise.all([
      jsonApi(API + '/' + id), jsonApi(API + '/' + id + '/runs/' + runId),
    ]);
    if (sequence !== request) return;
    activate(selected);
    run = execution;
    detail = 'run';
    render();
  }
  function render() {
    toolbar();
    paintNodes();
    paintPanel();
  }

  function place(element, node) {
    element.style.left = node.x + 'px';
    element.style.top = node.y + 'px';
  }
  function inspect(id, move = false) {
    chosen = id;
    detail = 'node';
    paintSteps();
    paintPanel();
    if (move) requestAnimationFrame(() => centerNode(id));
  }
  function paintNodes() {
    nodes.replaceChildren();
    items.clear();
    viewport.classList.toggle('editing', !!draft);
    for (const node of graph()?.nodes || []) {
      const meta = NODE_TYPES[node.type];
      const card = make('article', 'wf-node'); card.dataset.node = node.id; card.dataset.type = node.type;
      place(card, node);
      const label = button('', () => inspect(node.id), 'wf-node-label');
      label.dataset.drag = node.id;
      const symbol = make('span', 'wf-node-icon', meta.icon); symbol.setAttribute('aria-hidden', 'true');
      const title = make('strong', 'wf-node-title', node.title);
      label.append(symbol, title);
      const sub = make('span', 'wf-node-sub');
      card.append(label, sub);
      const handles = {};
      if (node.type !== 'start') {
        handles.input = portButton('input', '输入端口');
        card.append(handles.input);
      }
      for (const port of edgePorts(node.type)) {
        handles[port] = portButton(port, branches[port] + '输出端口');
        if (node.type === 'condition') handles[port].append(make('span', 'wf-branch-label', branches[port]));
        card.append(handles[port]);
      }
      function portButton(port, description) {
        const handle = button('', () => {
          if (!draft || saving) return;
          if (port === 'input') completeConnection(node.id);
          else selectPort(node.id, port);
        }, 'wf-port');
        handle.dataset.port = port;
        handle.tabIndex = draft ? 0 : -1;
        if (!draft) handle.setAttribute('aria-hidden', 'true');
        handle.setAttribute('aria-label', node.title + ' · ' + description);
        return handle;
      }
      items.set(node.id, { card, label, title, sub, handles });
      nodes.append(card);
    }
    paintSteps();
  }
  function paintSteps() {
    for (const [id, item] of items) {
      const step = stepFor(id), node = nodeFor(id);
      const status = step?.status || '';
      item.card.dataset.status = status;
      item.card.dataset.chosen = String(id === chosen && detail === 'node');
      item.label.setAttribute('aria-pressed', item.card.dataset.chosen);
      const description = node.type === 'agent' && node.config.agent ? getAgent(node.config.agent).name : NODE_TYPES[node.type].name;
      item.sub.textContent = description + (status ? ' · ' + labels[status] : '');
      for (const [port, handle] of Object.entries(item.handles)) {
        handle.dataset.pending = String(connection?.from === id && connection.port === port);
      }
    }
    queueEdges();
  }
  function queueEdges() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawEdges(); });
  }
  function drawEdges() {
    const rect = stage.getBoundingClientRect();
    function point(handle) {
      if (!handle) return null;
      const b = handle.getBoundingClientRect();
      return { x: (b.left + b.width / 2 - rect.left) / view.zoom, y: (b.top + b.height / 2 - rect.top) / view.zoom };
    }
    function wire(a, b, state) {
      if (!a || !b) return null;
      const gap = Math.max(45, Math.abs(b.x - a.x) * .44);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', ['M', a.x, a.y, 'C', a.x + gap, a.y, b.x - gap, b.y, b.x, b.y].join(' '));
      path.dataset.state = state;
      return path;
    }
    const lines = [];
    for (const edge of graph()?.edges || []) {
      const source = stepFor(edge.from), target = stepFor(edge.to);
      const branchSkipped = source?.output?.branch && source.output.branch !== branches[edge.port];
      const state = branchSkipped || [source?.status, target?.status].includes('skipped') ? 'skipped'
        : source?.status === 'complete' && target?.status ? 'complete' : '';
      lines.push(wire(point(items.get(edge.from)?.handles[edge.port]), point(items.get(edge.to)?.handles.input), state));
    }
    if (connection && gesture?.kind === 'wire' && gesture.moving) {
      lines.push(wire(point(items.get(connection.from)?.handles[connection.port]), gesture.cursor, 'pending'));
    }
    edges.replaceChildren(...lines.filter(Boolean));
  }
  function syncView() {
    stage.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.zoom + ')';
  }
  function fit() {
    const list = graph()?.nodes;
    const { clientWidth: width, clientHeight: height } = viewport;
    if (!list?.length || !width || !height) return;
    const minX = Math.min(...list.map(node => node.x)), maxX = Math.max(...list.map(node => node.x + 190));
    const minY = Math.min(...list.map(node => node.y)), maxY = Math.max(...list.map(node => node.y + 100));
    const zoom = Math.max(.16, Math.min(1, (width - 40) / (maxX - minX), (height - 85) / (maxY - minY)));
    view = { zoom, x: (width - (maxX + minX) * zoom) / 2, y: (height - (maxY + minY) * zoom) / 2 - 14 };
    syncView();
    queueEdges();
  }
  function centerNode(id) {
    const node = nodeFor(id);
    if (!node) return;
    const zoom = Math.max(view.zoom, Math.min(1, viewport.clientWidth / 235));
    const height = panel.hidden || viewport.clientWidth > 650 ? viewport.clientHeight : viewport.clientHeight * .55;
    view = { zoom, x: viewport.clientWidth / 2 - (node.x + 95) * zoom, y: height / 2 - (node.y + 42) * zoom };
    syncView();
  }
  function zoomBy(factor, localX = viewport.clientWidth / 2, localY = viewport.clientHeight / 2) {
    const zoom = Math.min(2, Math.max(.16, view.zoom * factor)), delta = zoom / view.zoom;
    view = { zoom, x: localX - (localX - view.x) * delta, y: localY - (localY - view.y) * delta };
    syncView();
  }
  function selectPort(from, port) {
    connection = { from, port };
    viewport.dataset.connecting = 'true';
    failed('');
    toolbar();
    paintSteps();
  }
  function clearConnection() {
    connection = null;
    delete viewport.dataset.connecting;
    failed('');
    toolbar();
    paintSteps();
  }
  function completeConnection(to, canvas = true) {
    if (!connection || !draft || saving) return;
    const edge = { ...connection, to };
    clearConnection();
    if (edge.from === to) return;
    if (draft.edges.some(item => item.from === edge.from && item.to === to && item.port === edge.port)) {
      failed('这条连线已经存在。');
      return;
    }
    const reached = descendants(to, draft.edges);
    if (reached.has(edge.from)) { failed('这条连线会形成循环。'); return; }
    draft.edges.push(edge);
    render();
    if (canvas) items.get(to)?.handles.input?.focus({ preventScroll: true });
  }
  function descendants(id, links, key = 'from') {
    const reached = new Set([id]);
    const other = key === 'from' ? 'to' : 'from';
    for (const item of reached) for (const edge of links) {
      if (edge[key] === item) reached.add(edge[other]);
    }
    reached.delete(id);
    return reached;
  }
  function moveNode(id, x, y) {
    const node = nodeFor(id);
    node.x = Math.round(Math.max(-12000, Math.min(12000, x)));
    node.y = Math.round(Math.max(-12000, Math.min(12000, y)));
    place(items.get(id).card, node);
    queueEdges();
  }
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    const card = event.target.closest('.wf-node'), port = event.target.closest('[data-port]');
    const node = card && nodeFor(card.dataset.node);
    const base = { id: event.pointerId, x: event.clientX, y: event.clientY, moving: false };
    if (!card) gesture = { ...base, kind: 'pan', start: { ...view } };
    else if (draft && !saving && port && port.dataset.port !== 'input') gesture = { ...base, kind: 'wire', from: node.id, port: port.dataset.port };
    else if (draft && !saving && event.target.closest('[data-drag]')) gesture = { ...base, kind: 'node', node: node.id, start: { x: node.x, y: node.y } };
  });
  viewport.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.moving && Math.hypot(dx, dy) < 5) return;
    if (!gesture.moving) {
      gesture.moving = true;
      viewport.setPointerCapture(event.pointerId);
      viewport.dataset.dragging = 'true';
      if (gesture.kind === 'wire') selectPort(gesture.from, gesture.port);
    }
    if (gesture.kind === 'pan') {
      view.x = gesture.start.x + dx; view.y = gesture.start.y + dy;
      syncView();
    } else if (gesture.kind === 'node') {
      moveNode(gesture.node, gesture.start.x + dx / view.zoom, gesture.start.y + dy / view.zoom);
    } else {
      const bounds = stage.getBoundingClientRect();
      gesture.cursor = { x: (event.clientX - bounds.left) / view.zoom, y: (event.clientY - bounds.top) / view.zoom };
      queueEdges();
    }
  });
  function endGesture(event) {
    if (!gesture || gesture.id !== event.pointerId) return;
    const finished = gesture;
    gesture = null;
    delete viewport.dataset.dragging;
    if (finished.kind === 'wire' && finished.moving) {
      const handle = event.type === 'pointerup' && document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-port=input]');
      if (handle) completeConnection(handle.closest('[data-node]').dataset.node);
      else clearConnection();
    }
  }
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(event, endGesture);
  viewport.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) {
      view.x -= event.deltaX; view.y -= event.deltaY;
      syncView();
    } else {
      const bounds = viewport.getBoundingClientRect();
      zoomBy(Math.exp(-event.deltaY / 450), event.clientX - bounds.left, event.clientY - bounds.top);
    }
    event.preventDefault();
  }, { passive: false });
  viewport.addEventListener('keydown', event => {
    if (event.key === 'Escape' && connection) { clearConnection(); return; }
    const delta = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }[event.key];
    if (!delta) return;
    const [dx, dy] = delta;
    const id = event.target.dataset.drag;
    if (id && draft && !saving) {
      const node = nodeFor(id);
      moveNode(id, node.x + dx, node.y + dy);
    } else if (event.target === viewport) {
      view.x -= dx; view.y -= dy;
      syncView();
    } else return;
    event.preventDefault();
  });
  let lastSize = 0;
  new ResizeObserver(() => {
    const width = viewport.clientWidth;
    if (!width) return;
    if (!lastSize || Math.abs(lastSize - width) > 40) fit();
    lastSize = width;
  }).observe(viewport);

  function display(title, value, open = false) {
    const box = make('details', 'wf-data');
    box.open = open;
    box.append(make('summary', '', title), make('pre', '', printable(value)));
    body.append(box);
  }
  function field(target, label, value, onChange, { options, multiline, type = 'text', required = false } = {}) {
    const wrap = make('div', 'wf-field');
    const caption = make('label', '', label);
    const control = make(options ? 'select' : multiline ? 'textarea' : 'input');
    caption.htmlFor = control.id = 'wf-field-' + ++fieldNumber;
    if (options) for (const [key, description] of options) control.add(new Option(description, key));
    else if (multiline) control.rows = 4;
    else control.type = type;
    if (type === 'checkbox') control.checked = value;
    else control.value = value;
    control.required = required;
    if (!onChange) control.disabled = true;
    else control.addEventListener(options || type === 'checkbox' ? 'change' : 'input', () =>
      onChange(type === 'checkbox' ? control.checked : control.value));
    wrap.append(caption, control);
    target.append(wrap);
    return control;
  }
  function paintNodePanel() {
    const node = nodeFor(chosen);
    if (!node) return;
    const meta = NODE_TYPES[node.type], config = node.config, step = stepFor(chosen);
    const editable = !!draft && !saving;
    const section = make('div', 'wf-config');
    body.append(make('p', 'wf-hint', meta.help));
    if (step) {
      body.append(make('p', 'wf-step-result', labels[step.status] + (step.elapsed == null ? '' : ' · ' + (step.elapsed / 1000).toFixed(2) + ' 秒')));
      if (step.error) body.append(make('p', 'wf-error', step.error));
      if (step.input !== null) display('本次输入', step.input);
      if (step.output !== null) display('本次输出', step.output, true);
    }
    const upstream = descendants(node.id, graph().edges, 'to');
    const variables = graph().nodes.filter(item => upstream.has(item.id)).flatMap(item =>
      outputKeys(item).map(key => [item.id + '.' + key, item.title + ' → ' + key]));
    const variableOptions = value => [
      ['', variables.length ? '选择变量' : '连接上游节点后选择'], ...variables,
      ...(value && !variables.some(([id]) => id === value) ? [[value, value + '（未连接）']] : []),
    ];
    const edit = (target, label, record, key, opts) =>
      field(target, label, record[key], editable ? value => { record[key] = value; } : null, opts);
    if (editable) field(section, '节点名称', node.title, value => {
      node.title = value;
      items.get(node.id).title.textContent = value;
      $('wf-panel-title').textContent = value || meta.name;
    });
    if (node.type === 'condition') {
      edit(section, '变量', config, 'variable', { options: variableOptions(config.variable) });
      edit(section, '判断规则', config, 'operator', { options: Object.entries(CONDITIONS) });
      edit(section, '匹配值', config, 'value');
    }
    if (node.type === 'wiki') {
      edit(section, '知识来源', config, 'source', { options: [['wiki', '我的 Obsidian Wiki'], ['example', '模板示例资料']] });
      edit(section, '查询文本', config, 'query', { options: variableOptions(config.query) });
    }
    if (node.type === 'llm') {
      const models = [...$('model').options].map(option => [option.value, option.textContent]);
      if (config.model && !models.some(([id]) => id === config.model)) models.push([config.model, config.model]);
      edit(section, '模型', config, 'model', { options: [['', '使用当前连接的模型'], ...models] });
      edit(section, '系统提示词', config, 'system', { multiline: true });
    }
    if (node.type === 'agent') {
      const active = getAgents().map(agent => [agent.id, agent.name]);
      if (config.agent && !active.some(([id]) => id === config.agent)) {
        active.push([config.agent, getAgent(config.agent).name + '（已删除）']);
      }
      field(section, '执行 Agent', config.agent, editable ? value => {
        config.agent = value; paintSteps();
      } : null, { options: [['', '选择 Agent'], ...active] });
      edit(section, '使用 Agent 记忆和本地 Wiki', config, 'remember', { type: 'checkbox' });
    }
    if (node.type === 'llm' || node.type === 'agent') {
      const prompt = edit(section, node.type === 'agent' ? '本步任务' : '用户提示词', config, 'prompt', { multiline: true });
      if (editable && variables.length) {
        const picker = field(section, '插入变量', '', ref => {
          if (!ref) return;
          prompt.setRangeText('{{' + ref + '}}', prompt.selectionStart, prompt.selectionEnd, 'end');
          config.prompt = prompt.value;
          picker.value = '';
          prompt.focus();
        }, { options: [['', '选择插入到用户提示词的变量'], ...variables] });
      }
    }
    if (node.type === 'aggregate') {
      config.variables.forEach((ref, i) => {
        const row = make('div', 'wf-collection');
        edit(row, '变量 ' + (i + 1), config.variables, i, { options: variableOptions(ref) });
        if (editable) row.append(button('移除', () => { config.variables.splice(i, 1); paintPanel(); }, 'quiet-button'));
        section.append(row);
      });
      if (editable && config.variables.length < 12) section.append(button('＋ 添加聚合变量', () => { config.variables.push(''); paintPanel(); }));
    }
    if (['start', 'output'].includes(node.type)) {
      config.fields.forEach((item, i) => {
        const row = make('div', 'wf-collection');
        edit(row, '变量名', item, 'name');
        if (node.type === 'start') {
          edit(row, '显示名称', item, 'label');
          edit(row, '输入类型', item, 'type', { options: [['text', '单行文本'], ['paragraph', '多行文本']] });
          edit(row, '必填', item, 'required', { type: 'checkbox' });
        } else edit(row, '上游变量', item, 'variable', { options: variableOptions(item.variable) });
        if (editable) row.append(button('移除字段', () => { config.fields.splice(i, 1); paintPanel(); }, 'quiet-button'));
        section.append(row);
      });
      if (editable && config.fields.length < 12) section.append(button('＋ 添加字段', () => {
        const fieldName = 'field_' + crypto.randomUUID().slice(0, 5);
        config.fields.push(node.type === 'start' ? { name: fieldName, label: '输入字段', type: 'text', required: true }
          : { name: fieldName, variable: '' });
        paintPanel();
      }));
    }
    body.append(section);
    const outbound = graph().edges.filter(item => item.from === node.id);
    const inbound = graph().edges.filter(item => item.to === node.id);
    const ports = edgePorts(node.type);
    if (outbound.length || inbound.length || editable && ports.length) {
      const links = make('div', 'wf-links');
      links.append(make('h4', '', '连线'));
      for (const edge of [...inbound, ...outbound]) {
        const row = make('div', '', '');
        row.append(make('span', '', nodeFor(edge.from).title + ' → ' + nodeFor(edge.to).title + (edge.port === 'next' ? '' : ' · ' + branches[edge.port])));
        if (editable) row.append(button('断开', () => { draft.edges = draft.edges.filter(item => item !== edge); render(); }, 'quiet-button'));
        links.append(row);
      }
      if (editable && ports.length) {
        const connect = make('section', 'wf-config wf-connect');
        let target = '', port = ports[0];
        const link = button('连接', () => {
          connection = { from: node.id, port };
          completeConnection(target, false);
        });
        link.disabled = true;
        if (ports.length > 1) field(connect, '分支', port, value => { port = value; }, {
          options: ports.map(id => [id, branches[id]]),
        });
        field(connect, '目标节点', target, value => { target = value; link.disabled = !target; }, {
          options: [['', '选择节点'], ...draft.nodes.filter(item => item !== node && item.type !== 'start').map(item => [item.id, item.title])],
        });
        connect.append(link); links.append(connect);
      }
      body.append(links);
    }
    if (editable && !['start', 'output'].includes(node.type)) body.append(button('移除节点', () => {
      draft.nodes = draft.nodes.filter(item => item !== node);
      draft.edges = draft.edges.filter(item => item.from !== node.id && item.to !== node.id);
      chosen = null; detail = '';
      clearConnection();
      render();
    }, 'secondary-button danger'));
  }
  function paintRunPanel() {
    if (run) {
      body.append(make('p', 'wf-step-result', labels[run.status] + ' · ' + timeLabel(run.started)));
      if (run.error) body.append(make('p', 'wf-error', run.error));
      if (run.output) for (const [key, value] of Object.entries(run.output)) display(key, value, true);
      for (const step of run.steps) body.append(button(nodeFor(step.id).title + ' · ' + labels[step.status], () => inspect(step.id, true), 'wf-step-button'));
      if (!controller && !flow.deleted) body.append(button('再次试运行', openRun, 'primary-button'));
      return;
    }
    const form = make('form', 'wf-config');
    const fields = flow.nodes.find(node => node.type === 'start').config.fields;
    if (fields.some(item => item.name === 'customer_name') && fields.some(item => item.name === 'email_content')) {
      const examples = make('div', 'wf-examples');
      EMAIL_EXAMPLES.forEach((value, i) => examples.append(button(i ? '普通咨询示例' : '产品咨询示例', () => {
        inputs = { ...inputs, ...value };
        paintPanel();
      }, 'quiet-button')));
      form.append(examples);
    }
    for (const item of fields) field(form, item.label, Object.hasOwn(inputs, item.name) ? inputs[item.name] : '', value => { inputs[item.name] = value; }, {
      multiline: item.type === 'paragraph', required: item.required,
    });
    const submit = make('button', 'primary-button', '开始运行'); submit.type = 'submit';
    form.append(submit);
    form.addEventListener('submit', event => { event.preventDefault(); void safe(startRun)(); });
    body.append(form);
  }
  function paintPanel() {
    panel.hidden = !detail;
    if (!detail) return;
    const pane = $('wf-panel-title');
    pane.textContent = detail === 'node' ? nodeFor(chosen)?.title || '节点' : { run: run ? '本次运行' : '试运行', history: '运行历史', nodes: '节点列表' }[detail];
    const scroll = body.scrollTop;
    body.replaceChildren();
    if (detail === 'node') paintNodePanel();
    if (detail === 'run') paintRunPanel();
    if (detail === 'history') {
      if (!entries?.length) body.append(make('p', 'wf-hint', entries ? '暂无运行记录。' : '加载运行记录…'));
      for (const entry of entries || []) body.append(button(labels[entry.status] + ' · ' + timeLabel(entry.started), safe(async () => {
        const id = flow.id, sequence = ++historyRequest;
        const execution = await jsonApi(API + '/' + id + '/runs/' + entry.id);
        if (sequence !== historyRequest || flow.id !== id || detail !== 'history') return;
        run = execution;
        chosen = null; detail = 'run';
        render(); requestAnimationFrame(fit);
      }), 'wf-step-button'));
    }
    if (detail === 'nodes') for (const node of graph()?.nodes || []) {
      body.append(button(node.title + ' · ' + NODE_TYPES[node.type].name, () => inspect(node.id, true), 'wf-step-button'));
    }
    body.scrollTop = scroll;
  }
  function openRun() {
    if (!flow || flow.deleted) return;
    const resize = run && run.flow.revision !== flow.revision;
    run = null; chosen = null; detail = 'run';
    render();
    if (resize) requestAnimationFrame(fit);
  }
  async function startRun() {
    if (busy() || draft || !flow || flow.deleted) return;
    const { apiKey, model } = getConnection();
    if (!apiKey && flow.nodes.some(node => ['llm', 'agent'].includes(node.type))) { openSettings(); return; }
    const active = new AbortController();
    controller = active;
    run = { flow, steps: [], started: new Date().toISOString(), status: 'running' };
    render(); filter(search);
    try {
      await streamWorkflow(flow.id, { apiKey, model, inputs, revision: flow.revision }, active.signal, apiError, event => {
        if (event.step) {
          const i = run.steps.findIndex(step => step.id === event.step.id);
          if (i < 0) run.steps.push(event.step);
          else run.steps[i] = event.step;
        } else Object.assign(run, event);
        toolbar(); paintSteps();
        if (detail === 'run' || detail === 'node' && chosen === event.step?.id) paintPanel();
      });
      if (run.status === 'running') throw new Error('运行连接中断。');
    } catch (error) {
      run.status = active.signal.aborted ? 'stopped' : 'failed';
      run.error = active.signal.aborted ? '' : error.message;
      for (const step of run.steps) if (step.status === 'running') step.status = run.status;
    } finally {
      controller = null;
      toolbar(); paintSteps(); paintPanel(); filter(search);
    }
  }

  for (const [type, spec] of Object.entries(NODE_TYPES)) if (!['start', 'output'].includes(type)) add.add(new Option(spec.name, type));
  add.addEventListener('change', () => {
    const type = add.value;
    add.value = '';
    if (!draft || !type || saving) return;
    if (draft.nodes.length >= 36) { failed('每个工作流最多添加 36 个节点。'); return; }
    const id = 'n' + crypto.randomUUID().slice(0, 8);
    const selected = nodeFor(chosen);
    draft.nodes.push({ id, type, title: NODE_TYPES[type].name, config: defaultNodeConfig(type),
      x: selected ? selected.x + 225 : Math.round((viewport.clientWidth / 2 - view.x) / view.zoom - 95),
      y: selected ? selected.y + 110 : Math.round((viewport.clientHeight / 2 - view.y) / view.zoom - 40) });
    paintNodes(); inspect(id, true);
  });
  $('wf-edit').addEventListener('click', () => {
    if (!flow || flow.deleted || busy()) return;
    const resize = run && run.flow.revision !== flow.revision;
    run = null; draft = structuredClone(flow);
    name.value = draft.name;
    detail = chosen && nodeFor(chosen) ? 'node' : '';
    render();
    if (resize) requestAnimationFrame(fit);
    name.focus();
  });
  name.addEventListener('input', () => { if (draft) draft.name = name.value; });
  $('wf-save').addEventListener('click', safe(async () => {
    if (!draft || saving) return;
    saving = true; toolbar(); paintPanel(); filter(search);
    try {
      flow = await jsonApi(API + '/' + flow.id, draft, { method: 'PUT' });
      draft = null; connection = null;
      delete viewport.dataset.connecting;
      setTitle(flow.name);
      workflows = await jsonApi(API);
    } finally { saving = false; render(); filter(search); }
  }));
  $('wf-cancel-edit').addEventListener('click', () => {
    if (!allowDiscard()) return;
    draft = chosen = null; detail = ''; clearConnection();
    render(); requestAnimationFrame(fit); $('wf-edit').focus();
  });
  $('wf-test').addEventListener('click', openRun);
  $('wf-delete').addEventListener('click', safe(async () => {
    if (!flow || flow.deleted || draft || busy()) return;
    if (!confirm('删除「' + flow.name + '」？对话中已有的运行链接仍可打开。')) return;
    saving = true; toolbar(); filter(search);
    try {
      const { id, revision } = flow;
      await jsonApi(API + '/' + id, { revision }, { method: 'DELETE' });
      workflows = workflows.filter(item => item.id !== id);
      activate(null);
      await open();
    } finally { saving = false; toolbar(); filter(search); }
  }));
  $('wf-stop').addEventListener('click', () => controller?.abort());
  $('wf-history').addEventListener('click', safe(async () => {
    detail = 'history'; chosen = null; entries = null;
    paintSteps(); paintPanel();
    const sequence = ++historyRequest, id = flow.id;
    entries = await jsonApi(API + '/' + id + '/runs');
    if (sequence !== historyRequest || flow?.id !== id || detail !== 'history') return;
    paintSteps(); paintPanel();
  }));
  $('wf-zoom-out').addEventListener('click', () => zoomBy(.8));
  $('wf-zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('wf-fit').addEventListener('click', fit);
  $('wf-node-list').addEventListener('click', () => { detail = 'nodes'; paintSteps(); paintPanel(); });
  $('wf-close-panel').addEventListener('click', () => {
    detail = '';
    paintSteps(); paintPanel();
    if (chosen) items.get(chosen)?.label.focus({ preventScroll: true });
    else $('wf-node-list').focus();
  });
  function showTemplates() {
    if (!busy() && allowDiscard()) dialog.showModal();
  }
  $('new-workflow').addEventListener('click', showTemplates);
  $('wf-empty-new').addEventListener('click', showTemplates);
  $('wf-close-templates').addEventListener('click', () => dialog.close());
  const choices = $('wf-templates');
  for (const [template, spec] of Object.entries(TEMPLATES)) {
    const option = button('', async () => {
      if (busy()) return;
      saving = true; toolbar();
      const message = $('wf-template-error');
      message.hidden = true;
      try {
        const selected = await jsonApi(API, { template });
        workflows = await jsonApi(API);
        request++;
        dialog.close(); closeList(); activate(selected);
      } catch (error) { message.textContent = error.message; message.hidden = false; }
      finally { saving = false; toolbar(); filter(search); }
    }, 'wf-template');
    option.append(make('strong', '', spec.name), make('span', '', spec.description));
    choices.append(option);
  }
  return { open: safe(open), filter, refreshCatalog, catalog: () => workflows, openExecution: safe(openExecution) };
}
