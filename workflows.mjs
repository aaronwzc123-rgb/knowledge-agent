import { randomUUID } from 'node:crypto';
import { NODE_TYPES, CONDITIONS, TEMPLATES, edgePorts, newWorkflow, outputKeys } from './workflow-schema.mjs';
import { getAgent } from './agents.mjs';

const error = (status, message) => Object.assign(new Error(message), { status });
const identifier = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/u;
const reference = /^[a-zA-Z][a-zA-Z0-9_]{0,31}\.[a-zA-Z][a-zA-Z0-9_]{0,31}$/u;
const placeholders = /\{\{\s*([^{}]+?)\s*\}\}/gu;
const modelName = /^[a-zA-Z0-9_.:-]{1,80}$/u;
const field = (value, max, label, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw error(400, label + '格式不正确。');
  }
  return value;
};
const list = (items, max, label) => {
  if (!Array.isArray(items) || items.length > max) throw error(400, label + '格式不正确。');
  return items;
};
function namedFields(value, read) {
  const fields = list(value, 12, '变量').map(item => {
    if (typeof item?.name !== 'string' || !identifier.test(item.name)) throw error(400, '变量名须以英文字母开头，只能包含英文字母、数字和下划线。');
    return { name: item.name, ...read(item) };
  });
  if (new Set(fields.map(item => item.name)).size !== fields.length) throw error(400, '同一节点的变量名不能重复。');
  return fields;
}
function variable(value) {
  if (value !== '' && (typeof value !== 'string' || !reference.test(value))) throw error(400, '请选择有效的上游变量。');
  return value;
}
function configFor(type, config) {
  if (!config || typeof config !== 'object') throw error(400, '缺少节点配置。');
  switch (type) {
    case 'start': return { fields: namedFields(config.fields, item => {
      if (!['text', 'paragraph'].includes(item.type) || typeof item.required !== 'boolean') throw error(400, '输入字段类型不正确。');
      return { label: field(item.label, 80, '字段名称', true), type: item.type, required: item.required };
    }) };
    case 'condition':
      if (!Object.hasOwn(CONDITIONS, config.operator)) throw error(400, '条件操作不正确。');
      return { variable: variable(config.variable), operator: config.operator, value: field(config.value, 1000, '条件值') };
    case 'wiki':
      if (!['wiki', 'example'].includes(config.source)) throw error(400, '无法识别知识来源。');
      return { query: variable(config.query), source: config.source };
    case 'llm':
      if (config.model !== '' && (typeof config.model !== 'string' || !modelName.test(config.model))) throw error(400, '模型名称不正确。');
      return { model: config.model, system: field(config.system, 9000, '系统提示词'), prompt: field(config.prompt, 12000, '用户提示词') };
    case 'agent':
      if (typeof config.agent !== 'string' || typeof config.remember !== 'boolean') throw error(400, 'Agent 节点格式不正确。');
      if (config.agent) getAgent(config.agent);
      return { agent: config.agent, prompt: field(config.prompt, 12000, 'Agent 任务'), remember: config.remember };
    case 'aggregate': return { variables: list(config.variables, 12, '聚合变量').map(variable) };
    case 'output': return { fields: namedFields(config.fields, item => ({ variable: variable(item.variable) })) };
  }
}

function cleanDefinition(value) {
  const name = field(value?.name, 100, '工作流名称', true).trim();
  const nodes = list(value.nodes, 36, '节点').map(node => {
    if (typeof node?.id !== 'string' || !identifier.test(node.id) || !Object.hasOwn(NODE_TYPES, node.type)
      || ![node.x, node.y].every(n => Number.isFinite(n) && Math.abs(n) <= 12000)) throw error(400, '节点格式不正确。');
    return { id: node.id, type: node.type, title: field(node.title, 80, '节点名称', true).trim(),
      x: Math.round(node.x), y: Math.round(node.y), config: configFor(node.type, node.config) };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length || ['start', 'output'].some(type => nodes.filter(node => node.type === type).length !== 1)) {
    throw error(400, '工作流必须有一个开始节点、一个输出节点及不同的节点编号。');
  }
  const edges = list(value.edges, 100, '连线').map(edge => {
    const source = byId.get(edge?.from), target = byId.get(edge?.to);
    if (!source || !target || source === target || target.type === 'start' || !edgePorts(source.type).includes(edge.port)) {
      throw error(400, '连线端点不正确。');
    }
    return { from: edge.from, to: edge.to, port: edge.port };
  });
  if (new Set(edges.map(edge => JSON.stringify(edge))).size !== edges.length) throw error(400, '连线重复。');
  return { name, nodes, edges };
}

function compile(flow) {
  const byId = new Map(flow.nodes.map(node => [node.id, node]));
  const start = flow.nodes.find(node => node.type === 'start');
  const output = flow.nodes.find(node => node.type === 'output');
  const incoming = new Map(flow.nodes.map(node => [node.id, []]));
  const outgoing = new Map(flow.nodes.map(node => [node.id, []]));
  for (const edge of flow.edges) {
    incoming.get(edge.to).push(edge);
    outgoing.get(edge.from).push(edge);
  }
  const queue = [start], sorted = [];
  const degree = new Map(flow.nodes.map(node => [node.id, incoming.get(node.id).length]));
  for (const node of queue) {
    sorted.push(node);
    for (const edge of outgoing.get(node.id)) {
      const left = degree.get(edge.to) - 1;
      degree.set(edge.to, left);
      if (!left) queue.push(byId.get(edge.to));
    }
  }
  if (sorted.length !== flow.nodes.length) throw error(400, '有节点没有接到开始节点，或连线形成了循环。');
  const ancestors = new Map();
  for (const node of sorted) {
    const parents = incoming.get(node.id).map(edge => edge.from);
    const prior = new Set(parents.flatMap(id => [id, ...ancestors.get(id)]));
    ancestors.set(node.id, prior);
    if (node.type !== 'output' && !outgoing.get(node.id).length) throw error(400, node.title + '未接到输出。');
    const { config } = node;
    let refs = [];
    if (node.type === 'condition') {
      refs = [config.variable];
      if (edgePorts(node.type).some(port => !outgoing.get(node.id).some(edge => edge.port === port))) {
        throw error(400, node.title + '需要连接 IF 和 ELSE 两条分支。');
      }
    }
    if (node.type === 'wiki') refs = [config.query];
    if (node.type === 'llm') {
      if (!config.system.trim() && !config.prompt.trim()) throw error(400, node.title + '需要填写提示词。');
      refs = [...(config.system + '\n' + config.prompt).matchAll(placeholders)].map(match => match[1]);
    }
    if (node.type === 'agent') {
      if (!config.agent || !config.prompt.trim()) throw error(400, node.title + '需要选择 Agent 并填写任务。');
      refs = [...config.prompt.matchAll(placeholders)].map(match => match[1]);
    }
    if (node.type === 'aggregate') refs = config.variables;
    if (node.type === 'output') refs = config.fields.map(item => item.variable);
    if (['aggregate', 'output'].includes(node.type) && !refs.length) throw error(400, node.title + '需要配置变量。');
    for (const ref of refs) {
      const [owner, key] = ref.split('.');
      if (!reference.test(ref) || !prior.has(owner) || !outputKeys(byId.get(owner)).includes(key)) {
        throw error(400, node.title + '引用了未连接或已删除的变量：' + (ref || '请先选择变量'));
      }
    }
  }
  return { start, output, sorted, incoming };
}

const asText = value => typeof value === 'string' ? value : JSON.stringify(value);
const exampleNote = {
  path: '模板示例资料 / Dify 简介',
  content: 'Dify 是用于搭建生成式 AI 应用的平台。它提供可视化工作流，支持组合模型、知识检索和工具节点，用于知识问答、内容生成和业务流程辅助。可通过配置知识库为回答提供参考资料。',
  url: 'https://docs.dify.ai/',
};

export class WorkflowStore {
  constructor(memory) {
    this.memory = memory;
    this.db = memory.db;
    this.db.exec("CREATE TABLE IF NOT EXISTS workflow_definitions(id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, graph TEXT NOT NULL, updated TEXT NOT NULL);"
      + "CREATE TABLE IF NOT EXISTS workflow_executions(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id), revision INTEGER NOT NULL,"
      + " status TEXT NOT NULL, started TEXT NOT NULL, finished TEXT, result TEXT NOT NULL);"
      + "CREATE INDEX IF NOT EXISTS workflow_execution_history ON workflow_executions(workflow_id, started DESC);"
      + "UPDATE workflow_executions SET status='stopped',finished=coalesce(finished,datetime('now')) WHERE status='running';");
    if (!this.db.prepare('PRAGMA table_info(workflow_definitions)').all().some(column => column.name === 'deleted')) {
      this.db.exec('ALTER TABLE workflow_definitions ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
    }
    if (!this.db.prepare('SELECT 1 FROM workflow_definitions LIMIT 1').get()) this.create('email');
  }
  list() {
    return this.db.prepare('SELECT id,name,revision,updated FROM workflow_definitions WHERE deleted=0 ORDER BY updated DESC').all();
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM workflow_definitions WHERE id=?').get(id);
    if (!row) throw error(404, '找不到这个工作流。');
    const { graph, ...rest } = row;
    return { ...rest, deleted: Boolean(rest.deleted), ...JSON.parse(graph) };
  }
  available(id) {
    const flow = this.get(id);
    if (flow.deleted) throw error(410, '这个工作流已删除，可以查看历史运行。');
    return flow;
  }
  create(template) {
    if (typeof template !== 'string' || !Object.hasOwn(TEMPLATES, template)) throw error(400, '请选择工作流模板。');
    const { name, ...graph } = newWorkflow(template);
    const id = randomUUID();
    this.db.prepare('INSERT INTO workflow_definitions(id,name,revision,graph,updated) VALUES(?,?,1,?,?)')
      .run(id, name, JSON.stringify(graph), new Date().toISOString());
    return this.get(id);
  }
  save(id, value) {
    this.available(id);
    if (!Number.isSafeInteger(value?.revision)) throw error(400, '缺少工作流版本。');
    const { name, ...graph } = cleanDefinition(value);
    const changed = this.db.prepare('UPDATE workflow_definitions SET name=?,graph=?,updated=?,revision=revision+1 WHERE id=? AND revision=? AND deleted=0')
      .run(name, JSON.stringify(graph), new Date().toISOString(), id, value.revision);
    if (!changed.changes) throw error(409, '工作流已在另一个窗口更新。请重新打开后再编辑。');
    return this.get(id);
  }
  remove(id, revision) {
    const flow = this.get(id);
    if (flow.deleted) return { deleted: true };
    if (!Number.isSafeInteger(revision)) throw error(400, '缺少工作流版本。');
    const changed = this.db.prepare('UPDATE workflow_definitions SET deleted=1 WHERE id=? AND revision=? AND deleted=0').run(id, revision);
    if (!changed.changes) throw error(409, '工作流已在另一个窗口更新，请重新打开后再删除。');
    return { deleted: true };
  }
  history(id) {
    this.get(id);
    return this.db.prepare('SELECT id,revision,status,started,finished FROM workflow_executions WHERE workflow_id=? ORDER BY started DESC LIMIT 30').all(id);
  }
  execution(id, runId) {
    const row = this.db.prepare('SELECT * FROM workflow_executions WHERE workflow_id=? AND id=?').get(id, runId);
    if (!row) throw error(404, '找不到这次运行。');
    const { result, ...rest } = row;
    const run = { ...rest, ...JSON.parse(result) };
    if (run.status === 'stopped') for (const step of run.steps) {
      if (step.status === 'running') step.status = 'stopped';
    }
    return run;
  }
  async run(id, { revision, inputs, model }, { signal, emit, infer, runAgent }) {
    const flow = this.available(id);
    if (revision !== flow.revision) throw error(409, '请打开最新的工作流版本后运行。');
    const plan = compile(flow);
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw error(400, '请填写运行输入。');
    const initial = Object.fromEntries(plan.start.config.fields.map(item => [
      item.name, field(Object.hasOwn(inputs, item.name) ? inputs[item.name] : '', 6000, item.label, item.required),
    ]));
    signal.throwIfAborted();
    const run = { inputs: initial, steps: [], output: null, error: '', flow };
    const runId = randomUUID(), started = new Date().toISOString();
    this.db.prepare("INSERT INTO workflow_executions VALUES(?,?,?,'running',?,NULL,?)").run(runId, id, revision, started, JSON.stringify(run));
    const persist = (status = 'running', finished = null) =>
      this.db.prepare('UPDATE workflow_executions SET status=?,finished=?,result=? WHERE id=?').run(status, finished, JSON.stringify(run), runId);
    const results = new Map(), ports = new Map();
    const valueOf = ref => {
      const [node, key] = ref.split('.');
      const data = results.get(node);
      return data && Object.hasOwn(data, key) ? data[key] : undefined;
    };
    const requireValue = ref => {
      const value = valueOf(ref);
      if (value === undefined) throw error(422, '当前分支没有变量 ' + ref + '。');
      return value;
    };
    const expand = text => text.replace(placeholders, (_, ref) => asText(requireValue(ref)));
    let current;
    try {
      await emit({ id: runId, name: flow.name, started, status: 'running' });
      for (const node of plan.sorted) {
        signal.throwIfAborted();
        current = { id: node.id, status: 'running', started: Date.now(), input: null, output: null };
        run.steps.push(current);
        if (node !== plan.start && !plan.incoming.get(node.id).some(edge => ports.get(edge.from) === edge.port)) {
          current.status = 'skipped';
        } else {
          const { config } = node;
          let port = 'next';
          if (node.type === 'start') current.input = initial;
          if (node.type === 'condition') current.input = { value: asText(requireValue(config.variable)), operator: config.operator, expected: config.value };
          if (node.type === 'wiki') current.input = { query: asText(requireValue(config.query)), source: config.source };
          if (node.type === 'llm') current.input = { system: expand(config.system), prompt: expand(config.prompt), model: config.model || model };
          if (node.type === 'agent') current.input = { agent: config.agent, prompt: expand(config.prompt), remember: config.remember, model };
          if (node.type === 'aggregate') current.input = Object.fromEntries(config.variables.map(ref => [ref, valueOf(ref) ?? null]));
          if (node.type === 'output') current.input = Object.fromEntries(config.fields.map(item => [item.name, requireValue(item.variable)]));
          persist();
          await emit({ step: current });
          switch (node.type) {
            case 'start':
            case 'output':
              current.output = current.input;
              break;
            case 'condition': {
              const { value, expected } = current.input;
              const matched = {
                contains: value.includes(expected), not_contains: !value.includes(expected), equals: value === expected,
                not_equals: value !== expected, starts_with: value.startsWith(expected), ends_with: value.endsWith(expected),
                empty: !value.trim(), not_empty: Boolean(value.trim()),
              }[config.operator];
              port = matched ? 'yes' : 'no';
              current.output = { branch: matched ? 'IF' : 'ELSE' };
              break;
            }
            case 'wiki': {
              const { query, source } = current.input;
              const notes = source === 'example' ? (/\bdify\b/iu.test(query) ? [exampleNote] : [])
                : this.memory.recall(query).pages.map(({ path, content }) => ({ path, content }));
              current.output = { notes, context: notes.map(note => note.path + '\n' + note.content).join('\n\n') };
              break;
            }
            case 'llm':
              if ((current.input.system.length + current.input.prompt.length) > 52000) throw error(422, '模型输入过长，请缩短提示词或上游内容。');
              current.output = { text: await infer(current.input, signal) };
              break;
            case 'agent':
              if (current.input.prompt.length > 52000) throw error(422, 'Agent 输入过长，请缩短任务或上游内容。');
              current.output = { text: await runAgent(current.input, signal) };
              break;
            case 'aggregate': {
              const found = Object.values(current.input).find(value => value !== null);
              if (found === undefined) throw error(422, '没有可用的聚合变量，请检查运行的分支。');
              current.output = { value: found };
              break;
            }
          }
          signal.throwIfAborted();
          current.status = 'complete';
          results.set(node.id, current.output);
          ports.set(node.id, port);
        }
        current.elapsed = Date.now() - current.started;
        persist();
        await emit({ step: current });
      }
      run.output = results.get(plan.output.id);
      if (!run.output) throw error(422, '没有分支到达输出节点。');
      persist('complete', new Date().toISOString());
    } catch (failure) {
      const status = signal.aborted ? 'stopped' : 'failed';
      run.error = status === 'stopped' ? '' : failure.status ? failure.message : '工作流执行失败，请检查当前节点。';
      if (current?.status === 'running') {
        current.status = status;
        current.elapsed = Date.now() - current.started;
        current.error = run.error;
      }
      persist(status, new Date().toISOString());
      if (!signal.aborted) {
        if (current?.status === 'failed') await emit({ step: current });
        await emit({ status, error: run.error });
      }
      return;
    }
    if (!signal.aborted) await emit({ status: 'complete', output: run.output });
  }
}
