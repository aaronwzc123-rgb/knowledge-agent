import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { dirname, join, basename, isAbsolute, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(fileURLToPath(import.meta.url));
const serverFile = join(root, 'server.mjs');
const appURL = 'http://127.0.0.1:8765';

// server.mjs 依赖 node:sqlite（Node 22 起内置），旧版 Node 会报一堆看不懂的模块错误。
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`需要 Node.js 22 或更新版本，当前是 ${process.versions.node}。请安装新版 Node.js 后重试。`);
  process.exit(1);
}

async function isReady() {
  try {
    const response = await fetch(`${appURL}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).app === 'taotao-local';
  } catch { return false; }
}

async function start() {
  if (await isReady()) {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${appURL}'`], { windowsHide: true });
    return;
  }
  const output = openSync(join(root, 'local-server.log'), 'w');
  const errors = openSync(join(root, 'local-server-error.log'), 'w');
  let child;
  try {
    child = spawn(process.execPath, [serverFile, '--open'], {
      cwd: root, env: { ...process.env, PORT: '8765' }, detached: true,
      windowsHide: true, stdio: ['ignore', output, errors],
    });
  } finally { closeSync(output); closeSync(errors); }
  let startError;
  child.on('error', error => { startError = error; });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await isReady()) return;
    if (startError || child.exitCode !== null) break;
    await delay(200);
  }
  if (child.pid && child.exitCode === null) child.kill();
  throw new Error('滔滔不绝未能启动，请查看本目录的 local-server-error.log。');
}

async function stop() {
  const query = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);
    $ErrorActionPreference = 'Stop';
    $ids = @(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique);
    @($ids | ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId = $_" }) |
      Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { windowsHide: true, encoding: 'utf8' }).trim();
  const result = output ? JSON.parse(output) : [];
  const owners = Array.isArray(result) ? result : [result];
  if (!owners.length) { console.log('滔滔不绝本来就没有在运行。'); return; }
  for (const owner of owners) {
    const args = [...String(owner.CommandLine).matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]);
    if (basename(owner.ExecutablePath || '').toLowerCase() !== 'node.exe' || !args[1] || !isAbsolute(args[1])
      || normalize(args[1]).toLowerCase() !== serverFile.toLowerCase()) {
      throw new Error('端口 8765 上的程序不属于这个目录中的滔滔不绝。');
    }
    try { process.kill(owner.ProcessId); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(owner.ProcessId, 0); }
      catch (error) { if (error.code === 'ESRCH') break; throw error; }
      if (attempt === 49) throw new Error('服务还未退出，请稍后再试。');
      await delay(100);
    }
  }
  console.log('滔滔不绝已关闭。');
}

try {
  if (process.argv[2] === 'start') await start();
  else if (process.argv[2] === 'stop') await stop();
  else throw new Error('请双击启动或关闭滔滔不绝的 BAT 文件。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
