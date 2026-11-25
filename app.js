import { AGENTS, agentNames, getAgent, conversationContext, parseAgentMentions, reviewConfigured } from './agents.mjs';
import { createKnowledgeGraph } from './graph.js';
import { endAgentHarnessEdit, mountAgentHarness } from './agent-editor.js';
import { mountUpstreamHarness2 } from './harness2-panel.js';
import { mountWorkflowEditor, streamWorkflow } from './workflow-editor.js';
import { formatWorkflowOutput } from './workflow-schema.mjs';

const $ = id => document.getElementById(id);
const synth = window.speechSynthesis;
const state = {
  view: 'chat', agent: 'qa', detailAgent: 'qa', agents: Object.values(AGENTS), deletedAgents: new Set(),
  sessionId: crypto.randomUUID(), title: '新对话', topic: '', messages: [],
  participants: [], runningWorkflow: false,
  epoch: 0, active: false, connected: false, saving: false, memoryReady: false,
  keepMemory: true, permission: false, controllers: new Set(), current: null,
  prefetch: null, pendingCard: null, cancelSpeech: null, count: 0,
  voices: [], voiceChosen: false, snapshot: { sessions: [], pages: [] },
  research: { task: '', queries: [], seenUrls: [], notes: '', round: 0 },
  notePath: '', noteVersion: 0, noteTrail: [], noteOrigin: 'library', replyPending: false,
  graph: { loaded: false, loading: false, nodes: [] },
  resources: { files: [], folders: [{ path: '', name: '资料库' }], folder: '', currentFolder: '', loaded: false, selected: null, request: 0, version: null, page: null, locator: null, uploading: false, extractController: null },
  attachments: [], resourceIds: [], attachmentNotice: '', pickerSelection: new Set(),
};

const profile = (id = state.agent) => state.agents.find(a => a.id === id) || getAgent(id);
const originalHarness = { id: 'harness2-upstream', name: 'Harness²' };
const detailProfile = id => id === originalHarness.id ? originalHarness : profile(id);
const agentAvailable = id => state.agents.some(agent => agent.id === id);
const defaultAgent = id => agentAvailable(id) ? id : state.agents[0]?.id || 'qa';
const agentDirectory = () => state.deletedAgents.has(originalHarness.id) ? state.agents : [...state.agents, originalHarness];
const abortError = () => new DOMException('已暂停', 'AbortError');
const isCurrent = epoch => state.active && state.epoch === epoch;
const persistSetting = (name, value) => { try { localStorage.setItem(name, String(value)); } catch {} };
function searchPreference(id) {
  try {
    const value = localStorage.getItem(`taotao-web-search-${id}`) ?? (id === 'taotao' ? localStorage.getItem('taotao-web-search') : null);
    return value === null ? profile(id).webSearch : value === 'true';
  } catch { return profile(id).webSearch; }
}
function safeURL(value) {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function errorMessage(text = '') { $('error-banner').textContent = text; $('error-banner').hidden = !text; }
function status(text = state.connected ? '已连接' : '未连接', mode = 'idle') {
  $('status-text').textContent = text;
  $('status-dot').dataset.state = mode;
  document.body.dataset.state = mode;
  $('pause-btn').disabled = !state.active;
  $('pause-btn').textContent = state.runningWorkflow ? '停止工作流' : state.participants.length ? '停止讨论' : profile().continuous ? '暂停' : '停止';
  $('resume-btn').hidden = state.participants.length > 0;
  $('resume-btn').disabled = state.active || !state.connected || !state.topic || (!profile().continuous && !state.replyPending);
  updateSendButton();
}
async function apiError(response) {
  let data; try { data = await response.json(); } catch {}
  return new Error(typeof data?.error === 'string' ? data.error : `请求失败（${response.status}）`);
}
async function jsonApi(path, body, options = {}) {
  const response = await fetch(path, body === undefined ? options : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options,
  });
  if (!response.ok) throw await apiError(response);
  return response.json();
}
const memoryApi = (action, body, keepalive = false) => jsonApi(`/api/memory/${action}`, body, { keepalive });
const workflowConnection = () => ({ apiKey: state.connected ? $('api-key').value.trim() : '', model: $('model').value });
function openConnectionSettings() { $('settings-dialog').showModal(); $('api-key').focus(); }
const workflowEditor = mountWorkflowEditor({
  jsonApi, apiError,
  getAgents: () => state.agents,
  getConnection: workflowConnection, openSettings: openConnectionSettings,
  setTitle: title => { if (state.view === 'workflow') $('current-topic').textContent = title; },
  closeList: closeMobileList,
});
const liveActivities = new Set();
const activityState = { running: '进行中', complete: '完成', failed: '失败', cancelled: '已停止' };
function elapsedText(milliseconds) {
  const seconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
}
function activityEvents(value) {
  try { const events = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(events) ? events.filter(event => event && typeof event.id === 'string').slice(-60) : []; }
  catch { return []; }
}
function refreshActivityClock(view) {
  const end = view.pending ? Date.now() : view.endedAt;
  view.elapsed.textContent = elapsedText(end - view.startedAt);
  view.output.textContent = view.characters ? `${view.characters}字` : '';
  const running = [...view.events.values()].filter(event => event.state === 'running');
  if (view.pending) {
    view.title.textContent = running.at(-1)?.title || '请求中';
    view.connection.textContent = Date.now() - view.lastSignal > 15000 ? '等待响应' : '进行中';
  }
  for (const event of running) {
    const row = view.rows.get(event.id);
    if (row) row.duration.textContent = elapsedText(end - (Date.parse(event.startedAt || event.at) || view.startedAt));
  }
}
function ensureActivity(card, { startedAt = Date.now(), live = false } = {}) {
  if (card.activity) return card.activity;
  const panel = document.createElement('details'); panel.className = 'activity-panel'; panel.open = live; panel.dataset.state = live ? 'running' : 'complete'; panel.setAttribute('aria-label', '执行过程');
  const summary = document.createElement('summary');
  const indicator = document.createElement('span'); indicator.className = 'activity-indicator'; indicator.setAttribute('aria-hidden', 'true');
  const title = document.createElement('span'); title.className = 'activity-title'; title.textContent = live ? '请求中' : '执行过程';
  const connection = document.createElement('span'); connection.className = 'activity-connection';
  const output = document.createElement('span'); output.className = 'activity-output';
  const elapsed = document.createElement('span'); elapsed.className = 'activity-elapsed';
  const list = document.createElement('ol'); list.className = 'activity-steps';
  summary.append(indicator, title, connection, output, elapsed); panel.append(summary, list); card.element.insertBefore(panel, card.body);
  const view = { card, panel, title, connection, output, elapsed, list, startedAt, endedAt: startedAt, lastSignal: Date.now(), characters: 0, pending: live, events: new Map(), rows: new Map(), userToggled: false, timer: null };
  summary.addEventListener('click', () => { view.userToggled = true; });
  card.activity = view;
  if (live) { liveActivities.add(view); view.timer = setInterval(() => refreshActivityClock(view), 1000); }
  refreshActivityClock(view); return view;
}
function updateActivity(card, event) {
  if (!event || typeof event.id !== 'string' || typeof event.title !== 'string') return;
  const view = ensureActivity(card, { live: true }); view.lastSignal = Date.now();
  const previous = view.events.get(event.id); event = { ...previous, ...event };
  view.events.set(event.id, event);
  if (view.events.size > 60) { const oldest = view.events.keys().next().value; view.events.delete(oldest); view.rows.get(oldest)?.element.remove(); view.rows.delete(oldest); }
  let row = view.rows.get(event.id);
  if (!row) {
    const element = document.createElement('li');
    const marker = document.createElement('span'); marker.className = 'activity-marker'; marker.setAttribute('aria-hidden', 'true');
    const content = document.createElement('div'); content.className = 'activity-step-content';
    const title = document.createElement('span'); title.className = 'activity-step-title';
    const stateLabel = document.createElement('span'); stateLabel.className = 'sr-only';
    const detail = document.createElement('p'); detail.className = 'activity-detail';
    const items = document.createElement('div'); items.className = 'activity-items';
    const duration = document.createElement('span'); duration.className = 'activity-duration';
    content.append(title, stateLabel, detail, items); element.append(marker, content, duration); view.list.append(element);
    row = { element, marker, title, stateLabel, detail, items, duration, itemsKey: null }; view.rows.set(event.id, row);
  }
  row.element.dataset.state = event.state; row.element.dataset.kind = event.kind || '';
  row.marker.textContent = ({ complete: '✓', failed: '×', cancelled: '−' })[event.state] || '';
  row.title.textContent = event.title; row.stateLabel.textContent = `，${activityState[event.state] || ''}`;
  row.detail.textContent = typeof event.detail === 'string' ? event.detail : ''; row.detail.hidden = !row.detail.textContent;
  const items = Array.isArray(event.items) ? event.items.slice(0, 16) : [];
  const itemsKey = JSON.stringify(items);
  if (row.itemsKey !== itemsKey) {
    row.itemsKey = itemsKey; row.items.replaceChildren();
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const url = safeURL(item.url); const node = document.createElement(url ? 'a' : 'span'); node.className = 'activity-item';
      node.textContent = item.label || (item.path ? noteTitle(item.path) : url ? new URL(url).hostname : '来源');
      if (url) { node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
      row.items.append(node);
    }
  }
  row.items.hidden = !items.length;
  if (event.state !== 'running') row.duration.textContent = elapsedText(Number.isFinite(event.elapsedMs) ? event.elapsedMs : Date.parse(event.at) - Date.parse(event.startedAt));
  view.endedAt = Math.max(view.endedAt, Date.parse(event.at) || view.startedAt);
  refreshActivityClock(view); scrollConversation();
}
function finishActivity(card, result = 'complete', error = '') {
  const view = card?.activity; if (!view) return;
  if (view.pending) {
    view.endedAt = Date.now(); view.pending = false; clearInterval(view.timer); liveActivities.delete(view);
    for (const event of [...view.events.values()]) if (event.state === 'running') updateActivity(card, { ...event, state: result === 'complete' ? 'cancelled' : result, at: new Date().toISOString(), elapsedMs: view.endedAt - (Date.parse(event.startedAt || event.at) || view.startedAt) });
  }
  view.panel.dataset.state = result; view.connection.textContent = '';
  view.title.textContent = ({ complete: '执行过程', cancelled: '已停止', failed: '未完成' })[result] || '执行过程';
  if (error) updateActivity(card, { id: 'request-error', kind: 'request', state: 'failed', title: '请求失败', detail: error, at: new Date(view.endedAt).toISOString() });
  if (result === 'complete' && !view.userToggled) view.panel.open = false;
  refreshActivityClock(view);
}
function restoreActivity(card, events, result = 'complete') {
  if (!events.length) return;
  const starts = events.map(event => Date.parse(event.startedAt || event.at)).filter(Number.isFinite);
  ensureActivity(card, { startedAt: starts.length ? Math.min(...starts) : Date.now() });
  for (const event of events) updateActivity(card, event.state === 'running' ? { ...event, state: 'cancelled' } : event);
  finishActivity(card, result);
}
function record(type, payload = {}) {
  if (!state.keepMemory || !state.memoryReady) return;
  void memoryApi('event', { id: crypto.randomUUID(), sessionId: state.sessionId, messageId: state.current?.id,
    type, payload: { agent: state.agent, topic: state.topic, segment: state.count, ...payload } }, true).catch(() => {});
}

function halt(reason = 'pause', log = true) {
  const wasActive = state.active;
  const wasWorkflow = state.runningWorkflow;
  state.runningWorkflow = false;
  state.active = false; state.saving = false; state.epoch++;
  for (const view of [...liveActivities]) finishActivity(view.card, 'cancelled');
  for (const controller of state.controllers) controller.abort();
  state.controllers.clear();
  state.cancelSpeech?.(); state.cancelSpeech = null; synth?.cancel(); state.prefetch = null;
  if (state.pendingCard) {
    if (state.pendingCard.body.textContent || state.pendingCard.activity) state.pendingCard.label.textContent = `${state.pendingCard.agentName} · 未完成`;
    else state.pendingCard.element.remove();
    if (state.pendingCard.workflow) addActions(state.pendingCard);
    state.pendingCard = null;
  }
  document.querySelectorAll('.sentence.speaking').forEach(span => span.classList.remove('speaking'));
  if (wasActive && log) record(reason);
  status(wasActive ? wasWorkflow ? '工作流已停止' : state.participants.length ? '讨论已停止' : '已暂停' : state.connected ? '已连接' : '未连接');
}

function selectAgent(id, stop = true) {
  profile(id);
  if (id !== 'summarizer' && state.attachments.length) { state.attachments = []; state.resourceIds = []; state.attachmentNotice = '已移除资料'; renderAttachments(); }
  if (stop && (state.agent !== id || state.participants.length)) {
    halt('agent_switch'); state.participants = []; state.current = null; state.replyPending = false; state.topic = '';
  }
  state.agent = id;
  $('settings-agent').value = agentAvailable(id) ? id : '';
  $('web-search').disabled = id === 'harness2' || !agentAvailable(id);
  $('web-search').checked = id !== 'harness2' && searchPreference(id);
  $('resume-btn').textContent = profile().continuous || id === 'librarian' ? '继续' : '重试';
  persistSetting('taotao-agent', id);
  renderDiscussion(); status();
}
function setView(view) {
  if (state.view === 'agents' && view !== 'agents') endAgentHarnessEdit($('agent-harness'));
  if (state.view !== view && !(state.active && !state.runningWorkflow && !state.participants.length && state.agent === 'librarian')) halt('navigation');
  if (view !== 'resources') stopExtraction();
  state.view = view;
  for (const name of ['chat', 'agents', 'workflow', 'library', 'resources', 'graph']) {
    $(`nav-${name}`).classList.toggle('selected', name === view);
    if (name === view) $(`nav-${name}`).setAttribute('aria-current', 'page');
    else $(`nav-${name}`).removeAttribute('aria-current');
    $(`${name}-view`).hidden = name !== view;
  }
  $('session-list').hidden = view !== 'chat'; $('agent-list').hidden = view !== 'agents';
  $('workflow-list').hidden = $('new-workflow').hidden = view !== 'workflow';
  $('wiki-list').hidden = !['library', 'graph'].includes(view);
  $('resource-list').hidden = view !== 'resources';
  $('list-title').textContent = ({ chat: '对话', agents: 'Agent', workflow: '工作流', library: '知识库', resources: '资料库', graph: '图谱' })[view];
  $('new-chat').hidden = view !== 'chat'; $('chat-menu').hidden = view !== 'chat';
  $('status-dot').hidden = view === 'resources'; $('status-text').hidden = view === 'resources';
  $('list-search').value = '';
  $('current-topic').textContent = view === 'chat' ? state.title : view === 'agents' ? 'Agent'
    : view === 'resources' ? state.resources.selected?.name || '资料库' : view === 'graph' ? '知识图谱' : view === 'workflow' ? '工作流'
    : state.notePath ? noteTitle(state.notePath) : '知识库';
  renderLists();
  if (view === 'agents') showAgent(state.detailAgent);
  if (view === 'workflow') void workflowEditor.open();
  if (view === 'graph') void loadGraph();
  if (view === 'library' && !state.notePath) {
    $('knowledge-content').replaceChildren(); const empty = document.createElement('div'); empty.className = 'document-empty'; empty.textContent = '知识库'; $('knowledge-content').append(empty);
  }
}
function closeMobileList() { document.querySelector('.workspace').classList.remove('list-open'); }

let graphView = null;
function ensureGraph() {
  if (graphView) return graphView;
  graphView = createKnowledgeGraph($('knowledge-graph'), {
    tip: $('graph-tip'),
    onOpen: node => { if (node.path) void showNote(node.path); },
  });
  $('graph-fit').addEventListener('click', () => graphView.fit());
  $('graph-refresh').addEventListener('click', () => { state.graph.loaded = false; void loadGraph(); });
  $('graph-node').addEventListener('input', event => graphView.setNodeScale(Number(event.target.value)));
  $('graph-scope-all').addEventListener('click', () => setGraphScope(false));
  $('graph-scope-mutual').addEventListener('click', () => setGraphScope(true));
  return graphView;
}

function updateGraphCount() {
  if (!graphView) return;
  const { nodes, edges, mutualOnly } = graphView.stats;
  $('graph-count').textContent = `${nodes} 个笔记 · ${edges} 条${mutualOnly ? '双向' : ''}引用`;
  $('graph-empty').hidden = nodes > 0;
  $('graph-empty').textContent = mutualOnly && !nodes
    ? '还没有互相引用的笔记。'
    : '还没有笔记。收录几篇之后，它们会出现在这里。';
}

// 两个按钮互斥：切换时只重建边和节点，距离滑块保持原值。
function setGraphScope(mutual) {
  ensureGraph().setMutualOnly(mutual);
  $('graph-scope-all').classList.toggle('selected', !mutual);
  $('graph-scope-mutual').classList.toggle('selected', mutual);
  $('graph-scope-all').setAttribute('aria-pressed', String(!mutual));
  $('graph-scope-mutual').setAttribute('aria-pressed', String(mutual));
  updateGraphCount();
}
async function loadGraph() {
  if (state.graph.loading) return;
  if (state.graph.loaded) { ensureGraph().resize(); return; }
  state.graph.loading = true;
  $('graph-count').textContent = '读取中';
  try {
    // 画布刚从 hidden 切出来时还没有尺寸，等一帧再建，取景才准。
    if (!graphView) await new Promise(done => requestAnimationFrame(done));
    const data = await jsonApi('/api/knowledge/graph');
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    state.graph.nodes = nodes;
    const graph = ensureGraph();
    graph.setData(data);
    renderGraphLegend(data.folders || [], graph);
    updateGraphCount();
    state.graph.loaded = true;
  } catch (error) {
    $('graph-count').textContent = '读取失败';
    errorMessage(error.message);
  } finally { state.graph.loading = false; }
}
function renderGraphLegend(folders, graph) {
  const names = [...new Set(folders.filter(Boolean))].sort();
  $('graph-legend').replaceChildren(...names.map(folder => {
    const item = document.createElement('span');
    const dot = document.createElement('i'); dot.style.background = graph?.colorOf(folder) || '#7d8aa5';
    item.append(dot, document.createTextNode(folder));
    return item;
  }));
}
function sideRow(className, title, selected, onClick, icon = '') {
  const button = document.createElement('button'); button.type = 'button'; button.className = `${className}${selected ? ' selected' : ''}`;
  const symbol = document.createElement('span'); symbol.className = className === 'agent-row' ? 'row-avatar' : 'row-icon'; symbol.textContent = icon;
  const label = document.createElement('span'); label.className = 'row-title'; label.textContent = title;
  button.append(symbol, label); button.addEventListener('click', onClick); return button;
}
function renderLists() {
  $('delete-session').hidden = state.view !== 'chat' || !state.snapshot.sessions.some(session => session.id === state.sessionId);
  const search = $('list-search').value.trim().toLocaleLowerCase();
  if (state.view === 'workflow') { workflowEditor.filter(search); return; }
  const matches = value => String(value).toLocaleLowerCase().includes(search);
  $('session-list').replaceChildren();
  for (const session of state.snapshot.sessions.filter(s => matches(s.title))) {
    const row = sideRow('session-row', session.title, session.id === state.sessionId, () => { void loadSession(session.id); }, '◻');
    row.dataset.sessionId = session.id; $('session-list').append(row);
  }
  if (!$('session-list').childElementCount) { const empty = document.createElement('p'); empty.className = 'side-empty'; empty.textContent = '暂无对话'; $('session-list').append(empty); }
  $('agent-list').replaceChildren();
  for (const item of agentDirectory().filter(a => matches(a.name))) {
    const row = sideRow('agent-row', item.name, item.id === state.detailAgent, () => { showAgent(item.id); closeMobileList(); }, item.name[0]);
    row.dataset.agent = item.id; $('agent-list').append(row);
  }
  $('wiki-list').replaceChildren();
  const indexPath = state.snapshot.indexPath || 'wiki/index.md';
  if (matches('我的记忆库')) $('wiki-list').append(sideRow('wiki-row', '我的记忆库', state.notePath === indexPath, () => { void showNote(indexPath); }, '▣'));
  let category = '';
  for (const page of state.snapshot.pages.filter(p => matches(p.path))) {
    const parts = page.path.split('/'); const group = parts.length > 2 ? parts[1] : '';
    if (category !== group) { category = group; const label = document.createElement('div'); label.className = 'list-label'; label.textContent = group; $('wiki-list').append(label); }
    const row = sideRow('wiki-row', noteTitle(page.path), state.notePath === page.path, () => {
      if (state.view === 'graph') { ensureGraph().focus(page.id); closeMobileList(); }
      else void showNote(page.path);
    }, '◫');
    row.dataset.path = page.path; $('wiki-list').append(row);
  }
  if (state.view === 'resources') renderResources();
}
function showAgent(id) {
  const directory = agentDirectory();
  if (!directory.some(agent => agent.id === id)) id = directory[0]?.id;
  $('agent-empty').hidden = !!id; $('agent-detail').hidden = !id;
  if (!id) {
    endAgentHarnessEdit($('agent-harness'));
    state.detailAgent = null;
    if (state.view === 'agents') $('current-topic').textContent = 'Agent';
    renderLists();
    return;
  }
  state.detailAgent = id; const item = detailProfile(id);
  const upstream = id === originalHarness.id;
  $('agent-name').textContent = item.name; $('agent-avatar').textContent = item.name[0];
  $('agent-description').textContent = item.description || '';
  $('agent-description').hidden = !item.description;
  for (const control of ['agent-permission', 'agent-edit', 'agent-chat', 'agent-harness']) $(control).hidden = upstream;
  $('harness2-upstream').hidden = !upstream;
  $('agent-permission').textContent = id === 'librarian' && state.permission ? 'Wiki 可写' : 'Wiki 只读';
  if (upstream) {
    endAgentHarnessEdit($('agent-harness'));
    mountUpstreamHarness2($('harness2-upstream'));
  } else mountAgentHarness($('agent-harness'), $('agent-edit'), item, state.agents, components => {
    const reviewEnabled = reviewConfigured(components);
    state.agents = state.agents.map(agent => agent.id === id ? { ...agent, reviewEnabled } : agent);
    for (const card of $('conversation').querySelectorAll('.message.assistant')) {
      const collect = card.querySelector('[data-action=collect]');
      if (collect && card.dataset.agent === id) collect.hidden = !reviewEnabled;
    }
  });
  if (state.view === 'agents') $('current-topic').textContent = item.name;
  renderLists();
}
let agentCatalogEpoch = 0;
async function refreshAgentCatalog() {
  const epoch = ++agentCatalogEpoch;
  const data = await jsonApi('/api/agents');
  if (epoch !== agentCatalogEpoch || !Array.isArray(data.agents)) return;
  state.agents = data.agents;
  state.deletedAgents = new Set(data.deleted || []);
  if (!agentAvailable(state.agent) || state.participants.some(id => !agentAvailable(id))) {
    if (state.active && !state.runningWorkflow) halt('agent_removed');
    state.participants = []; state.current = null; state.replyPending = false; state.topic = '';
  }
  $('settings-agent').replaceChildren(...(state.agents.length
    ? state.agents.map(item => new Option(item.name, item.id)) : [new Option('暂无 Agent', '')]));
  $('settings-agent').disabled = !state.agents.length;
  if (typeof data.permission === 'boolean') {
    state.permission = data.permission;
    $('knowledge-permission').checked = data.permission;
  }
  selectAgent(defaultAgent(state.agent), false);
  for (const card of $('conversation').querySelectorAll('.message[data-agent]')) {
    const collect = card.querySelector('[data-action=collect]');
    if (collect) collect.hidden = !agentAvailable('librarian') || profile(card.dataset.agent).reviewEnabled === false;
  }
  if (state.view === 'agents') showAgent(state.detailAgent);
  else renderLists();
}
function clearConversation() {
  $('conversation').querySelectorAll('.message').forEach(node => node.remove()); $('welcome').hidden = false;
}
function resetResearch(task = '') {
  state.research = { task, queries: [], seenUrls: [], notes: '', round: 0 };
  $('research-panel').hidden = true; $('research-query').textContent = ''; $('research-history').replaceChildren();
  $('research-count').textContent = '0'; $('source-count').textContent = '0';
}
function newChat() {
  halt('reset'); state.sessionId = crypto.randomUUID(); state.title = '新对话'; state.topic = ''; state.messages = [];
  state.attachments = []; state.resourceIds = []; state.attachmentNotice = ''; renderAttachments();
  state.current = null; state.replyPending = false; state.count = 0; state.participants = [];
  clearConversation(); resetResearch(); $('topic').value = ''; $('segment-count').textContent = '0';
  closeMentionMenu(); renderDiscussion(); status();
  errorMessage(); setView('chat'); closeMobileList(); $('topic').focus();
}

function scrollConversation(force = false) {
  const view = $('conversation'); if (force || view.scrollHeight - view.scrollTop - view.clientHeight < 180) view.scrollTop = view.scrollHeight;
}
function messageCard(role, text = '', agentId = state.agent, id = null, sessionId = state.sessionId, workflow = null) {
  $('welcome').hidden = true;
  const element = document.createElement('article'); element.className = `message ${role}`;
  if (id) element.dataset.messageId = id;
  element.dataset.agent = agentId;
  if (workflow) element.dataset.workflow = workflow.id;
  const name = workflow?.name || profile(agentId).name;
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = role === 'user' ? '你' : workflow ? '⑂' : name[0];
  const label = document.createElement('span'); label.textContent = role === 'user' ? '你' : name;
  const body = document.createElement('div'); body.className = 'message-body streaming'; body.textContent = text;
  meta.append(avatar, label); element.append(meta, body); $('conversation').append(element);
  scrollConversation();
  return { element, body, label, agentName: name, agentId, id, sessionId, workflow };
}

// All Markdown is built with DOM text nodes; notes never execute HTML or load remote images.
let markdownId = 0;
function renderMarkdown(target, value) {
  const scope = `md-${++markdownId}`;
  const text = String(value).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split(/\r?\n/); const definitions = new Map(); const body = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (!match) { body.push(lines[i]); continue; }
    let content = match[2];
    while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) content += `\n${lines[++i].trim()}`;
    definitions.set(match[1], content);
  }
  const numbers = new Map([...definitions.keys()].map((key, index) => [key, index + 1]));
  const footId = key => `${scope}-fn-${encodeURIComponent(key)}`;
  function inline(parent, source) {
    const pattern = /\[\[[^\]\n]+\]\]|\[\^[^\]\n]+\]|\[(?:\\.|[^\]\\\n])+\]\((?:<[^>\n]+>|[^)\n]+)\)|`[^`\n]+`|\*\*[^*\n]+\*\*/g;
    let last = 0;
    for (const match of source.matchAll(pattern)) {
      parent.append(document.createTextNode(source.slice(last, match.index))); const token = match[0]; let node;
      if (token.startsWith('[[')) {
        const [reference, label] = token.slice(2, -2).split('|'); const path = reference.split('#')[0];
        const normalized = path.endsWith('.md') ? path : `${path}.md`;
        if (normalized.length <= 1000 && normalized.split('/').every(part => part && !part.startsWith('.') && !/[\\:"<>|?*\x00-\x1f]/u.test(part))) {
          node = document.createElement('a'); node.href = '#knowledge'; node.textContent = label || noteTitle(normalized);
          node.addEventListener('click', event => { event.preventDefault(); void showNote(normalized); });
        }
      } else if (token.startsWith('[^')) {
        const key = token.slice(2, -1);
        if (numbers.has(key)) { node = document.createElement('sup'); const link = document.createElement('a'); link.textContent = `[${numbers.get(key)}]`; link.href = `#${footId(key)}`; link.addEventListener('click', event => { event.preventDefault(); document.getElementById(footId(key))?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }); node.append(link); }
      } else if (token.startsWith('[')) {
        const link = token.match(/^\[((?:\\.|[^\]\\])+)\]\((.*)\)$/); const target = link?.[2].replace(/^<|>$/g, '').trim(); const reference = resourceReference(target); const url = safeURL(target); const label = link?.[1].replace(/\\([\\\[\]])/g, '$1');
        if (reference) { node = document.createElement('a'); node.href = resourceLink(reference); node.textContent = label; node.addEventListener('click', event => { if (event.ctrlKey || event.metaKey || event.shiftKey) return; event.preventDefault(); void showResource(reference.id, reference); }); }
        else if (url) { node = document.createElement('a'); node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; node.textContent = label; }
      } else if (token.startsWith('`')) { node = document.createElement('code'); node.textContent = token.slice(1, -1); }
      else { node = document.createElement('strong'); node.textContent = token.slice(2, -2); }
      parent.append(node || document.createTextNode(token)); last = match.index + token.length;
    }
    parent.append(document.createTextNode(source.slice(last)));
  }
  target.replaceChildren(); target.classList.remove('streaming'); target.classList.add('markdown-content');
  let list = null, quote = null;
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (!line.trim() || /^\^[a-zA-Z0-9_-]+\s*$/.test(line)) { list = null; quote = null; continue; }
    if (line.startsWith('```')) {
      const code = []; while (++i < body.length && !body[i].startsWith('```')) code.push(body[i]);
      const pre = document.createElement('pre'); const node = document.createElement('code'); node.textContent = code.join('\n'); pre.append(node); target.append(pre); list = null; quote = null; continue;
    }
    if (/^\|/.test(line) && i + 1 < body.length && /^\|?\s*:?-{3,}/.test(body[i + 1])) {
      const table = document.createElement('table');
      const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
      const head = document.createElement('tr'); for (const cell of cells(line)) { const th = document.createElement('th'); inline(th, cell); head.append(th); } table.append(head); i++;
      while (i + 1 < body.length && /^\|/.test(body[i + 1])) { const row = document.createElement('tr'); for (const cell of cells(body[++i])) { const td = document.createElement('td'); inline(td, cell); row.append(td); } table.append(row); }
      target.append(table); list = null; quote = null; continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { const node = document.createElement(`h${Math.min(heading[1].length, 4)}`); inline(node, heading[2]); target.append(node); list = null; quote = null; continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { target.append(document.createElement('hr')); list = null; quote = null; continue; }
    const item = line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.+)$/);
    if (item) { const tag = item[1] ? 'UL' : 'OL'; if (!list || list.tagName !== tag) { list = document.createElement(tag.toLowerCase()); target.append(list); } const li = document.createElement('li'); inline(li, item[2]); list.append(li); quote = null; continue; }
    list = null;
    if (/^>\s?/.test(line)) { if (!quote) { quote = document.createElement('blockquote'); target.append(quote); } const p = document.createElement('p'); inline(p, line.replace(/^>\s?/, '')); quote.append(p); continue; }
    quote = null; const p = document.createElement('p'); inline(p, line); target.append(p);
  }
  if (definitions.size) {
    const section = document.createElement('div'); section.className = 'footnotes'; const list = document.createElement('ol');
    for (const [key, content] of definitions) { const li = document.createElement('li'); li.id = footId(key); inline(li, content); list.append(li); }
    section.append(list); target.append(section);
  }
}

function addActions(card) {
  if (card.element.querySelector('.message-actions')) return;
  const actions = document.createElement('div'); actions.className = 'message-actions';
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制';
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(card.body.textContent); copy.textContent = '已复制'; } catch { copy.textContent = '复制失败'; } }); actions.append(copy);
  if (card.workflow) {
    const details = document.createElement('button'); details.type = 'button'; details.textContent = '查看运行';
    details.addEventListener('click', () => {
      setView('workflow');
      void workflowEditor.openExecution(card.workflow.id, card.workflow.runId);
    });
    actions.append(details);
  }
  if (card.id && !card.workflow && card.agentId !== 'librarian') {
    const collect = document.createElement('button'); collect.type = 'button'; collect.textContent = '收录'; collect.dataset.action = 'collect';
    collect.hidden = !agentAvailable('librarian') || profile(card.agentId).reviewEnabled === false;
    collect.addEventListener('click', () => { void collectMessage(card, collect); }); actions.append(collect);
  }
  if (!card.workflow && card.agentId === 'taotao') for (const [label, direction] of [['多聊', 'more'], ['少聊', 'less']]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', () => { record('feedback', { direction, excerpt: card.body.textContent.slice(0, 100) }); button.textContent = '已记录'; }); actions.append(button);
  }
  card.element.append(actions);
}
function renderSources(card, research) {
  card.element.querySelector('.message-sources')?.remove();
  const sources = research.sources || []; if (!sources.length) return;
  const details = document.createElement('details'); details.className = 'message-sources'; const summary = document.createElement('summary'); summary.textContent = `来源 · ${sources.length}`; const list = document.createElement('ol');
  for (const source of sources) {
    const url = safeURL(source.url); if (!url) continue;
    const li = document.createElement('li'); const link = document.createElement('a'); link.href = url; link.textContent = source.title || new URL(url).hostname; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const date = document.createElement('small'); date.textContent = `${new URL(url).hostname}${source.date || source.publishedAt ? ` · ${(source.date || source.publishedAt).slice(0, 10)}` : ''}`; li.append(link, date);
    if (source.excerpt) { const p = document.createElement('p'); p.textContent = source.excerpt; li.append(p); } list.append(li);
  }
  details.append(summary, list); card.element.append(details);
}
function receiveResearch(data, card) {
  if (!data || !Array.isArray(data.sources) || !data.checkpoint) throw new Error('查询资料不完整');
  const sources = data.sources.map(s => ({ ...s, url: safeURL(s.url) })).filter(s => s.url);
  if (!sources.length) throw new Error('没有可用来源');
  state.research = { task: state.topic, queries: (data.checkpoint.queries || []).filter(s => typeof s === 'string').slice(-40), seenUrls: (data.checkpoint.seenUrls || []).map(safeURL).filter(Boolean).slice(-100), notes: String(data.checkpoint.notes || '').slice(-6000), round: Number(data.round) || state.research.round + 1 };
  $('research-count').textContent = String(state.research.round); $('source-count').textContent = String(state.research.seenUrls.length); $('research-query').textContent = String(data.query || '');
  $('research-history').replaceChildren(...state.research.queries.slice(-8).map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  const result = { ...data, sources }; if (card) renderSources(card, result); return result;
}

async function refreshMemory() {
  const data = await jsonApi('/api/memory/status'); state.snapshot = data; state.memoryReady = true;
  state.graph.loaded = false; state.permission = !!(data.permission ?? data.knowledge?.permission);
  $('knowledge-permission').checked = state.permission;
  $('memory-status').textContent = `${data.saved || 0} 条消息 · ${data.pages?.length || 0} 篇笔记`;
  if (data.obsidian) $('vault-link').href = data.obsidian;
  renderLists(); if (state.view === 'agents') showAgent(state.detailAgent); return data;
}
async function loadSession(id, autoRun = false) {
  halt('history'); const epoch = state.epoch;
  state.attachments = []; state.resourceIds = []; state.attachmentNotice = ''; renderAttachments();
  try {
    const data = await jsonApi(`/api/memory/history?id=${encodeURIComponent(id)}`);
    if (epoch !== state.epoch) return;
    if (!data.session) throw new Error('对话不存在');
    state.sessionId = id; state.title = data.session.title; state.current = null; state.count = 0; state.replyPending = false;
    state.messages = data.messages.filter(m => m.visible !== 0 && (m.content || m.workflow || m.role === 'assistant' && activityEvents(m.activity).length)).map(m => {
      let research = m.research; if (typeof research === 'string') { try { research = JSON.parse(research); } catch { research = null; } }
      return { role: m.role, content: m.content, agent: m.agent || data.session.agent || 'taotao', id: m.id, research,
        workflow: m.workflow ? JSON.parse(m.workflow) : null, activity: activityEvents(m.activity), status: m.status };
    });
    const lastUserIndex = data.messages.findLastIndex(m => m.role === 'user');
    const lastUser = data.messages[lastUserIndex];
    const lastReply = data.messages.slice(lastUserIndex + 1).findLast(m => m.role === 'assistant' && m.visible !== 0);
    const savedAgent = autoRun ? 'librarian' : lastUser?.agent || data.session.agent || 'qa';
    const savedParticipants = autoRun ? [] : JSON.parse(lastUser?.participants || '[]');
    const canResume = agentAvailable(savedAgent) && savedParticipants.every(agentAvailable);
    state.participants = canResume ? savedParticipants : [];
    state.topic = canResume && !lastUser?.workflow ? lastUser?.content || '' : '';
    $('topic').value = ''; closeMentionMenu();
    selectAgent(defaultAgent(savedAgent), false);
    state.replyPending = canResume && !lastUser?.workflow && !state.participants.length && !!lastUser && (!lastReply || lastReply.status !== 'complete' || lastReply.resumable === 1);
    clearConversation(); resetResearch(state.topic);
    for (const message of state.messages) {
      const card = messageCard(message.role, message.content, message.agent, message.id, id, message.workflow);
      if (message.role === 'user' && /resource[:=]/.test(message.content)) renderMarkdown(card.body, message.content);
      if (message.role === 'assistant') {
        renderMarkdown(card.body, message.content);
        restoreActivity(card, message.activity, message.status === 'complete' ? 'complete' : message.activity.some(event => event.state === 'failed') ? 'failed' : 'cancelled');
        if (message.research?.sources) renderSources(card, message.research);
        if (message.workflow && message.status !== 'complete') card.label.textContent += ' · 未完成';
        if (message.content || message.workflow) addActions(card);
        if (message.content) state.count++;
      }
    }
    $('segment-count').textContent = String(state.count);
    errorMessage(); setView('chat'); closeMobileList(); scrollConversation(true); status();
    if (autoRun && canResume && lastUser && data.messages.at(-1)?.role === 'user') { state.replyPending = true; start(); }
  } catch (error) { if (epoch === state.epoch) errorMessage(error.message); }
}
async function collectMessage(card, button) {
  if (!state.connected) { $('settings-dialog').showModal(); return; }
  halt('collect'); const epoch = state.epoch; const controller = new AbortController(); state.controllers.add(controller); button.disabled = true;
  try {
    const data = await jsonApi('/api/knowledge/submit', { sessionId: card.sessionId, messageId: card.id, apiKey: $('api-key').value.trim(), model: $('model').value }, { signal: controller.signal });
    await refreshMemory(); if (epoch !== state.epoch) return;
    await loadSession(data.sessionId, true);
  } catch (error) { if (error.name !== 'AbortError' && epoch === state.epoch) errorMessage(error.message); }
  finally { state.controllers.delete(controller); button.disabled = false; }
}
async function openHandoff(data, epoch) {
  if (!data?.sessionId) return;
  await refreshMemory(); if (state.epoch !== epoch) return; await loadSession(data.sessionId, true);
}

const noteTitle = path => {
  const name = String(path).split('/').at(-1).replace(/\.md$/, '');
  return name === 'index' ? '记忆目录' : name === 'log' ? '整理记录' : name;
};
async function showNote(path, { trail = true } = {}) {
  // 记下从哪儿进来的：返回键先退回上一篇笔记，退完了再按来源回到图谱或知识库首页。
  if (trail && state.notePath !== path) {
    if (state.notePath) state.noteTrail.push(state.notePath);
    else { state.noteOrigin = state.view; state.noteTrail = []; }
  }
  const version = ++state.noteVersion; state.notePath = path; setView('library'); closeMobileList();
  $('knowledge-title').textContent = noteTitle(path); $('knowledge-content').textContent = '读取中'; $('knowledge-raw').hidden = true; $('knowledge-content').hidden = false;
  // 首页本身就是目录，没有上一级可退。
  $('note-back').hidden = path === 'wiki/index.md';
  for (const id of ['note-raw-toggle', 'note-obsidian', 'note-download', 'note-forget']) $(id).hidden = true;
  try {
    const data = await jsonApi(`/api/memory/note?path=${encodeURIComponent(path)}`); if (version !== state.noteVersion) return;
    renderMarkdown($('knowledge-content'), data.content); $('knowledge-raw').textContent = data.content;
    $('note-raw-toggle').hidden = false; $('note-raw-toggle').textContent = '原文';
    $('note-obsidian').href = data.obsidian; $('note-obsidian').hidden = !data.obsidian;
    $('note-download').href = `/api/memory/note?path=${encodeURIComponent(path)}&download=1`; $('note-download').hidden = false;
    $('note-forget').hidden = !state.snapshot.pages.some(page => page.path === path);
    if (state.view === 'library') status();
  } catch (error) { if (version === state.noteVersion) $('knowledge-content').textContent = error.message; }
}

function noteBack() {
  const previous = state.noteTrail.pop();
  if (previous) { void showNote(previous, { trail: false }); return; }
  const origin = state.noteOrigin;
  state.notePath = ''; state.noteVersion++;
  if (origin === 'graph') { setView('graph'); void loadGraph(); return; }
  // 没有上一篇可退时落到知识库首页，而不是留一个空白面板。
  void showNote('wiki/index.md', { trail: false });
}

function resourceType(file) {
  const ext = String(file.ext || '').replace(/^\./, '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (String(file.mime).startsWith('image/')) return 'image';
  return /^(docx?|odt|rtf|txt|md|csv|json|xlsx?|pptx?|ods|odp)$/.test(ext) ? 'document' : 'other';
}
function resourceSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  const unit = size < 1048576 ? 'KB' : size < 1073741824 ? 'MB' : 'GB';
  return `${(size / ({ KB: 1024, MB: 1048576, GB: 1073741824 })[unit]).toFixed(1)} ${unit}`;
}
function resourceDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(date) : '—';
}
function resourceStatus(text = '') { $('resource-status').textContent = text; $('resource-status').hidden = !text; }
const resourceParent = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
function selectResourceFolder(path) {
  stopExtraction(); state.resources.currentFolder = path; state.resources.selected = null; state.resources.request++;
  $('list-search').value = ''; $('current-topic').textContent = path.split('/').at(-1) || '资料库';
  renderResources(); closeMobileList();
}
function renderResourceLocation() {
  const target = $('resource-location'); target.replaceChildren();
  const parts = ['资料库', ...state.resources.currentFolder.split('/').filter(Boolean)];
  for (let index = 0; index < parts.length; index++) {
    if (index) { const divider = document.createElement('span'); divider.textContent = '/'; divider.setAttribute('aria-hidden', 'true'); target.append(divider); }
    const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet-button'; button.textContent = parts[index];
    const path = parts.slice(1, index + 1).join('/'); button.addEventListener('click', () => selectResourceFolder(path));
    if (index === parts.length - 1) button.setAttribute('aria-current', 'location'); target.append(button);
  }
}
function renderResources() {
  const resources = state.resources;
  const focused = document.activeElement;
  const focusedArea = focused?.closest('#resource-list, #resource-table')?.id;
  const focusedKey = focused?.dataset.resourceId !== undefined ? ['resource-id', focused.dataset.resourceId] : focused?.dataset.resourceFolder !== undefined ? ['resource-folder', focused.dataset.resourceFolder] : null;
  $('resource-list').replaceChildren();
  const branches = new Map([['', $('resource-list')]]);
  for (const folder of resources.folders) {
    const count = resources.files.filter(file => resourceParent(file.relativePath) === folder.path).length;
    const button = sideRow('resource-category', folder.name || '资料库', resources.currentFolder === folder.path, () => selectResourceFolder(folder.path), '▱');
    button.dataset.resourceFolder = folder.path;
    if (folder.path) button.setAttribute('aria-label', folder.path);
    const total = document.createElement('span'); total.className = 'resource-category-count'; total.textContent = String(count); button.append(total);
    if (!folder.path) $('resource-list').append(button);
    else {
      const branch = document.createElement('div'); branch.className = 'resource-folder-branch'; branch.append(button);
      (branches.get(resourceParent(folder.path)) || $('resource-list')).append(branch); branches.set(folder.path, branch);
    }
  }
  renderResourceLocation();
  const search = state.view === 'resources' ? $('list-search').value.trim().toLocaleLowerCase() : '';
  const files = resources.files.filter(file => (search || resourceParent(file.relativePath) === resources.currentFolder)
    && `${file.name} ${file.relativePath}`.toLocaleLowerCase().includes(search));
  const folders = resources.folders.filter(folder => folder.path && (search ? folder.path.toLocaleLowerCase().includes(search) : resourceParent(folder.path) === resources.currentFolder));
  $('resource-count').textContent = `${files.length} 份`;
  $('resource-overview').hidden = !!resources.selected; $('resource-detail').hidden = !resources.selected;
  $('resource-empty').hidden = files.length + folders.length > 0; $('resource-table-wrapper').hidden = !files.length && !folders.length;
  $('resource-table').replaceChildren();
  for (const folder of folders) {
    const row = document.createElement('tr'); row.dataset.resourceFolder = folder.path;
    const nameCell = document.createElement('th'); nameCell.scope = 'row';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'resource-name'; button.dataset.resourceFolder = folder.path;
    const icon = document.createElement('span'); icon.className = 'resource-file-icon resource-kind-folder'; icon.textContent = '▱';
    const label = document.createElement('span'); label.className = 'resource-file-name'; label.textContent = search ? folder.path : folder.name;
    button.append(icon, label); button.addEventListener('click', () => selectResourceFolder(folder.path)); nameCell.append(button); row.append(nameCell);
    for (const [name, value] of [['类型', '文件夹'], ['大小', '—'], ['更新', '—']]) { const cell = document.createElement('td'); cell.dataset.label = name; cell.textContent = value; row.append(cell); }
    $('resource-table').append(row);
  }
  for (const file of files) {
    const row = document.createElement('tr'); row.dataset.resourceId = file.id;
    const nameCell = document.createElement('th'); nameCell.scope = 'row';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'resource-name'; button.dataset.resourceId = file.id;
    const icon = document.createElement('span'); icon.className = `resource-file-icon resource-kind-${resourceType(file)}`; icon.textContent = String(file.ext || 'FILE').replace(/^\./, '').toUpperCase().slice(0, 5);
    const label = document.createElement('span'); label.className = 'resource-file-name'; label.textContent = search ? file.relativePath : file.name;
    button.append(icon, label); button.addEventListener('click', () => { void showResource(file.id); }); nameCell.append(button); row.append(nameCell);
    const cells = [['类型', String(file.ext || 'FILE').replace(/^\./, '').toUpperCase()], ['大小', resourceSize(file.size)], ['更新', resourceDate(file.modifiedAt)]];
    for (const [name, text] of cells) { const cell = document.createElement('td'); cell.dataset.label = name; cell.textContent = text; row.append(cell); }
    if (file.status !== 'ready') { const badge = document.createElement('span'); badge.className = 'resource-missing'; badge.textContent = file.status === 'missing' ? '已移出' : '无法读取'; nameCell.append(badge); }
    $('resource-table').append(row);
  }
  if (focusedArea && focusedKey) document.querySelector(`#${focusedArea} button[data-${focusedKey[0]}="${CSS.escape(focusedKey[1])}"]`)?.focus({ preventScroll: true });
}
async function refreshResources() {
  $('resource-refresh').disabled = true;
  if (!state.resources.uploading) resourceStatus('扫描中');
  try {
    const data = await jsonApi('/api/resources'); state.resources.files = Array.isArray(data.files) ? data.files : [];
    state.resources.folder = data.folder || ''; state.resources.folders = Array.isArray(data.folders) ? data.folders : [{ path: '', name: '资料库' }];
    if (!state.resources.folders.some(folder => folder.path === state.resources.currentFolder)) state.resources.currentFolder = '';
    state.resources.loaded = true; renderResources(); renderAttachments();
    if (data.issues?.length) resourceStatus(`${data.issues.length} 项无法读取`);
    else if (!state.resources.uploading) resourceStatus();
  } finally { $('resource-refresh').disabled = false; }
}
async function uploadResources(files) {
  if (!files.length || state.resources.uploading) return;
  const folder = state.resources.currentFolder;
  state.resources.uploading = true; $('resource-upload-button').disabled = true;
  let imported = 0, duplicates = 0, failed = 0, firstError = '';
  try {
    for (const file of files) {
      resourceStatus(`上传中 · ${imported + duplicates + failed + 1}/${files.length}`);
      try {
        const response = await fetch(`/api/resources/upload?name=${encodeURIComponent(file.name)}&folder=${encodeURIComponent(folder)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        if (!response.ok) throw await apiError(response);
        const result = await response.json(); if (result.duplicate) duplicates++; else imported++;
      } catch (error) { failed++; firstError ||= error.message; }
    }
    await refreshResources();
    resourceStatus([`已上传 ${imported} 份`, duplicates ? `${duplicates} 份已存在` : '', failed ? `${failed} 份失败` : ''].filter(Boolean).join(' · '));
    if (firstError) errorMessage(firstError);
  } catch (error) { errorMessage(error.message); }
  finally { state.resources.uploading = false; $('resource-upload-button').disabled = false; $('resource-upload').value = ''; }
}
async function showResource(id, { version = null, page = null, locator = null } = {}) {
  stopExtraction(); $('resource-extraction').hidden = true; $('resource-extraction-pages').replaceChildren();
  const request = ++state.resources.request;
  state.resources.selected = { id, name: '资料库' }; state.resources.version = version; state.resources.page = page; state.resources.locator = locator;
  setView('resources'); closeMobileList(); resourceStatus(); $('resource-preview').textContent = '读取中';
  $('resource-title').textContent = ''; $('resource-meta').textContent = '';
  for (const name of ['resource-open', 'resource-download', 'resource-copy', 'resource-extract', 'resource-summarize']) $(name).hidden = true;
  try {
    const endpoint = `/api/resources/${encodeURIComponent(id)}`;
    let response = await fetch(endpoint + (version ? `?version=${version}` : ''));
    if (response.status === 409 && version) response = await fetch(endpoint);
    if (!response.ok) throw await apiError(response);
    const file = await response.json();
    if (request !== state.resources.request || state.view !== 'resources') return;
    state.resources.selected = file; state.resources.currentFolder = resourceParent(file.relativePath); renderResources(); $('current-topic').textContent = file.name; $('resource-title').textContent = file.name;
    $('resource-meta').textContent = `${String(file.ext || 'FILE').replace(/^\./, '').toUpperCase()} · ${resourceSize(file.size)} · v${file.version} · ${resourceDate(file.modifiedAt)}${file.historical ? ' · 历史版本' : ''}${locator ? ` · ${locator}` : ''}`;
    const changed = version !== null && Number(version) !== Number(file.version);
    const ready = file.status === 'ready' && !changed;
    $('resource-open').hidden = !ready || !file.openable; $('resource-download').hidden = !ready; $('resource-copy').hidden = changed;
    $('resource-extract').hidden = !ready || !extractableResource(file); $('resource-summarize').hidden = !ready || !extractableResource(file);
    $('resource-download').href = file.downloadUrl; $('resource-download').download = file.name; $('resource-copy').textContent = '复制引用';
    const preview = $('resource-preview'); preview.replaceChildren();
    if (!state.resources.loaded) void refreshResources().catch(error => errorMessage(error.message));
    if (changed) {
      const text = document.createElement('p'); text.className = 'resource-notice'; text.textContent = `版本已更新 · v${version} → v${file.version}`;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.textContent = '当前版本'; button.addEventListener('click', () => { void showResource(id); }); preview.append(text, button); return;
    }
    if (!ready) { preview.textContent = file.status === 'missing' ? '文件已移出' : '无法读取'; return; }
    if (file.previewable && file.mime === 'application/pdf') {
      const frame = document.createElement('iframe'); frame.className = 'resource-pdf'; frame.title = file.name;
      frame.src = file.fileUrl + (Number.isSafeInteger(page) && page > 0 ? `#page=${page}` : ''); preview.append(frame);
    } else if (file.previewable && file.mime.startsWith('image/')) {
      const image = document.createElement('img'); image.className = 'resource-image'; image.alt = file.name; image.src = file.fileUrl; preview.append(image);
    } else if (file.previewable) {
      const response = await fetch(file.fileUrl); if (!response.ok) throw await apiError(response);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '', truncated = false;
      try {
        while (true) { const chunk = await reader.read(); if (chunk.done) { text += decoder.decode(); break; } text += decoder.decode(chunk.value, { stream: true }); if (text.length > 200000) { truncated = true; text = text.slice(0, 200000); await reader.cancel(); break; } }
      } finally { reader.releaseLock(); }
      if (request !== state.resources.request || state.view !== 'resources') return;
      const pre = document.createElement('pre'); pre.className = 'resource-text'; pre.textContent = text; preview.append(pre);
      if (truncated) { const note = document.createElement('p'); note.className = 'resource-notice'; note.textContent = '已显示前 200000 字'; preview.append(note); }
    } else {
      const mark = document.createElement('span'); mark.className = `resource-document-mark resource-kind-${resourceType(file)}`; mark.textContent = String(file.ext || 'FILE').replace(/^\./, '').toUpperCase(); preview.append(mark);
    }
    if (locator && file.mime !== 'application/pdf' && extractableResource(file)) void extractResource();
  } catch (error) { if (request === state.resources.request) $('resource-preview').textContent = error.message; }
}
function extractableResource(file) { return /^(pdf|docx?|txt|md|csv|log|json|xml|ya?ml|png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/.test(file?.ext || ''); }
function stopExtraction() {
  state.resources.extractController?.abort(); state.resources.extractController = null; $('resource-extract').textContent = '提取';
}
async function extractResource() {
  if (state.resources.extractController) { stopExtraction(); $('resource-extraction-status').textContent = '已停止'; return; }
  const file = state.resources.selected; if (!file?.id) return;
  const controller = new AbortController(), request = state.resources.request;
  state.resources.extractController = controller; $('resource-extract').textContent = '停止';
  $('resource-extraction').hidden = false; $('resource-extraction-status').textContent = '提取中'; $('resource-extraction-pages').replaceChildren();
  try {
    const data = await jsonApi(`/api/resources/${encodeURIComponent(file.id)}/extract`, { version: file.version }, { signal: controller.signal });
    if (controller.signal.aborted || request !== state.resources.request || state.view !== 'resources') return;
    const pages = Array.isArray(data.pages) ? data.pages : [];
    $('resource-extraction-status').textContent = [`${pages.length} 段`, data.cached ? '已缓存' : '', data.truncated ? '部分提取' : '', ...(data.warnings || [])].filter(Boolean).join(' · ');
    const fragment = document.createDocumentFragment(); let located;
    for (const page of pages) {
      const section = document.createElement('section'); section.className = 'resource-extracted-page'; section.dataset.locator = page.locator;
      const heading = document.createElement('h3'); heading.textContent = `${page.locator}${page.ocr ? ' · OCR' : ''}`;
      const text = document.createElement('p'); text.textContent = page.text; section.append(heading, text); fragment.append(section);
      if (state.resources.locator === page.locator) { section.classList.add('resource-located'); located = section; }
    }
    $('resource-extraction-pages').append(fragment);
    located?.scrollIntoView({ block: 'nearest' });
  } catch (error) { if (!controller.signal.aborted && request === state.resources.request) $('resource-extraction-status').textContent = error.message; }
  finally { if (state.resources.extractController === controller) { state.resources.extractController = null; $('resource-extract').textContent = '提取'; } }
}
function resourceReference(url) {
  try {
    const link = new URL(url);
    const id = link.protocol === 'resource:' ? link.pathname : link.origin === location.origin && ['/', '/index.html'].includes(link.pathname) ? link.searchParams.get('resource') : null;
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id || '')) return null;
    const version = Number(link.searchParams.get('version')), page = Number(new URLSearchParams(link.hash.slice(1)).get('page'));
    const locator = link.searchParams.get('locator');
    return { id, version: Number.isSafeInteger(version) && version > 0 ? version : null, page: Number.isSafeInteger(page) && page > 0 ? page : null, locator: locator?.slice(0, 500) || null };
  } catch { return null; }
}
function resourceLink({ id, version, page, locator }) {
  const url = new URL('/', location.origin); url.searchParams.set('resource', id);
  if (version) url.searchParams.set('version', version);
  if (locator) url.searchParams.set('locator', locator);
  if (page) url.hash = `page=${page}`;
  return url.href;
}
function resourceMarkdown(file) {
  const label = file.name.replace(/\\/g, '\\\\').replace(/([\[\]])/g, '\\$1');
  return `[${label}](<${resourceLink({ id: file.id, version: file.version })}>)`;
}
function renderAttachments() {
  const target = $('resource-attachments'); target.replaceChildren(); target.hidden = !state.attachments.length && !state.attachmentNotice;
  if (state.attachmentNotice && !state.attachments.length) { const status = document.createElement('span'); status.className = 'action-status'; status.setAttribute('role', 'status'); status.textContent = state.attachmentNotice; target.append(status); }
  for (const file of state.attachments) {
    const chip = document.createElement('span'); chip.className = 'resource-attachment';
    const name = document.createElement('span'); name.textContent = file.name;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除 ${file.name}`);
    remove.addEventListener('click', () => { if (state.active) halt('attachment'); state.current = null; state.replyPending = false; state.attachments = state.attachments.filter(item => item.id !== file.id); renderAttachments(); status(); });
    chip.append(name, remove); target.append(chip);
  }
}
function renderResourcePicker() {
  const search = $('resource-picker-search').value.trim().toLocaleLowerCase();
  const files = state.resources.files.filter(file => file.status === 'ready' && extractableResource(file) && file.relativePath.toLocaleLowerCase().includes(search));
  const target = $('resource-picker-files'); target.replaceChildren();
  for (const file of files) {
    const label = document.createElement('label'); label.className = 'resource-picker-row';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = file.id; input.checked = state.pickerSelection.has(file.id);
    const text = document.createElement('span'); text.textContent = file.relativePath;
    input.addEventListener('change', () => {
      if (input.checked && state.pickerSelection.size >= 5) { input.checked = false; $('resource-picker-status').textContent = '最多选择 5 份'; return; }
      if (input.checked) state.pickerSelection.add(file.id); else state.pickerSelection.delete(file.id);
      $('resource-picker-status').textContent = `${state.pickerSelection.size} 份`;
    });
    label.append(input, text); target.append(label);
  }
  if (!files.length) { const empty = document.createElement('p'); empty.className = 'document-empty'; empty.textContent = '暂无资料'; target.append(empty); }
}
async function openResourcePicker() {
  if (!agentAvailable('summarizer')) { errorMessage('资料摘要助手已删除。'); return; }
  if (state.active) halt('attachment');
  $('resource-picker-search').value = ''; state.pickerSelection = new Set(state.attachments.map(file => file.id));
  $('resource-picker-status').textContent = '读取中'; $('resource-picker-files').replaceChildren(); $('resource-picker-dialog').showModal();
  try { await refreshResources(); renderResourcePicker(); $('resource-picker-status').textContent = `${state.pickerSelection.size} 份`; }
  catch (error) { $('resource-picker-status').textContent = error.message; }
}
function summarizeResource() {
  if (!agentAvailable('summarizer')) { errorMessage('资料摘要助手已删除。'); return; }
  const file = state.resources.selected; if (!file?.id) return;
  newChat(); selectAgent('summarizer'); state.attachments = [file]; state.attachmentNotice = ''; renderAttachments();
  $('topic').value = '请摘要这份资料'; $('topic').focus();
}

function splitSentences(text) {
  text = text.replace(/https?:\/\/[^\s\u3000-\u303f\u4e00-\u9fff]+/gi, ''); const result = [];
  for (const part of text.match(/[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+/g) || []) {
    let rest = part;
    while (rest.length > 65) { const window = rest.slice(0, 65); const comma = Math.max(window.lastIndexOf('，'), window.lastIndexOf(','), window.lastIndexOf('、')); let length = comma > 20 ? comma + 1 : 65; const citation = rest.slice(0, length).lastIndexOf('['); if (citation > 20 && rest.indexOf(']', citation) >= length) length = citation; result.push(rest.slice(0, length)); rest = rest.slice(length); }
    if (rest.trim()) result.push(rest);
  }
  return result;
}
function prepareCard(segment) {
  segment.card ||= messageCard('assistant', '', segment.agentId, segment.id);
  if (!segment.card.activity) restoreActivity(segment.card, segment.activities || []);
  const read = shouldRead(profile(segment.agentId));
  if (read) {
    segment.card.body.replaceChildren(); segment.spans = segment.sentences.map(text => { const span = document.createElement('span'); span.className = 'sentence'; span.textContent = text; segment.card.body.append(span); return span; });
  } else { renderMarkdown(segment.card.body, segment.text); segment.spans = []; }
  if (segment.research) renderSources(segment.card, segment.research);
  addActions(segment.card);
  if (segment.knowledge?.pages?.length) {
    const actions = segment.card.element.querySelector('.message-actions');
    actions.querySelectorAll('[data-note]').forEach(button => button.remove());
    for (const page of segment.knowledge.pages) { const button = document.createElement('button'); button.type = 'button'; button.dataset.note = page.path; button.textContent = noteTitle(page.path); button.addEventListener('click', () => { void showNote(page.path); }); actions.append(button); }
  }
}

async function generate(epoch, extra = '', visible = false, group = null) {
  if (!isCurrent(epoch)) throw abortError();
  const selected = group?.selected || profile(); const controller = new AbortController(); state.controllers.add(controller);
  const id = state.keepMemory ? crypto.randomUUID() : null; let webSearch = !group && !['summarizer', 'harness2'].includes(selected.id) && $('web-search').checked;
  let research = null, knowledge = null, handoff = null, decision = null; const activities = new Map();
  const card = visible ? messageCard('assistant', '', selected.id, id) : null;
  if (card) { state.pendingCard = card; ensureActivity(card, { live: true }); status(group ? `${selected.name}发言中` : '生成中', 'thinking'); }
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ agent: selected.id, apiKey: $('api-key').value.trim(), model: $('model').value,
        messages: group?.messages || conversationContext(selected.id, state.messages, extra), webSearch,
        ...(group ? { discussion: group.discussion } : state.resourceIds.length ? { resourceIds: state.resourceIds } : {}),
        ...(id ? { memory: { sessionId: state.sessionId, id, visible, curate: false } } : {}),
        ...(webSearch ? { research: state.research } : {}),
      }),
    });
    if (!response.ok) throw await apiError(response);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '', text = '', done = false;
    function consume(line) {
      if (!line.startsWith('data:')) return; const value = line.slice(5).trim(); if (!value) return;
      if (value === '[DONE]') { done = true; return; }
      const data = JSON.parse(value); if (data.error) throw new Error(typeof data.error === 'string' ? data.error : '生成失败');
      if (data.activity) {
        activities.set(data.activity.id, { ...activities.get(data.activity.id), ...data.activity });
        if (activities.size > 60) activities.delete(activities.keys().next().value);
        if (card) { updateActivity(card, data.activity); if (!group && data.activity.state === 'running') status(data.activity.title, 'thinking'); }
      }
      if (data.heartbeat && card?.activity) { card.activity.lastSignal = Date.now(); refreshActivityClock(card.activity); }
      if (data.memory?.localOnly || data.webSearch === false) webSearch = false;
      if (data.research_status) {
        $('research-panel').hidden = false; $('research-status').textContent = ({ planning: '规划中', searching: '查询中', writing: '整理中' })[data.research_status.stage] || '查询中';
        if (data.research_status.query) $('research-query').textContent = data.research_status.query;
        if (visible) status($('research-status').textContent, 'thinking');
      }
      if (data.research) research = receiveResearch(data.research, card);
      if (activities.size && visible) $('research-panel').hidden = true;
      if (data.knowledge_status && visible) status(({ local: '检索中', search: '查询中', sources: '读取中', evidence: '核查中', archive: '存档中', checking: '核查中', searching: '查询中', reading: '读取中', writing: '整理中', saving: '存档中' })[data.knowledge_status.stage] || '核查中', 'thinking');
      if (data.knowledge) { knowledge = data.knowledge; if (data.knowledge.mode === 'local' || selected.id === 'librarian') webSearch = false; }
      if (data.handoff) handoff = data.handoff;
      if (data.discussion) decision = data.discussion;
      const delta = data.choices?.[0]?.delta?.content; if (typeof delta === 'string') text += delta;
      if (card) {
        if (typeof delta === 'string') { card.body.textContent = text; card.activity.characters = text.length; }
        refreshActivityClock(card.activity);
        if (state.view === 'chat') scrollConversation();
      }
    }
    while (true) {
      const chunk = await reader.read(); if (!isCurrent(epoch)) { await reader.cancel(); throw abortError(); }
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done }); let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline).replace(/\r$/, '')); buffer = buffer.slice(newline + 1); }
      if (chunk.done) break;
    }
    if (buffer.trim()) consume(buffer.replace(/\r$/, ''));
    if (!done) throw new Error('连接中断');
    if (webSearch && !research && selected.id !== 'librarian') throw new Error('没有收到查询资料');
    text = text.trim(); if (!text) throw new Error('没有收到回答'); if (!isCurrent(epoch)) throw abortError();
    if (card) finishActivity(card);
    if (state.pendingCard === card) state.pendingCard = null;
    return { id, text, sentences: splitSentences(text), index: 0, card, entry: null, research, knowledge, handoff, decision, activities: [...activities.values()], agentId: selected.id };
  } catch (error) {
    controller.abort();
    if (card) {
      finishActivity(card, error.name === 'AbortError' ? 'cancelled' : 'failed', error.name === 'AbortError' ? '' : error.message);
      card.label.textContent = `${selected.name} · 未完成`;
      if (state.pendingCard === card) state.pendingCard = null;
    }
    throw error;
  } finally { state.controllers.delete(controller); if (id && !group) void refreshMemory().catch(() => {}); }
}

function speak(text, epoch, onStart) {
  return new Promise((resolve, reject) => {
    if (!isCurrent(epoch)) { reject(abortError()); return; }
    const spoken = text.replace(/https?:\/\/[^\s\u3000-\u303f\u4e00-\u9fff]+/gi, '').replace(/\[\^?[^\]\n]*\]/g, '').replace(/[【\[]来源[^】\]]*[】\]]/g, '').replace(/[#*`]/g, '').trim();
    if (!spoken || !/[\p{L}\p{N}]/u.test(spoken)) { resolve(); return; }
    const utterance = new SpeechSynthesisUtterance(spoken); utterance.lang = 'zh-CN'; utterance.voice = state.voices.find(v => v.voiceURI === $('voice').value) || null; utterance.rate = Number($('rate').value);
    let finished = false, endTimer; const startTimer = setTimeout(() => finish(new Error('朗读未启动')), 12000);
    function finish(error) { if (finished) return; finished = true; clearTimeout(startTimer); clearTimeout(endTimer); utterance.onstart = utterance.onend = utterance.onerror = null; if (state.cancelSpeech === cancel) state.cancelSpeech = null; error ? reject(error) : resolve(); }
    const cancel = () => finish(abortError()); state.cancelSpeech = cancel;
    utterance.onstart = () => { if (!isCurrent(epoch)) { finish(abortError()); return; } clearTimeout(startTimer); endTimer = setTimeout(() => finish(new Error('朗读超时')), 60000); onStart?.(); };
    utterance.onend = () => finish(isCurrent(epoch) ? null : abortError()); utterance.onerror = event => finish(isCurrent(epoch) ? new Error(`朗读失败（${event.error || '声音不可用'}）`) : abortError()); synth.speak(utterance);
  });
}
async function run(epoch) {
  const selected = profile();
  try {
    while (isCurrent(epoch)) {
      let segment = state.current;
      if (!segment) {
        const pending = state.prefetch; state.prefetch = null;
        if (pending) { const result = await pending; if (result.error) throw result.error; segment = result.segment; }
        else segment = await generate(epoch, '', true);
        if (!isCurrent(epoch)) return;
        if (segment.id) await memoryApi('playback', { id: segment.id, visible: true, played: 0 });
        if (!isCurrent(epoch)) return;
        state.current = segment; prepareCard(segment);
        segment.entry = { role: 'assistant', content: selected.continuous ? '' : segment.text, agent: selected.id, id: segment.id };
        state.messages.push(segment.entry); state.messages = state.messages.slice(-20);
      }
      if (segment.handoff) {
        segment.entry.content = segment.text; segment.card.label.textContent = selected.name; state.current = null; state.replyPending = false; state.active = false; status();
        await openHandoff(segment.handoff, epoch); return;
      }
      const read = shouldRead(selected);
      status(read ? '朗读中' : '已回答', read ? 'speaking' : 'idle'); segment.card.label.textContent = selected.name;
      while (read && segment.index < segment.sentences.length && isCurrent(epoch)) {
        const index = segment.index;
        if (selected.continuous && !state.prefetch && index / segment.sentences.length >= .6) state.prefetch = generate(epoch, segment.text).then(next => ({ segment: next }), error => ({ error }));
        try {
          await speak(segment.sentences[index], epoch, () => { segment.spans.forEach((span, i) => span.classList.toggle('speaking', i === index)); scrollConversation(); });
        } catch (error) {
          if (selected.id !== 'librarian' || error.name === 'AbortError') throw error;
          break;
        }
        if (!isCurrent(epoch)) return;
        if (selected.continuous) segment.entry.content += segment.sentences[index]; segment.index++;
        if (segment.id) void memoryApi('playback', { id: segment.id, played: segment.index }, true).catch(() => {});
      }
      if (!isCurrent(epoch)) return;
      if (selected.id === 'librarian' && read) renderMarkdown(segment.card.body, segment.text);
      segment.spans.forEach(span => span.classList.remove('speaking')); state.count++; $('segment-count').textContent = String(state.count);
      segment.card.label.textContent = `${selected.name}${selected.continuous ? ` · ${state.count}` : ''}`;
      if (segment.knowledge) {
        const actions = segment.card.element.querySelector('.message-actions'); let result = actions.querySelector('.knowledge-result');
        if (!result) { result = document.createElement('span'); result.className = 'action-status knowledge-result'; actions.append(result); }
        const knowledge = segment.knowledge;
        result.textContent = knowledge.pending ? '待继续' : knowledge.mode === 'local' ? '本地' : knowledge.saved ? '已收录' : knowledge.permissionRequired ? '未授权' : knowledge.error ? '存档失败' : knowledge.mode === 'maintenance' ? '未修改' : knowledge.outcome === '待补充' ? '待补充' : '未收录';
        if (knowledge.error) errorMessage(knowledge.error);
      }
      record(selected.continuous ? 'segment_complete' : 'answer_complete'); state.current = null;
      if (!selected.continuous) { state.replyPending = segment.knowledge?.pending === true; state.active = false; status(state.replyPending ? '待继续' : '已回答'); return; }
    }
  } catch (error) { if (!isCurrent(epoch)) return; halt('error'); errorMessage(error.name === 'TypeError' ? '网络连接失败' : error.message); status('已停止', 'error'); }
}

async function runDiscussion(epoch) {
  const participants = state.participants;
  const question = state.messages.at(-1);
  let proposal = '', accepted = [], next = 0;
  try {
    while (isCurrent(epoch)) {
      const selected = profile(participants[next]);
      const context = state.messages.filter(message => message.content).slice(-8);
      if (!context.includes(question)) context.unshift(question);
      const messages = context.map(({ role, agent, content }) => ({
        role, agent, content: role === 'user' ? content : content.slice(-1800),
      }));
      const segment = await generate(epoch, '', true, {
        selected, messages, discussion: { participants, userId: question.id, proposal, accepted },
      });
      if (!isCurrent(epoch)) return;
      if (!segment.decision) throw new Error('未收到群聊结果，请重新发送消息。');
      renderMarkdown(segment.card.body, segment.text);
      addActions(segment.card);
      state.messages.push({ role: 'assistant', content: segment.text, agent: selected.id, id: segment.id });
      state.messages = state.messages.slice(-20);
      $('segment-count').textContent = String(++state.count);
      if ($('reply-voice').checked && synth && window.SpeechSynthesisUtterance) {
        status(`${selected.name}朗读中`, 'speaking');
        try { for (const sentence of segment.sentences) await speak(sentence, epoch); }
        catch (error) { if (error.name !== 'AbortError') errorMessage(error.message); }
      }
      if (!isCurrent(epoch)) return;
      if (segment.decision.consensus) {
        state.active = false; status('已达成共识'); return;
      }
      ({ proposal, accepted } = segment.decision);
      next = (next + 1) % participants.length;
    }
  } catch (error) {
    if (!isCurrent(epoch)) return;
    halt('error'); errorMessage(error.name === 'TypeError' ? '网络连接失败' : error.message); status('讨论已停止', 'error');
  }
}

function shouldRead(agent) {
  if (agent.id === 'librarian' && (!synth || !window.SpeechSynthesisUtterance)) return false;
  return agent.continuous || $('reply-voice').checked;
}
function start() {
  if (!state.connected || !state.topic || state.active || !agentAvailable(state.agent)) return;
  if (state.participants.length) {
    if (!state.replyPending) return;
    state.replyPending = false; errorMessage(); state.active = true;
    void runDiscussion(++state.epoch);
    return;
  }
  if (!profile().continuous && !state.replyPending) return;
  if (shouldRead(profile()) && (!synth || !window.SpeechSynthesisUtterance)) { errorMessage('浏览器不支持朗读'); return; }
  errorMessage(); state.active = true; const epoch = ++state.epoch; status('生成中', 'thinking'); void run(epoch);
}

let connectionVersion = 0;
async function connect() {
  const apiKey = $('api-key').value.trim(); if (!apiKey) { $('api-key').focus(); return; }
  halt('settings'); state.connected = false; const version = ++connectionVersion; const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000); $('connect-btn').disabled = true; $('connection-status').textContent = '连接中'; status('连接中', 'thinking'); errorMessage();
  try {
    const data = await jsonApi('/api/models', { apiKey }, { signal: controller.signal }); if (version !== connectionVersion) return;
    const models = data.data?.filter(m => typeof m.id === 'string') || []; if (!models.length) throw new Error('没有可用模型');
    const previous = $('model').value; $('model').replaceChildren(...models.map(m => new Option(m.id, m.id)));
    $('model').value = models.some(m => m.id === previous) ? previous : (models.find(m => m.id === 'deepseek-flash') || models.find(m => m.id === 'deepseek-chat') || models[0]).id;
    state.connected = true; $('connection-status').textContent = '已连接'; status();
  } catch (error) { if (version === connectionVersion) { $('connection-status').textContent = error.name === 'AbortError' ? '连接超时' : error.message; errorMessage(error.name === 'AbortError' ? '连接超时' : error.message); status('未连接', 'error'); } }
  finally { clearTimeout(timer); if (version === connectionVersion) $('connect-btn').disabled = false; }
}
function populateVoices() {
  if (!synth) return; const selected = $('voice').value; state.voices = synth.getVoices().filter(v => /^zh|^cmn/i.test(v.lang));
  $('voice').replaceChildren(new Option('系统默认', ''), ...state.voices.map(v => new Option(v.name, v.voiceURI)));
  $('voice').value = state.voiceChosen && (!selected || state.voices.some(v => v.voiceURI === selected)) ? selected : (state.voices.find(v => v.localService && /zh[-_]CN/i.test(v.lang)) || state.voices[0])?.voiceURI || '';
}
function workflowChoices() {
  const catalog = workflowEditor.catalog();
  const counts = new Map();
  for (const item of catalog) {
    const key = item.name.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const aliases = new Set(state.agents.flatMap(item => agentNames(item).map(name => name.toLowerCase())));
  return catalog.map(item => {
    const key = item.name.toLowerCase(), suffix = '〔' + item.id.slice(0, 8) + '〕';
    const token = /[@＠\r\n]/u.test(item.name) ? '工作流' + suffix
      : counts.get(key) > 1 || aliases.has(key) ? item.name + suffix : item.name;
    return { ...item, token, kind: 'workflow' };
  });
}

function chatMentions(text) {
  const workflows = new Set();
  let remaining = text;
  if (/[@＠]/u.test(text) && workflowEditor.catalog().length) {
    const choices = new Map(workflowChoices().map(item => [item.token.toLowerCase(), item]));
    const tokens = [...choices.keys()].sort((a, b) => b.length - a.length).map(name => {
      const escaped = name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
      return /^[\w -]+$/u.test(name) ? escaped + '(?![\\w.-])' : escaped;
    });
    const pattern = new RegExp('(^|[\\s,(（，、：:])[@＠](' + tokens.join('|') + ')', 'giu');
    remaining = text.replace(pattern, (_, before, token) => {
      workflows.add(choices.get(token.toLowerCase()));
      return before + ' ';
    });
  }
  return { ...parseAgentMentions(remaining), workflows: [...workflows] };
}

function updateSendButton(mentioned = chatMentions($('topic').value)) {
  $('send-btn').disabled = state.saving || (!state.connected || !state.agents.length) && !mentioned.workflows.length;
}

function renderDiscussion() {
  const mentions = chatMentions($('topic').value), { ids } = mentions;
  const participants = mentions.workflows.length || ids.length === 1 ? [] : ids.length ? ids : state.participants;
  const group = $('discussion-members');
  group.hidden = !participants.length;
  const names = participants.map(id => profile(id).name).join('、');
  const label = $('discussion-names');
  if (label.textContent !== names) label.textContent = names;
  const picker = $('agent-picker');
  const name = mentions.workflows[0]?.name || (state.agents.length ? profile(ids[0] || state.agent).name : '');
  picker.textContent = participants.length ? '@ 添加 Agent' : name ? '@' + name : '@ 选择工作流';
  picker.setAttribute('aria-label', '选择要 @ 的 Agent 或工作流' + (!participants.length && name ? '，当前为' + name : ''));
  updateSendButton(mentions);
}

function closeMentionMenu() {
  $('mention-menu').hidden = true;
  $('agent-picker').setAttribute('aria-expanded', 'false');
}

function mentionMenu(all = false) {
  const field = $('topic');
  const before = field.value.slice(0, field.selectionStart);
  const match = before.match(/[@＠]([^@＠\r\n]*)$/u);
  if (!all && !match) { closeMentionMenu(); return; }
  const query = all ? '' : match[1].toLowerCase();
  const selected = chatMentions(field.value);
  const inherited = all && !selected.ids.length && !selected.workflows.length ? state.participants : [];
  const workflowOptions = workflowChoices().filter(item => (query === '工作流' || [item.name, item.token].some(name => name.toLowerCase().includes(query)))
    && (!selected.workflows.some(flow => flow.id === item.id) || !all && match[1].toLowerCase() === item.token.toLowerCase()));
  const agentOptions = state.agents.filter(item => agentNames(item).some(name => name.toLowerCase().includes(query))
    && !inherited.includes(item.id) && (!selected.ids.includes(item.id) || !all && parseAgentMentions(match[0]).ids.includes(item.id)));
  const options = [...workflowOptions, ...agentOptions];
  const menu = $('mention-menu'); menu.replaceChildren();
  for (const item of options) {
    const option = document.createElement('button'); option.type = 'button'; option.className = 'mention-option';
    const label = document.createElement('span'); label.className = 'mention-name'; label.textContent = '@' + (item.token || item.name);
    option.append(label);
    if (item.kind === 'workflow') {
      option.dataset.workflow = item.id;
      const kind = document.createElement('span'); kind.className = 'mention-kind'; kind.textContent = '工作流'; option.append(kind);
    } else option.dataset.agent = item.id;
    option.addEventListener('click', () => {
      if (state.active || state.saving) halt('typing');
      const start = all ? field.selectionStart : match.index;
      const spacer = all && start && !/\s/u.test(field.value[start - 1]) ? ' ' : '';
      const names = item.kind === 'workflow' ? ['@' + item.token] : [...inherited.map(id => profile(id).name), item.name].map(name => '@' + name);
      field.setRangeText(spacer + names.join(' ') + ' ', start, field.selectionEnd, 'end');
      closeMentionMenu(); renderDiscussion(); field.focus();
    }); menu.append(option);
  }
  menu.hidden = !options.length; $('agent-picker').setAttribute('aria-expanded', String(!!options.length));
  if (all) menu.firstElementChild?.focus();
}

function bindWorkflowInputs(fields, text) {
  const keys = new Map(fields.flatMap(item => [[item.name.toLowerCase(), item.name], [item.label.toLowerCase(), item.name]]));
  const values = new Map();
  let current;
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^([^:：]+)[:：][ \t]*(.*)$/u);
    const key = match && keys.get(match[1].trim().toLowerCase());
    if (key) {
      current = key;
      values.set(key, match[2]);
    } else if (current) values.set(current, values.get(current) + '\n' + line);
  }
  if (!values.size && text) {
    const paragraphs = fields.filter(item => item.type === 'paragraph');
    const target = fields.length === 1 ? fields[0] : paragraphs.length === 1 ? paragraphs[0] : null;
    if (target) values.set(target.name, text);
  }
  return Object.fromEntries([...values].map(([key, value]) => [key, value.trim()]));
}

function askWorkflowInputs(flow, fields, inputs) {
  const dialog = $('chat-workflow-dialog'), form = $('chat-workflow-form'), target = $('chat-workflow-fields');
  $('chat-workflow-title').textContent = flow.name;
  target.replaceChildren();
  for (const [index, item] of fields.entries()) {
    const field = document.createElement('div'); field.className = 'wf-field';
    const label = document.createElement('label'); label.textContent = item.label;
    const input = document.createElement(item.type === 'paragraph' ? 'textarea' : 'input');
    label.htmlFor = input.id = 'chat-workflow-field-' + index;
    input.name = item.name; input.value = Object.hasOwn(inputs, item.name) ? inputs[item.name] : '';
    input.required = item.required; input.maxLength = 4000;
    if (item.type === 'paragraph') input.rows = 5;
    input.addEventListener('input', () => input.setCustomValidity(''));
    field.append(label, input); target.append(field);
  }
  const controls = [...target.querySelectorAll('input, textarea')];
  return new Promise(resolve => {
    let result = null;
    form.onsubmit = event => {
      event.preventDefault();
      const missing = controls.find(input => input.required && !input.value.trim());
      if (missing) { missing.setCustomValidity('请填写此项。'); missing.reportValidity(); return; }
      result = Object.fromEntries(new FormData(form));
      dialog.close();
    };
    dialog.addEventListener('close', () => { form.onsubmit = null; resolve(result); }, { once: true });
    dialog.showModal();
    (controls.find(input => input.required && !input.value.trim()) || controls[0])?.focus();
  });
}

async function submitWorkflow(entry, text, raw) {
  if (state.attachments.length) { errorMessage('请先移除对话附件，再运行工作流。'); return; }
  halt('interrupt');
  const epoch = state.epoch, controller = new AbortController(), sessionId = state.sessionId, agent = state.agent;
  state.controllers.add(controller); state.saving = true; status('加载工作流', 'thinking'); errorMessage();
  const userId = crypto.randomUUID(), replyId = crypto.randomUUID();
  let card, completed = false, failure = '';
  try {
    const flow = await jsonApi('/api/workflows/' + entry.id, undefined, { signal: controller.signal });
    if (epoch !== state.epoch) return;
    if (flow.deleted) throw new Error('这个工作流已删除，可以查看历史运行。');
    const { apiKey, model } = workflowConnection();
    if (!apiKey && flow.nodes.some(node => ['llm', 'agent'].includes(node.type))) { openConnectionSettings(); return; }
    const fields = flow.nodes.find(node => node.type === 'start').config.fields;
    const bound = bindWorkflowInputs(fields, text);
    const needsFields = fields.some(field => field.required && !(Object.hasOwn(bound, field.name) && bound[field.name]))
      || (!text && fields.length > 0);
    const inputs = needsFields ? await askWorkflowInputs(flow, fields, bound) : bound;
    if (!inputs || epoch !== state.epoch) return;
    const content = needsFields ? ['@' + entry.token, ...fields.filter(field => inputs[field.name]?.trim())
      .map(field => field.label + '：' + inputs[field.name])].join('\n') : raw;
    if (content.length > 4000) throw new Error('工作流输入超过 4000 字，请缩短后再发送。');
    if (state.keepMemory) {
      await memoryInitialization;
      if (epoch !== state.epoch) return;
      if (!state.memoryReady) throw new Error('记录服务不可用');
    }
    state.saving = false; state.active = state.runningWorkflow = true;
    state.participants = []; state.current = null; state.replyPending = false; state.topic = ''; resetResearch();
    status('工作流运行中', 'thinking');
    const chat = state.keepMemory ? { sessionId, userId, replyId, agent, content } : undefined;
    await streamWorkflow(flow.id, { apiKey, model, inputs, revision: flow.revision, chat }, controller.signal, apiError, event => {
      if (!isCurrent(epoch)) return;
      if (event.id) {
        const workflow = { id: flow.id, name: event.name || flow.name, runId: event.id };
        messageCard('user', content, agent, userId, sessionId, workflow);
        state.messages.push({ role: 'user', content, agent, id: userId, workflow });
        if (state.title === '新对话') state.title = content.split(/\r?\n/, 1)[0].slice(0, 80);
        $('current-topic').textContent = state.title;
        $('topic').value = ''; closeMentionMenu(); renderDiscussion();
        card = state.pendingCard = messageCard('assistant', '', agent, replyId, sessionId, workflow);
        ensureActivity(card, { live: true });
        if (chat) void refreshMemory().catch(() => {});
      }
      if (card && event.step && event.step.status !== 'skipped') {
        const step = event.step, title = flow.nodes.find(node => node.id === step.id)?.title || '运行节点';
        const started = new Date(step.started).toISOString();
        updateActivity(card, { id: step.id, kind: 'answer', title, state: step.status === 'stopped' ? 'cancelled' : step.status,
          at: new Date().toISOString(), startedAt: started, elapsedMs: step.elapsed, detail: step.error });
      }
      if (card && event.status === 'complete') {
        const answer = formatWorkflowOutput(event.output);
        renderMarkdown(card.body, answer);
        finishActivity(card);
        state.messages.push({ role: 'assistant', content: answer, agent, id: replyId, workflow: card.workflow });
        state.messages = state.messages.slice(-20);
        $('segment-count').textContent = String(++state.count);
        completed = true;
      }
      if (event.status === 'failed') throw new Error(event.error || '工作流执行失败。');
    });
    if (isCurrent(epoch) && !completed) throw new Error('工作流运行连接中断。');
  } catch (error) {
    if (epoch !== state.epoch) return;
    failure = error.message;
    if (card) { finishActivity(card, 'failed', failure); card.label.textContent += ' · 未完成'; }
    errorMessage(failure);
  } finally {
    state.controllers.delete(controller);
    if (epoch === state.epoch) {
      if (card) addActions(card);
      state.saving = state.active = state.runningWorkflow = false;
      state.pendingCard = null;
      status(completed ? '工作流已完成' : failure ? '工作流未完成' : undefined, failure ? 'error' : 'idle');
    }
  }
}

$('chat-workflow-close').addEventListener('click', () => $('chat-workflow-dialog').close());
$('composer').addEventListener('submit', async event => {
  event.preventDefault(); const raw = $('topic').value.trim() || (state.attachments.length ? '请摘要这些资料' : ''); if (!raw) return;
  const mentioned = chatMentions(raw);
  if (mentioned.workflows.length) {
    if (mentioned.workflows.length !== 1 || mentioned.ids.length) { errorMessage('一次请选择一个工作流运行。'); return; }
    await submitWorkflow(mentioned.workflows[0], mentioned.text, raw);
    return;
  }
  if (!state.connected) { $('settings-dialog').showModal(); $('api-key').focus(); return; }
  const participants = mentioned.ids.length === 1 ? [] : mentioned.ids.length ? mentioned.ids : state.participants;
  const agent = mentioned.ids[0] || participants[0] || state.agent;
  const missing = (participants.length ? participants : [agent]).find(id => !agentAvailable(id));
  if (missing) {
    errorMessage(state.agents.length ? '「' + profile(missing).name + '」已删除，请选择其他 Agent。' : '暂无可用 Agent，可以从 @ 菜单选择工作流。');
    return;
  }
  if (!mentioned.text) {
    if (participants.length) { errorMessage('请写下想让这些 Agent 讨论的问题。'); return; }
    $('topic').value = ''; closeMentionMenu(); selectAgent(agent); return;
  }
  if (participants.length && state.attachments.length) {
    errorMessage('群聊可讨论已有消息。请先用资料摘要助手读取附件，或移除附件后开始群聊。'); return;
  }
  const attachments = agent === 'summarizer' ? state.attachments : [];
  const references = attachments.map(resourceMarkdown).join('\n');
  const savedContent = raw + (references ? `\n\n${references}` : '');
  const content = mentioned.text + (references ? `\n\n${references}` : '');
  if (savedContent.length > 4000) { errorMessage('消息与资料引用超过 4000 字，请缩短消息'); return; }
  halt('interrupt');
  const epoch = state.epoch; state.saving = true; status('保存中', 'thinking');
  try {
    await memoryInitialization; if (epoch !== state.epoch) return;
    if (state.keepMemory && !state.memoryReady) throw new Error('记录服务不可用');
    const id = crypto.randomUUID();
    if (state.keepMemory) await memoryApi('user', { sessionId: state.sessionId, id, content: savedContent, agent, participants });
    if (epoch !== state.epoch) return;
    state.participants = participants;
    selectAgent(agent, false);
    state.current = null; state.topic = mentioned.text; state.replyPending = true; state.resourceIds = attachments.map(file => file.id);
    state.messages.push({ role: 'user', content, agent: state.agent, id }); state.messages = state.messages.slice(-20);
    if (state.title === '新对话') state.title = mentioned.text.slice(0, 80);
    $('current-topic').textContent = state.title; const card = messageCard('user', savedContent, state.agent, id); if (references) renderMarkdown(card.body, savedContent);
    $('topic').value = ''; closeMentionMenu(); renderDiscussion(); resetResearch(mentioned.text); record('question', { text: raw });
    if (state.keepMemory) void refreshMemory().catch(() => {});
  } catch (error) { if (epoch === state.epoch) errorMessage(error.message); return; }
  finally { if (epoch === state.epoch) { state.saving = false; status(); } }
  if (epoch === state.epoch) start();
});
$('topic').addEventListener('input', () => { if (state.active || state.saving) halt('typing'); if (state.attachmentNotice) { state.attachmentNotice = ''; renderAttachments(); } renderDiscussion(); mentionMenu(); });
$('topic').addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Escape') { closeMentionMenu(); return; }
  if (!$('mention-menu').hidden && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    (event.key === 'ArrowDown' ? $('mention-menu').firstElementChild : $('mention-menu').lastElementChild)?.focus();
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    const field = event.currentTarget;
    const partial = field.value.slice(0, field.selectionStart).match(/[@＠][^@＠\r\n]*$/u);
    const menu = $('mention-menu');
    if (!menu.hidden && partial && chatMentions(partial[0]).text) {
      if (menu.childElementCount === 1) menu.firstElementChild.click();
      else menu.firstElementChild?.focus();
      return;
    }
    $('composer').requestSubmit();
  }
});
$('mention-menu').addEventListener('keydown', event => {
  const menu = event.currentTarget;
  if (event.key === 'Escape') { event.preventDefault(); closeMentionMenu(); $('topic').focus(); }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    (event.key === 'ArrowDown' ? event.target.nextElementSibling || menu.firstElementChild
      : event.target.previousElementSibling || menu.lastElementChild)?.focus();
  }
});
$('agent-picker').addEventListener('click', () => { if ($('mention-menu').hidden) mentionMenu(true); else closeMentionMenu(); });
document.addEventListener('click', event => { if (!event.target.closest('.composer-dock')) closeMentionMenu(); });
$('pause-btn').addEventListener('click', () => halt()); $('resume-btn').addEventListener('click', start);
$('new-chat').addEventListener('click', newChat);
for (const view of ['chat', 'agents', 'workflow', 'library', 'resources', 'graph']) $(`nav-${view}`).addEventListener('click', () => {
  if (view === 'resources') { stopExtraction(); state.resources.selected = null; state.resources.request++; }
  setView(view);
  // 图谱本身就是要看全屏，窄屏进来不自动弹出笔记列表，免得把画布盖住。
  if (['graph', 'workflow'].includes(view)) closeMobileList();
  else if (matchMedia('(max-width:760px)').matches) document.querySelector('.workspace').classList.add('list-open');
  if (view === 'resources') void refreshResources().catch(error => errorMessage(error.message));
  else if (!['graph', 'workflow'].includes(view)) void refreshMemory().catch(() => {});
});
$('list-search').addEventListener('input', () => { if (state.view === 'resources') { stopExtraction(); state.resources.request++; state.resources.selected = null; $('current-topic').textContent = '资料库'; } renderLists(); });
$('attach-resource').addEventListener('click', () => { void openResourcePicker(); });
$('resource-picker-search').addEventListener('input', renderResourcePicker);
$('resource-picker-close').addEventListener('click', () => $('resource-picker-dialog').close());
$('resource-picker-confirm').addEventListener('click', () => {
  if (!agentAvailable('summarizer')) { $('resource-picker-dialog').close(); errorMessage('资料摘要助手已删除。'); return; }
  state.attachments = state.resources.files.filter(file => state.pickerSelection.has(file.id) && file.status === 'ready').slice(0, 5);
  state.current = null; state.replyPending = false;
  state.attachmentNotice = ''; if (state.attachments.length) selectAgent('summarizer');
  renderAttachments(); status(); $('resource-picker-dialog').close(); $('topic').focus();
});
$('resource-new-folder').addEventListener('click', () => { $('resource-folder-name').value = ''; $('resource-folder-status').textContent = ''; $('resource-folder-dialog').showModal(); });
$('resource-folder-close').addEventListener('click', () => $('resource-folder-dialog').close());
$('resource-folder-form').addEventListener('submit', async event => {
  event.preventDefault(); const name = $('resource-folder-name').value.trim(); if (!name) return;
  const button = $('resource-folder-form').querySelector('button'); button.disabled = true; $('resource-folder-status').textContent = '创建中';
  try { await jsonApi('/api/resources/folders', { parent: state.resources.currentFolder, name }); await refreshResources(); $('resource-folder-dialog').close(); }
  catch (error) { $('resource-folder-status').textContent = error.message; }
  finally { button.disabled = false; }
});
$('resource-upload-button').addEventListener('click', () => $('resource-upload').click());
$('resource-upload').addEventListener('change', () => { void uploadResources([...$('resource-upload').files]); });
$('resource-refresh').addEventListener('click', async () => {
  const selectedId = state.resources.selected?.id; resourceStatus();
  try { await refreshResources(); if (selectedId && state.view === 'resources' && state.resources.selected?.id === selectedId) await showResource(selectedId, { version: state.resources.version, page: state.resources.page, locator: state.resources.locator }); }
  catch (error) { errorMessage(error.message); }
});
$('resource-open-folder').addEventListener('click', async () => { try { await jsonApi('/api/resources/open-folder', { folder: state.resources.currentFolder }); } catch (error) { errorMessage(error.message); } });
$('resource-back').addEventListener('click', () => selectResourceFolder(state.resources.currentFolder));
$('resource-extract').addEventListener('click', () => { void extractResource(); });
$('resource-summarize').addEventListener('click', summarizeResource);
$('resource-open').addEventListener('click', async () => {
  const file = state.resources.selected; if (!file?.id) return;
  try { await jsonApi(`/api/resources/${encodeURIComponent(file.id)}/open?version=${file.version}`, {}); } catch (error) { errorMessage(error.message); }
});
$('resource-copy').addEventListener('click', async () => {
  const file = state.resources.selected; if (!file?.id) return;
  const label = file.name.replace(/\\/g, '\\\\').replace(/([\[\]])/g, '\\$1');
  try { await navigator.clipboard.writeText(`[${label}](<${resourceLink({ id: file.id, version: file.version, page: state.resources.page, locator: state.resources.locator })}>)`); $('resource-copy').textContent = '已复制'; }
  catch { $('resource-copy').textContent = '复制失败'; }
});
for (const type of ['dragenter', 'dragover']) $('resources-view').addEventListener(type, event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); $('resources-view').classList.add('resource-dragging'); } });
$('resources-view').addEventListener('dragleave', event => { if (!$('resources-view').contains(event.relatedTarget)) $('resources-view').classList.remove('resource-dragging'); });
$('resources-view').addEventListener('drop', event => { event.preventDefault(); $('resources-view').classList.remove('resource-dragging'); if (event.dataTransfer?.files.length) void uploadResources([...event.dataTransfer.files]); });
$('list-toggle').addEventListener('click', () => document.querySelector('.workspace').classList.toggle('list-open'));
$('agent-chat').addEventListener('click', () => { newChat(); selectAgent(state.detailAgent); $('topic').focus(); });
$('agent-delete').addEventListener('click', async () => {
  const id = state.detailAgent;
  if (!id || !confirm('删除「' + detailProfile(id).name + '」？已有对话会保留，引用它的工作流节点需要改选。')) return;
  const remove = $('agent-delete');
  remove.disabled = true;
  errorMessage();
  try {
    await jsonApi('/api/agents/' + id, undefined, { method: 'DELETE' });
    await refreshAgentCatalog();
  } catch (error) { errorMessage(error.message); }
  finally { remove.disabled = false; }
});
$('settings-btn').addEventListener('click', () => { $('settings-dialog').showModal(); });
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('connect-btn').addEventListener('click', connect); $('api-key').addEventListener('keydown', event => { if (event.key === 'Enter') void connect(); });
$('api-key').addEventListener('input', () => { connectionVersion++; halt('settings'); state.connected = false; $('connect-btn').disabled = false; $('connection-status').textContent = '未连接'; status(); });
$('model').addEventListener('change', () => { halt('settings'); state.current = null; });
$('settings-agent').addEventListener('change', () => selectAgent($('settings-agent').value));
$('web-search').addEventListener('change', () => { halt('settings'); state.current = null; resetResearch(state.topic); persistSetting(`taotao-web-search-${state.agent}`, $('web-search').checked); });
$('reply-voice').addEventListener('change', () => { halt('settings'); if (state.current) prepareCard(state.current); persistSetting('taotao-reply-voice', $('reply-voice').checked); });
$('remember-history').addEventListener('change', () => { halt('memory_settings'); state.keepMemory = $('remember-history').checked; persistSetting('taotao-memory-enabled', state.keepMemory); try { localStorage.removeItem('taotao-memory-v1'); } catch {} newChat(); });
$('voice').addEventListener('change', () => { state.voiceChosen = true; });
$('rate').addEventListener('input', () => { $('rate-value').textContent = `${Number($('rate').value).toFixed(1)}×`; });
$('test-voice').addEventListener('click', async () => { halt('voice_test'); if (!synth || !window.SpeechSynthesisUtterance) { errorMessage('浏览器不支持朗读'); return; } state.active = true; const epoch = ++state.epoch; status('试听中', 'speaking'); try { await speak('你好，我是滔滔。', epoch); } catch (error) { if (isCurrent(epoch)) errorMessage(error.message); } finally { if (isCurrent(epoch)) halt('voice_test', false); } });
$('knowledge-permission').addEventListener('change', async () => { const enabled = $('knowledge-permission').checked; $('knowledge-permission').disabled = true; try { await jsonApi('/api/knowledge/permission', { enabled }); state.permission = enabled; if (state.view === 'agents') showAgent(state.detailAgent); } catch (error) { $('knowledge-permission').checked = state.permission; $('memory-status').textContent = error.message; errorMessage(error.message); } finally { $('knowledge-permission').disabled = false; } });
$('open-memory').addEventListener('click', () => { $('settings-dialog').close(); setView('library'); void refreshMemory().catch(error => errorMessage(error.message)); });
$('backup-memory').addEventListener('click', async () => { try { await memoryApi('backup', {}); $('memory-status').textContent = '已备份'; } catch (error) { errorMessage(error.message); } });
$('clear-memory').addEventListener('click', async () => { try { await memoryApi('event', { id: crypto.randomUUID(), type: 'clear_preferences', payload: {}, interests: [] }); $('memory-status').textContent = '已清除'; } catch (error) { errorMessage(error.message); } });
$('note-back').addEventListener('click', noteBack);
$('note-raw-toggle').addEventListener('click', () => { const raw = !$('knowledge-raw').hidden; $('knowledge-raw').hidden = raw; $('knowledge-content').hidden = !raw; $('note-raw-toggle').textContent = raw ? '原文' : '阅读'; });
$('note-forget').addEventListener('click', async () => { const page = state.snapshot.pages.find(p => p.path === state.notePath); if (!page || !confirm('忘记这篇笔记及相关记忆？')) return; halt('forget'); try { await memoryApi('forget-page', { id: page.id }); state.messages = []; state.current = null; state.replyPending = false; state.notePath = ''; state.noteVersion++; await refreshMemory(); setView('library'); } catch (error) { errorMessage(error.message); } });
$('chat-menu').addEventListener('click', () => $('chat-actions-dialog').showModal()); $('chat-actions-close').addEventListener('click', () => $('chat-actions-dialog').close());
$('view-chat-raw').addEventListener('click', () => { $('chat-actions-dialog').close(); void showNote(`raw/对话/${state.sessionId}.md`); });
$('delete-session').addEventListener('click', async () => {
  const session = state.snapshot.sessions.find(item => item.id === state.sessionId);
  if (!session || !confirm('删除对话「' + session.title + '」及相关记忆？')) return;
  const button = $('delete-session');
  button.disabled = true;
  halt('delete');
  try {
    await memoryApi('delete-session', { id: session.id });
    state.snapshot.sessions = state.snapshot.sessions.filter(item => item.id !== session.id);
    if (session.id === state.sessionId) newChat();
    else renderLists();
    await refreshMemory();
  } catch (error) { errorMessage(error.message); }
  finally { button.disabled = false; }
});
window.addEventListener('pagehide', () => { halt('leave'); stopExtraction(); });
let checkingService = false;
setInterval(async () => {
  // The administrator stream already sends heartbeats and reports disconnects.
  if (!state.active || !state.participants.length && state.agent === 'librarian' || checkingService) return; checkingService = true; const epoch = state.epoch;
  try { const response = await fetch('/health', { signal: AbortSignal.timeout(1500) }); if (!response.ok || (await response.json()).app !== 'taotao-local') throw new Error(); }
  catch { if (isCurrent(epoch)) { halt('server_closed'); state.connected = false; $('connection-status').textContent = '已关闭'; status('已关闭'); } }
  finally { checkingService = false; }
}, 1000);

try { const selected = localStorage.getItem('taotao-agent'); if (Object.hasOwn(AGENTS, selected)) state.agent = selected; state.keepMemory = localStorage.getItem('taotao-memory-enabled') !== 'false'; $('reply-voice').checked = localStorage.getItem('taotao-reply-voice') === 'true'; } catch {}
$('remember-history').checked = state.keepMemory;
$('settings-agent').replaceChildren(...state.agents.map(item => new Option(item.name, item.id)));
selectAgent(state.agent, false); populateVoices(); renderLists(); if (synth) synth.addEventListener('voiceschanged', populateVoices);
const memoryInitialization = (async () => {
  try {
    if (state.keepMemory) {
      let old; try { old = JSON.parse(localStorage.getItem('taotao-memory-v1') || 'null'); } catch {}
      if (old) { await memoryApi('migrate', { events: old.events || [], interests: old.interests || [] }); try { localStorage.removeItem('taotao-memory-v1'); } catch {} }
    }
    await refreshMemory();
  } catch (error) { $('memory-status').textContent = error.message; }
})();
const initialResource = resourceReference(location.href);
if (initialResource) void showResource(initialResource.id, initialResource);
else if (location.hash === '#workflow') setView('workflow');
else void workflowEditor.refreshCatalog().then(renderDiscussion).catch(() => {});
void refreshAgentCatalog().catch(() => {});
