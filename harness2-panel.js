const defaults = {
  'harness2-demo': ['--output', 'runs/demo', '--k', '2'],
  'harness2': ['--bench', 'lab', '--k', '1', '--mode', 'parallel', '--max-tasks', '1'],
  'harness2-setup': ['lab', '--dry-run'],
  'harness2-check': ['--bench', 'lab'],
  'harness2-judge': ['--bench', 'lab', '--k', '1', '--mode', 'parallel'],
  'harness2-report': ['--bench', 'lab', '--k', '1', '--mode', 'parallel'],
  'harness2-bridge': [],
  'split_tasks.py': ['--help'],
};
const endpoint = '/api/harness2-upstream';
const panels = new WeakMap();

export function mountUpstreamHarness2(panel) {
  if (panels.has(panel)) {
    panels.get(panel).refresh();
    return;
  }
  const get = name => panel.querySelector('#harness2-' + name);
  const command = get('command'), args = get('args'), run = get('run'), help = get('help');
  const stop = get('stop'), status = get('status'), output = get('output');
  const drafts = new Map();
  let controller, ready = false, loading = false;
  const buttons = () => {
    run.disabled = help.disabled = !ready || Boolean(controller);
    command.disabled = loading || Boolean(controller);
    stop.disabled = !controller;
  };
  const refresh = async () => {
    if (controller || loading || ready) return;
    loading = true; buttons();
    try {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error('无法读取 Harness² 本地环境。');
      const state = await response.json();
      ready = state.ready;
      const selected = command.value;
      command.replaceChildren(...Object.entries(state.commands).map(([id, name]) => new Option(id + ' · ' + name, id)));
      if (Object.hasOwn(state.commands, selected)) command.value = selected;
      args.value = drafts.get(command.value) ?? defaults[command.value]?.join('\n') ?? '';
      status.textContent = !state.available ? '找不到上游源码'
        : !ready ? '请按官方说明安装 Linux Python 环境' : '原版环境就绪';
    } catch (error) {
      status.textContent = error.message;
    } finally { loading = false; buttons(); }
  };
  panels.set(panel, { refresh });
  command.addEventListener('change', () => { args.value = drafts.get(command.value) ?? defaults[command.value]?.join('\n') ?? ''; });
  args.addEventListener('input', () => drafts.set(command.value, args.value));
  async function execute(parameters) {
    if (!ready || controller) return;
    controller = new AbortController();
    buttons(); output.replaceChildren(); output.hidden = false;
    status.textContent = '原版命令运行中';
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command.value, args: parameters }), signal: controller.signal,
      });
      if (!response.ok) throw new Error((await response.json()).error || '原版命令启动失败。');
      let remaining = '', exitCode;
      const text = document.createTextNode('');
      output.append(text);
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        remaining += chunk;
        let end;
        while ((end = remaining.indexOf('\n')) >= 0) {
          const event = JSON.parse(remaining.slice(0, end));
          remaining = remaining.slice(end + 1);
          if (typeof event.output === 'string') {
            const follow = output.scrollHeight - output.clientHeight - output.scrollTop < 70;
            text.data = (text.data + event.output).slice(-512000);
            if (follow) output.scrollTop = output.scrollHeight;
          }
          if (Number.isInteger(event.exitCode)) exitCode = event.exitCode;
        }
      }
      status.textContent = exitCode === 0 ? '已完成' : exitCode === undefined ? '命令连接中断' : '命令退出，状态码 ' + exitCode;
    } catch (error) {
      status.textContent = controller.signal.aborted ? '已发出停止信号' : error.message;
    } finally { controller = null; buttons(); }
  }
  get('upstream-form').addEventListener('submit', event => {
    event.preventDefault();
    void execute(args.value.split(/\r?\n/u).filter(value => value.length));
  });
  help.addEventListener('click', () => { void execute(['--help']); });
  stop.addEventListener('click', () => controller?.abort());
  void refresh();
}
