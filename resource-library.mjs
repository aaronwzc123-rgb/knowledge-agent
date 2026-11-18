import { DatabaseSync } from 'node:sqlite';
import { constants, createReadStream, createWriteStream, lstatSync, mkdirSync } from 'node:fs';
import { open, readdir, lstat, copyFile, unlink, mkdir, rename, chmod } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname, basename, extname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';

export const RESOURCE_UPLOAD_LIMIT = 200 * 1024 * 1024;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const now = () => new Date().toISOString();
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const imageTypes = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'], ['avif', 'image/avif'], ['bmp', 'image/bmp']]);
const textTypes = new Set(['txt', 'md', 'csv', 'log', 'json', 'xml', 'yaml', 'yml']);
const openTypes = new Set(['pdf', 'doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx', 'odp', 'xls', 'xlsx', 'ods', 'txt', 'md', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'heic', 'tif', 'tiff']);
const safeName = value => typeof value === 'string' && value.length <= 180 && value.trim() && value === value.trim()
  && !/[\\/:*?"<>|\x00-\x1f]/.test(value) && !/[. ]$/.test(value) && !['.', '..'].includes(value)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);

function launchLocalPath(path) {
  return new Promise((resolveLaunch, reject) => {
    const command = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const script = `Start-Process -FilePath '${path.replace(/'/g, "''")}'`;
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
      : [path];
    execFile(command, args, { windowsHide: true, timeout: 15000 }, error => error ? reject(Object.assign(new Error('无法打开，请检查系统默认应用。'), { status: 500 })) : resolveLaunch());
  });
}

function metadata(row) {
  const ext = extname(row.relative_path).slice(1).toLowerCase();
  const mime = ext === 'pdf' ? 'application/pdf' : imageTypes.get(ext) || (textTypes.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
  const fileUrl = `/api/resources/${row.id}/file?version=${row.version}`;
  return { id: row.id, name: basename(row.relative_path), relativePath: row.relative_path, ext, mime,
    size: row.size, modifiedAt: new Date(row.mtime_ms).toISOString(), importedAt: row.imported_at,
    sha256: row.sha256, version: row.version, status: row.status,
    reference: `resource:${row.id}`, fileUrl, downloadUrl: `${fileUrl}&download=1`,
    previewable: row.status === 'ready' && (ext === 'pdf' || imageTypes.has(ext) || textTypes.has(ext)),
    openable: row.status === 'ready' && openTypes.has(ext) };
}

export class ResourceLibrary {
  constructor(root, { openImpl = launchLocalPath } = {}) {
    this.root = resolve(root);
    this.folder = join(this.root, '资料库');
    this.uploadFolder = join(this.root, 'data', 'resource-uploads');
    this.snapshotFolder = join(this.root, 'data', 'resource-snapshots');
    this.openImpl = openImpl;
    for (const path of [this.folder, this.uploadFolder, this.snapshotFolder]) this.checkPath(this.root, path);
    mkdirSync(this.folder, { recursive: true });
    mkdirSync(this.uploadFolder, { recursive: true });
    mkdirSync(this.snapshotFolder, { recursive: true });
    this.checkPath(this.folder, this.folder);
    this.checkPath(join(this.root, 'data'), this.uploadFolder);
    this.checkPath(join(this.root, 'data'), this.snapshotFolder);
    this.db = new DatabaseSync(join(this.root, 'data', 'library.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS resources(
        id TEXT PRIMARY KEY, relative_path TEXT UNIQUE NOT NULL, sha256 TEXT NOT NULL,
        size INTEGER NOT NULL, mtime_ms REAL NOT NULL, ctime_ms REAL NOT NULL,
        imported_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_versions(
        resource_id TEXT NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
        relative_path TEXT NOT NULL, modified_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
        PRIMARY KEY(resource_id,version));`);
    this.jobs = Promise.resolve();
  }

  checkPath(base, path) {
    const rel = relative(base, path);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) fail('资料路径无效。');
    for (let check = path; ; check = dirname(check)) {
      let stat;
      try { stat = lstatSync(check); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat?.isSymbolicLink()) fail('资料库不支持符号链接。', 403);
      if (check === base) break;
    }
    return path;
  }

  path(relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || relativePath.split('/').some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part))) fail('资料路径无效。');
    return this.checkPath(this.folder, resolve(this.folder, relativePath));
  }

  async folderPath(folder = '') {
    if (typeof folder !== 'string' || folder.length > 1500 || (folder && folder.split('/').some(part => !safeName(part)))) fail('文件夹路径无效。');
    const path = folder ? this.path(folder) : this.checkPath(this.folder, this.folder);
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') fail('文件夹不存在，请刷新资料库。', 404); throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('文件夹路径无效。');
    return path;
  }

  serial(operation) {
    const job = this.jobs.then(operation);
    this.jobs = job.catch(() => {});
    return job;
  }

  async hashFile(path, signal) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
    return hash.digest('hex');
  }

  async scanFiles() {
    this.checkPath(this.folder, this.folder);
    const files = [], issues = [], folders = [{ path: '', name: '资料库' }];
    const walk = async folder => {
      let entries;
      try { this.checkPath(this.folder, folder); entries = await readdir(folder, { withFileTypes: true }); }
      catch { issues.push({ relativePath: relative(this.folder, folder).split('\\').join('/'), error: '无法读取文件夹' }); return; }
      for (const entry of entries) {
        const full = join(folder, entry.name);
        const relativePath = relative(this.folder, full).split('\\').join('/');
        if (entry.isSymbolicLink()) { issues.push({ relativePath, error: '符号链接未加入' }); continue; }
        if (entry.isDirectory()) { folders.push({ path: relativePath, name: entry.name }); await walk(full); }
        else if (entry.isFile()) files.push({ relativePath, full });
      }
    };
    await walk(this.folder);
    const existing = this.db.prepare('SELECT * FROM resources').all();
    const currentPaths = new Set(files.map(file => file.relativePath));
    const byPath = new Map(existing.map(row => [row.relative_path, row]));
    const used = new Set();
    for (const file of files) {
      let stat, sha256;
      try {
        this.path(file.relativePath);
        stat = await lstat(file.full);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const prior = byPath.get(file.relativePath);
        sha256 = prior && prior.size === stat.size && prior.mtime_ms === stat.mtimeMs && prior.ctime_ms === stat.ctimeMs ? prior.sha256 : await this.hashFile(file.full);
      } catch { issues.push({ relativePath: file.relativePath, error: '无法读取' }); continue; }
      let old = byPath.get(file.relativePath);
      if (!old) {
        const moved = existing.filter(row => !used.has(row.id) && !currentPaths.has(row.relative_path) && row.sha256 === sha256 && row.size === stat.size);
        if (moved.length === 1) old = moved[0];
      }
      const id = old?.id || randomUUID(), updatedAt = now();
      const version = old ? old.version + (old.sha256 !== sha256 ? 1 : 0) : 1;
      this.db.prepare(`INSERT INTO resources VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        relative_path=excluded.relative_path,sha256=excluded.sha256,size=excluded.size,mtime_ms=excluded.mtime_ms,
        ctime_ms=excluded.ctime_ms,updated_at=excluded.updated_at,version=excluded.version,status='ready'`)
        .run(id, file.relativePath, sha256, stat.size, stat.mtimeMs, stat.ctimeMs, old?.imported_at || updatedAt, updatedAt, version, 'ready');
      this.db.prepare('INSERT OR IGNORE INTO resource_versions VALUES(?,?,?,?,?,?,?)')
        .run(id, version, sha256, stat.size, file.relativePath, stat.mtime.toISOString(), updatedAt);
      used.add(id);
    }
    const unavailable = issues.map(issue => issue.relativePath);
    for (const row of existing) if (!used.has(row.id)) {
      const unreadable = unavailable.some(path => !path || row.relative_path === path || row.relative_path.startsWith(path + '/'));
      this.db.prepare('UPDATE resources SET status=? WHERE id=?').run(unreadable ? 'unreadable' : 'missing', row.id);
    }
    folders.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
    return { issues, folders };
  }

  async list() {
    return this.serial(async () => {
      const { issues, folders } = await this.scanFiles();
      return { folder: this.folder, folders, files: this.db.prepare('SELECT * FROM resources ORDER BY imported_at DESC,relative_path').all().map(metadata), issues };
    });
  }

  async get(id, version) {
    if (!validId(id)) fail('资料编号无效。');
    if (version !== undefined && version !== null && (!/^\d+$/.test(String(version)) || Number(version) < 1 || !Number.isSafeInteger(Number(version)))) fail('资料版本无效。');
    await this.list();
    const row = this.db.prepare('SELECT * FROM resources WHERE id=?').get(id);
    if (!row) fail('找不到这份资料。', 404);
    if (version && (Number(version) !== row.version || row.status !== 'ready')) {
      try { return (await this.resolveSnapshot(id, version)).file; }
      catch (error) { if (error.status !== 404) throw error; }
      if (Number(version) !== row.version) fail('资料已更新，请刷新后查看当前版本。', 409);
    }
    return metadata(row);
  }

  async upload(req, name, folder = '') {
    if (!safeName(name)) { req.resume?.(); fail('文件名无效。'); }
    try { await this.folderPath(folder); } catch (error) { req.resume?.(); throw error; }
    if (Number(req.headers?.['content-length']) > RESOURCE_UPLOAD_LIMIT) { req.resume?.(); fail('单份资料不能超过200MB。', 413); }
    this.checkPath(join(this.root, 'data'), this.uploadFolder);
    const temporary = join(this.uploadFolder, `${randomUUID()}.upload`);
    let handle;
    try {
      handle = await open(temporary, 'wx');
      const hash = createHash('sha256'); let size = 0, tooLarge = false;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > RESOURCE_UPLOAD_LIMIT) { tooLarge = true; continue; }
        hash.update(chunk); await handle.writeFile(chunk);
      }
      await handle.close(); handle = null;
      if (tooLarge) fail('单份资料不能超过200MB。', 413);
      const sha256 = hash.digest('hex');
      return await this.serial(async () => {
        await this.folderPath(folder);
        await this.scanFiles();
        const duplicate = this.db.prepare("SELECT * FROM resources WHERE sha256=? AND size=? AND status='ready' ORDER BY imported_at").all(sha256, size)
          .find(row => (dirname(row.relative_path).replaceAll('\\', '/') === '.' ? '' : dirname(row.relative_path).replaceAll('\\', '/')) === folder);
        if (duplicate) return { file: metadata(duplicate), duplicate: true };
        const extension = extname(name), stem = name.slice(0, name.length - extension.length);
        let destination, relativePath;
        for (let suffix = 0; ; suffix++) {
          const filename = suffix ? `${stem} (${suffix + 1})${extension}` : name;
          relativePath = folder ? `${folder}/${filename}` : filename;
          destination = this.path(relativePath);
          try { await copyFile(temporary, destination, constants.COPYFILE_EXCL); break; }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        await this.scanFiles();
        const row = this.db.prepare('SELECT * FROM resources WHERE relative_path=?').get(relativePath);
        return { file: metadata(row), duplicate: false };
      });
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async createFolder({ parent = '', name } = {}) {
    if (!safeName(name)) fail('文件夹名称无效。');
    return this.serial(async () => {
      await this.folderPath(parent);
      const path = parent ? `${parent}/${name}` : name;
      if (path.length > 1500) fail('文件夹路径过长。');
      try { await mkdir(this.path(path)); }
      catch (error) { if (error.code === 'EEXIST') fail('同名文件或文件夹已存在。', 409); throw error; }
      return { path, name };
    });
  }

  async openFolder(folder = '') {
    await this.openImpl(await this.folderPath(folder));
    return { ok: true };
  }

  snapshotPath(id, versionRow) {
    const extension = extname(versionRow.relative_path).toLowerCase();
    return this.checkPath(join(this.root, 'data'), join(this.snapshotFolder, id,
      `${versionRow.sha256}${/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.bin'}`));
  }

  async resolveSnapshot(id, version) {
    if (!validId(id)) fail('资料编号无效。');
    if (!/^\d+$/.test(String(version)) || !Number.isSafeInteger(Number(version)) || Number(version) < 1) fail('资料版本无效。');
    const row = this.db.prepare('SELECT * FROM resource_versions WHERE resource_id=? AND version=?').get(id, Number(version));
    const current = this.db.prepare('SELECT * FROM resources WHERE id=?').get(id);
    if (!row || !current) fail('找不到这份资料。', 404);
    const path = this.snapshotPath(id, row);
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') fail('该版本尚未保存原件快照。', 404); throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== row.size || await this.hashFile(path) !== row.sha256) fail('原件快照校验失败。', 409);
    const file = metadata({ ...current, relative_path: row.relative_path, sha256: row.sha256, size: row.size,
      mtime_ms: Date.parse(row.modified_at), version: row.version, status: 'ready' });
    return { file: { ...file, snapshot: true, historical: current.version !== row.version }, path };
  }

  async snapshot(id, version, { signal } = {}) {
    signal?.throwIfAborted();
    if (version !== undefined && version !== null) {
      try { return await this.resolveSnapshot(id, version); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    const file = await this.get(id, version);
    signal?.throwIfAborted();
    if (file.status !== 'ready') fail('原文件已移动或无法读取，请刷新资料库。', 404);
    const row = this.db.prepare('SELECT * FROM resource_versions WHERE resource_id=? AND version=?').get(id, file.version);
    const destination = this.snapshotPath(id, row);
    await mkdir(dirname(destination), { recursive: true });
    this.snapshotPath(id, row);
    const temporary = this.checkPath(join(this.root, 'data'), join(dirname(destination), `${randomUUID()}.snapshot`));
    try {
      await pipeline(createReadStream(this.path(file.relativePath)), createWriteStream(temporary, { flags: 'wx' }), { signal });
      signal?.throwIfAborted();
      if (await this.hashFile(temporary, signal) !== file.sha256) fail('资料正在修改，未保存快照，请刷新后重试。', 409);
      signal?.throwIfAborted();
      this.snapshotPath(id, row);
      try { await rename(temporary, destination); }
      catch (error) {
        if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        await this.resolveSnapshot(id, file.version);
      }
      await chmod(destination, 0o444);
      return await this.resolveSnapshot(id, file.version);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async openFile(id, version) {
    const file = await this.get(id, version);
    if (file.status !== 'ready') fail('原文件已移动或无法读取，请刷新资料库。', 404);
    if (!file.openable) fail('这类文件请先下载。', 415);
    await this.openImpl(file.snapshot ? (await this.resolveSnapshot(id, file.version)).path : this.path(file.relativePath));
    return { ok: true };
  }

  async serve(req, res, id, { download = false, version, sha256 } = {}) {
    const file = await this.get(id, version);
    if (file.status !== 'ready') fail('原文件已移动或无法读取，请刷新资料库。', 404);
    if (sha256 && sha256 !== file.sha256) fail('资料内容已变化，请刷新引用。', 409);
    const path = file.snapshot ? (await this.resolveSnapshot(id, file.version)).path : this.path(file.relativePath), stat = await lstat(path);
    const row = this.db.prepare('SELECT mtime_ms,ctime_ms FROM resources WHERE id=?').get(file.id);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || (!file.snapshot && (stat.mtimeMs !== row.mtime_ms || stat.ctimeMs !== row.ctime_ms))) fail('资料正在修改，请稍后重试。', 409);
    const inline = !download && file.previewable;
    const encodedName = encodeURIComponent(file.name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const headers = { 'Content-Type': inline ? file.mime : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="resource${/^\.[a-z0-9]{1,12}$/i.test(extname(file.name)) ? extname(file.name) : '.bin'}"; filename*=UTF-8''${encodedName}`,
      'Content-Length': file.size, 'Accept-Ranges': 'bytes', 'ETag': `"${file.sha256}"`,
      'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'" };
    let start = 0, end = file.size - 1, status = 200;
    if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === headers.ETag)) {
      const range = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
      if (range && (range[1] || range[2])) {
        start = range[1] ? Number(range[1]) : Math.max(0, file.size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
      }
      if (!range || !(range[1] || range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= file.size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${file.size}`, 'Content-Length': 0 }); res.end(); return;
      }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`; headers['Content-Length'] = end - start + 1;
    }
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !file.size) { res.end(); return; }
    try { await pipeline(createReadStream(path, { start, end }), res); }
    catch (error) { res.destroy(error); }
  }

  close() { this.db.close(); }
}
