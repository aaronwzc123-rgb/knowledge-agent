import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(fileURLToPath(import.meta.url));
const url = 'http://127.0.0.1:8765/health';
async function health() {
  try { return await (await fetch(url, { signal: AbortSignal.timeout(300) })).json(); }
  catch { return null; }
}
async function waitForHealth() {
  for (let i = 0; i < 40; i++) { const value = await health(); if (value) return value; await delay(100); }
  throw new Error('Fixture did not start');
}
function running(id) {
  try { process.kill(id, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('BAT starts and stops, reuses the service, finds bundled Node, and protects unrelated processes', async () => {
  assert.equal(await health(), null, 'Port 8765 must be free before this check');
  const base = await mkdtemp(join(tmpdir(), 'taotao-launchers-'));
  const fixture = join(base, '中文 launcher folder');
  let serviceId;
  let other;
  try {
    await mkdir(fixture);
    for (const file of ['启动滔滔不绝.bat', '关闭滔滔不绝.bat']) await copyFile(join(root, file), join(fixture, file));
    const launcher = (await readFile(join(root, 'launcher.mjs'), 'utf8'))
      .replace(/    execFileSync\('powershell\.exe'.*Start-Process[^\n]*\n/, '    // Browser opening is suppressed only in this isolated fixture.\n');
    await writeFile(join(fixture, 'launcher.mjs'), launcher);
    const fake = `import {createServer} from 'node:http'; createServer((req,res)=>res.end(JSON.stringify({app:'taotao-local',pid:process.pid}))).listen(8765,'127.0.0.1');`;
    await writeFile(join(fixture, 'server.mjs'), fake);
    const runBat = (name, noNodeOnPath = false) => {
      const env = { ...process.env, TAOTAO_TEST_BAT: join(fixture, name) };
      if (noNodeOnPath) {
        for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
        env.Path = `${process.env.SystemRoot}\\system32;${process.env.SystemRoot};${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`;
      }
      return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& $env:TAOTAO_TEST_BAT; exit $LASTEXITCODE'],
        { env, encoding: 'utf8', input: '', windowsHide: true, timeout: 30000 });
    };
    const started = runBat('启动滔滔不绝.bat', true);
    assert.equal(started.status, 0, started.stdout + started.stderr);
    serviceId = (await waitForHealth()).pid;
    const repeated = runBat('启动滔滔不绝.bat');
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    assert.equal((await health()).pid, serviceId, 'repeated start reuses the same process');
    const stopped = runBat('关闭滔滔不绝.bat');
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.equal(running(serviceId), false);
    assert.equal(await health(), null);
    assert.equal(runBat('关闭滔滔不绝.bat').status, 0, 'repeated stop succeeds');

    await writeFile(join(fixture, 'other-server.mjs'), fake);
    other = spawn(process.execPath, [join(fixture, 'other-server.mjs')], { windowsHide: true, stdio: 'ignore' });
    await waitForHealth();
    const rejected = spawnSync(process.execPath, [join(fixture, 'launcher.mjs'), 'stop'], { encoding: 'utf8', windowsHide: true });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /不属于/);
    assert.equal((await health()).pid, other.pid, 'unrelated process remains running');
  } finally {
    if (other?.pid && running(other.pid)) other.kill();
    if (serviceId && running(serviceId)) process.kill(serviceId);
    if (other?.pid) for (let i = 0; i < 30 && running(other.pid); i++) await delay(100);
    const target = resolve(base);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('taotao-launchers-'));
    await rm(target, { recursive: true, force: true });
  }
});
