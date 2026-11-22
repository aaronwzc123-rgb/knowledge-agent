import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('./vendor/harness2/', import.meta.url));
const distro = process.env.TAOTAO_HARNESS2_WSL_DISTRO || 'Ubuntu-24.04';
const commands = {
  'harness2-demo': '本地演示',
  'harness2': '运行基准任务',
  'harness2-setup': '安装基准与执行器',
  'harness2-check': '检查环境',
  'harness2-judge': '运行评测',
  'harness2-report': '生成报告',
  'harness2-bridge': '启动模型桥接',
  'split_tasks.py': '划分任务集',
};
const modules = {
  'harness2-demo': 'demo', harness2: 'run_sweep', 'harness2-setup': 'setup',
  'harness2-check': 'check', 'harness2-judge': 'judge', 'harness2-report': 'report',
  'harness2-bridge': 'bridge',
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function upstreamHarness2Info() {
  const available = existsSync(resolve(repository, 'pyproject.toml'));
  const ready = available && (Boolean(process.env.TAOTAO_HARNESS2_VENV)
    || existsSync(resolve(repository, '.venv/pyvenv.cfg')));
  return { available, ready, commands, platform: process.platform, distro };
}

export function upstreamHarness2Arguments(body) {
  const { command, args } = body;
  if (typeof command !== 'string' || !Object.hasOwn(commands, command) || !Array.isArray(args) || args.length > 200
    || args.some(arg => typeof arg !== 'string' || arg.length > 12000 || arg.includes('\0'))) {
    throw fail('请选择原版命令并逐行填写参数。');
  }
  const venv = (process.env.TAOTAO_HARNESS2_VENV || '.venv').replace(/\/+$/, '');
  const bin = venv + '/bin/';
  const module = command === 'split_tasks.py' ? 'scripts.split_tasks' : 'harness2.cli.' + modules[command];
  const invoke = [bin + 'python', '-u', '-m', module];
  const python = [bin + 'python', '-u', '../../harness2-upstream-launch.py', ...invoke, ...args];
  if (process.platform !== 'win32') return { file: python[0], args: python.slice(1) };
  const user = process.env.TAOTAO_HARNESS2_WSL_USER;
  return { file: 'wsl.exe', args: ['--distribution', distro, ...(user ? ['--user', user] : []),
    '--cd', repository.replaceAll('\\', '/'), '--exec', '/usr/bin/env', 'PYTHONUNBUFFERED=1', ...python] };
}

export function streamUpstreamHarness2(body, res) {
  const command = upstreamHarness2Arguments(body);
  const availability = upstreamHarness2Info();
  if (!availability.available) throw fail('找不到 Google Harness² 源码。', 503);
  if (!availability.ready) throw fail('原版 Linux 环境尚未安装。请按页面链接的官方安装说明在源码目录创建 .venv。', 503);
  const child = spawn(command.file, command.args, {
    cwd: repository, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1', WSL_UTF8: '1' },
  });
  const streams = [child.stdout, child.stderr];
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = data => {
    if (res.destroyed || res.writableEnded) return false;
    return res.write(JSON.stringify(data) + '\n');
  };
  for (const stream of streams) {
    stream.setEncoding('utf8');
    stream.on('data', output => {
      if (!send({ output: output.replace(/\0/g, '') })) streams.forEach(input => input.pause());
    });
  }
  res.on('drain', () => streams.forEach(stream => stream.resume()));
  child.stdin.on('error', () => {});
  res.on('close', () => {
    streams.forEach(stream => stream.resume());
    child.stdin.end();
  });
  const heartbeat = setInterval(() => send({ heartbeat: true }), 10000);
  heartbeat.unref();
  return new Promise(resolve => {
    child.on('error', err => {
      send({ output: err.code === 'ENOENT' ? '找不到 Linux 启动器或 Python 环境。\n' : '原版命令未能启动。\n' });
    });
    child.on('close', code => {
      clearInterval(heartbeat);
      send({ exitCode: code ?? 1 });
      if (!res.destroyed) res.end();
      resolve();
    });
  });
}
