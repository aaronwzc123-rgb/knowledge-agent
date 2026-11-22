import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('.', import.meta.url));
const vendor = join(root, 'vendor', 'harness2', 'harness2', 'core', 'schedule.py');
const worker = join(root, 'harness2-worker.py');
const phases = { base: '运行基准回答', propose: '提出提示词改动', probe: '试跑候选提示词',
  compose: '组合有依据的改动', final: '试跑组合后的提示词', reflect: '比较回答并提炼可复用经验' };
const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const exec = promisify(execFile);
let interpreter;

async function findPython() {
  const override = process.env.TAOTAO_HARNESS_PYTHON;
  let programs = override ? [override] : ['python3.12', 'python3.13', 'python3'];
  if (!override && process.platform === 'win32') {
    const { stdout } = await exec('py', ['-0p'], { windowsHide: true, timeout: 3000 }).catch(() => ({ stdout: '' }));
    programs = stdout.split(/\r?\n/).flatMap(line => {
      const match = line.match(/^\s*-\S*3\.(?:12|13)(?:[.\[]\S*)?\s+\*?\s*(.+\.exe)\s*$/i);
      return match ? [match[1]] : [];
    }).concat('python.exe');
  }
  for (const program of programs) {
    const { stdout } = await exec(program, ['--version'], { windowsHide: true, timeout: 3000 }).catch(() => ({ stdout: '' }));
    if (/^Python 3\.(12|13)\./.test(stdout.trim())) return program;
  }
  throw failure('Harness² 需要 Python 3.12 或 3.13。可以设置 TAOTAO_HARNESS_PYTHON 指向解释器。', 503);
}

async function recentExperience(path) {
  if (!path) return [];
  const files = await readdir(path).catch(err => { if (err.code === 'ENOENT') return []; throw err; });
  return Promise.all(files.filter(name => /^\d{13}-[a-f\d-]{36}\.json$/.test(name)).sort().slice(-5).map(async name => {
    const { prompt, experience } = JSON.parse(await readFile(join(path, name), 'utf8'));
    return { id: name.slice(0, -5), prompt, experience };
  }));
}

export async function runHarness2({ guidance, messages, pages, library, signal, activity, modelCall }) {
  if (!existsSync(vendor)) throw failure('找不到 Google Harness² 源码。请按 README 安装到 vendor/harness2。', 503);
  let workspace, temporaryRoot, child, exited;
  const stop = () => { if (child?.exitCode === null && child.signalCode === null) child.kill(); };
  try {
    interpreter ??= findPython().catch(err => { interpreter = undefined; throw err; });
    const python = await interpreter;
    signal.throwIfAborted();
    temporaryRoot = await realpath(tmpdir());
    workspace = await mkdtemp(join(temporaryRoot, 'taotao-harness2-'));
    const prior = await recentExperience(library);
    signal.throwIfAborted();
    child = spawn(python, ['-I', '-B', '-X', 'utf8', worker], {
      cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    exited = new Promise(resolve => {
      child.once('error', err => resolve({ err }));
      child.once('close', code => resolve({ code }));
    });
    child.stdin.on('error', () => {});
    const write = data => new Promise((resolve, reject) => {
      child.stdin.write(JSON.stringify(data) + '\n', err => err ? reject(err) : resolve());
    });
    signal.addEventListener('abort', stop, { once: true });
    const wiki = pages.slice(0, 4).map(({ path, content }, i) => ({ number: i + 1, path, content: content.slice(0, 3200) }));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const taskId = randomUUID();
    await write({ workspace, prior, taskId,
      guidance, messages, wiki });
    let result, modelError;
    for await (const line of lines) {
      signal.throwIfAborted();
      const event = JSON.parse(line);
      if (typeof event.answer === 'string' && event.answer) { result = event; continue; }
      if (!Object.hasOwn(phases, event.phase)) throw failure('Harness² 试跑返回了无效阶段。');
      const step = await activity.start(event.phase === 'reflect' ? 'review' : 'model', phases[event.phase]);
      let reply;
      try {
        reply = { result: await modelCall(event.system, event.data, event.phase) };
      } catch (err) {
        signal.throwIfAborted();
        modelError = err;
        reply = { error: 'Model call did not produce a usable response.' };
      }
      if (reply.error) await activity.update(step, { state: 'failed', detail: '模型调用未完成' });
      else await activity.finish(step);
      await write(reply);
    }
    const { code } = await exited;
    signal.throwIfAborted();
    if (code !== 0 || !result) throw modelError || failure('Harness² 试跑未完成，请检查本地源码和 Python 环境。');
    let retained = false, degraded = result.degraded;
    if (library && result.learned) {
      const entry = join(library, Date.now() + '-' + taskId);
      try {
        await mkdir(library, { recursive: true });
        await writeFile(entry + '.tmp', JSON.stringify(result.learned), { flag: 'wx' });
        signal.throwIfAborted();
        await rename(entry + '.tmp', entry + '.json');
        retained = true;
      } catch {
        signal.throwIfAborted();
        degraded = true;
      } finally {
        await rm(entry + '.tmp', { force: true }).catch(() => {});
      }
    }
    const citations = [...new Set([...result.answer.matchAll(/〔Wiki (\d{1,6})〕/g)].map(match => Number(match[1])))];
    const links = citations.flatMap(number => {
      const path = wiki[number - 1]?.path;
      return path && !/[\[\]|#\n\r]/.test(path) ? [number + '. [[' + path + ']]'] : [];
    });
    const answer = result.answer.replace(/〔Wiki (\d{1,6})〕/g, '[$1]');
    const text = [answer, links.length ? '**Wiki 引用**\n\n' + links.join('\n') : ''].filter(Boolean).join('\n\n');
    return { text, improved: result.improved, retained, degraded };
  } catch (err) {
    signal.throwIfAborted();
    if (err.status) throw err;
    throw failure('Harness² 本地运行进程中断，请检查 Python 和上游源码。');
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
    await exited;
    if (workspace && dirname(workspace) === temporaryRoot && basename(workspace).startsWith('taotao-harness2-')) {
      await rm(workspace, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
    }
  }
}
