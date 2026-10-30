import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GAME_DIR, ROOT } from './paths.mjs';
import { fetchJson } from './http.mjs';
import { findVersionDir, installedVersions, readLocalVersionJson } from './install.mjs';
import { RUNTIME_NAME } from './launch.mjs';
import { listJava } from './java.mjs';
import { pickSource } from './source.mjs';
import { inspectArchive, inferMcFromNames } from './mods.mjs';
import { diagnoseSummary } from './diagnose.mjs';
import { loadAuth, loginWithDeviceCode } from './auth.mjs';
import { listLoaderVersions, detectLoader as detectLoaderId, loaderLabelFor } from './loader.mjs';

const MSA_CLIENT_ID = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';
import { searchProjects, analyzeProjects, installModsBatch, getProjectDetail, installShader, resolveModIds } from './modrinth.mjs';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const CLI = path.join(ROOT, 'bin', 'mcl.mjs');

/** MCL_LOG_HTTP=1 时把每个请求记一行，排查前端到底加载了哪版 bundle */
const HTTP_LOG = process.env.MCL_LOG_HTTP ? path.join(ROOT, 'tmp', 'http-requests.log') : null;
/** 浮窗挂载信标（插件客户端每次 mount 打一枪），排查"浮窗有没有渲染" */
const MOUNT_LOG = path.join(ROOT, 'tmp', 'client-mounts.log');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let javaCache = null;
let javaCacheAt = 0;

/** 探测 Java 要起子进程，缓存 60 秒，避免前端轮询把 CPU 吃满 */
function cachedJava() {
  if (!javaCache || Date.now() - javaCacheAt > 60_000) {
    javaCache = listJava().map((item) => ({ major: item.major, raw: item.raw, exe: item.exe }));
    javaCacheAt = Date.now();
  }
  return javaCache;
}

function detectLoader(json) {
  return loaderLabelFor(detectLoaderId(json));
}

/** 需要的 Java 版本要看继承链（Fabric 的 json 往往不写 javaVersion） */
function javaMajorFor(id) {
  let cursor = readLocalVersionJson(id);
  for (let guard = 0; cursor && guard < 10; guard += 1) {
    if (cursor.javaVersion?.majorVersion) return cursor.javaVersion.majorVersion;
    if (!cursor.inheritsFrom) break;
    cursor = readLocalVersionJson(cursor.inheritsFrom);
  }
  return 8;
}

/** 版本目录；实例名可能已经被删掉，找不到就返回 null */
function safeVersionDir(id) {
  try {
    const dir = findVersionDir(id);
    return dir && fs.existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** 实例目录里的运行时快照（由 launch.mjs 写，包含真实 java pid） */
function readRuntimeRecord(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, RUNTIME_NAME), 'utf8'));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    // Windows 上权限不足会抛 EPERM，说明进程还活着
    return error?.code === 'EPERM';
  }
}

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout));
    });
  });
}

let memCache = { pid: 0, at: 0, value: null };

/** java 进程常驻内存（working set, MB）；tasklist 有开销，缓存 10 秒 */
async function processMemoryMb(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (memCache.pid === value && Date.now() - memCache.at < 10_000) return memCache.value;

  let result = null;
  if (process.platform === 'win32') {
    const out = await runCommand('tasklist', ['/FI', `PID eq ${value}`, '/FO', 'CSV', '/NH']);
    const line = out.split(/\r?\n/).find((row) => row.trim().startsWith('"'));
    if (line) {
      // 注意：内存列本身带千位逗号（"889,804 K"），不能简单按逗号切
      const image = (line.match(/^\s*"([^"]+)"/)?.[1] ?? '').toLowerCase();
      const mem = line.match(/"([\d,.\s]+K)"\s*$/)?.[1] ?? '';
      // pid 被别的进程复用时不要误报
      if (image.includes('java') && mem) {
        const kb = Number(mem.replace(/[^\d]/g, ''));
        if (Number.isFinite(kb) && kb > 0) result = Math.round(kb / 1024);
      }
    }
  }
  memCache = { pid: value, at: Date.now(), value: result };
  return result;
}

/** 日志行清理：去掉控制字符、截断超长行（整合包偶有二进制垃圾刷进日志） */
function sanitizeLogLine(line, max = 400) {
  const clean = line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 读文件末尾若干行，不整个读进内存（1.4G 的日志也不怕） */
function readTailLines(file, { bytes = 128 * 1024, lines = 40 } = {}) {
  let fd;
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0) return { lines: [], size: 0, mtime: stat.mtimeMs, truncated: false };
    const length = Math.min(bytes, stat.size);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    const all = buffer
      .toString('utf8')
      .split(/\r?\n/)
      // 从文件中间开始读，第一行可能是半截（甚至是半个 UTF-8 字符），丢掉
      .slice(length < stat.size ? 1 : 0)
      .map((line) => sanitizeLogLine(line))
      .filter((line) => line.trim() !== '');
    return {
      lines: all.slice(-lines),
      size: stat.size,
      mtime: stat.mtimeMs,
      truncated: length < stat.size,
    };
  } catch {
    return { lines: [], size: 0, mtime: 0, truncated: false };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function readBody(req, limit = 96 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const CORS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/** 只放行本机页面（DSH 面板 / 启动器自身），不再对任意网站开放 */
function corsFor(req) {
  const origin = req.headers.origin;
  // DSH 桌面版页面是自定义协议 dsh-app://app，Electron 里也是本机应用，一并放行
  if (origin && /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|dsh-app:\/\/app|file:\/\/)$/i.test(origin)) {
    return { ...CORS, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return {};
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...res.cors,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(res, file) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(UI_DIR))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(resolved, (error, buf) => {
    if (error) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      ...(res.cors ?? {}),
      'Content-Type': MIME[path.extname(resolved)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

export async function startGui({ port = 51730, open = true, openWindow = true } = {}) {
  const clients = new Set();
  const jobs = { install: null, launch: null };
  let remoteCache = null;
  let remoteAt = 0;

  const broadcast = (event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try {
        res.write(data);
      } catch {
        clients.delete(res);
      }
    }
  };

  function runJob(kind, args, meta) {
    if (jobs[kind]) throw new Error(kind === 'install' ? '已有安装任务在跑' : '游戏已经在运行了');
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      windowsHide: true,
      env: process.env,
    });
    const job = { id: `${kind}-${Date.now()}`, kind, meta, child, status: 'running' };
    jobs[kind] = job;
    broadcast({ type: 'job', kind, status: 'running', meta });

    const flush = (chunk) => {
      const text = chunk.toString();
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\r/g, '').replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
        if (!line) continue;
        broadcast({ type: 'line', kind, line });
      }
    };
    child.stdout.on('data', flush);
    child.stderr.on('data', flush);

    const done = (status) => {
      if (jobs[kind] !== job) return;
      job.status = status;
      jobs[kind] = null;
      invalidateVersions(); // 装完/启动完版本列表可能变了，别让缓存拖着
      broadcast({ type: 'job', kind, status, meta });
      broadcast({ type: 'refresh' });
    };

    child.on('close', (code) => done(code === 0 ? 'done' : 'error'));
    child.on('error', () => done('error'));
    return job;
  }

  function killJob(kind) {
    const job = jobs[kind];
    if (!job) return false;
    const pid = job.child.pid;
    try {
      if (process.platform === 'win32' && pid) {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else if (pid) {
        process.kill(-pid, 'SIGTERM');
      }
    } catch {
      try {
        job.child.kill();
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  let lastLaunched = null;
  let scannedRuntime = false;

  /** 服务重启后仍能显示上次跑的是哪个实例（按运行时快照的修改时间猜） */
  function guessLastInstance() {
    if (lastLaunched || scannedRuntime) return lastLaunched;
    scannedRuntime = true;
    let best = null;
    let bestAt = 0;
    for (const id of installedVersions()) {
      const dir = safeVersionDir(id);
      if (!dir) continue;
      try {
        const stat = fs.statSync(path.join(dir, RUNTIME_NAME));
        if (stat.mtimeMs > bestAt) {
          bestAt = stat.mtimeMs;
          best = id;
        }
      } catch {
        /* 没跑过的实例没有运行时快照 */
      }
    }
    if (best) lastLaunched = best;
    return lastLaunched;
  }

  function activeInstance() {
    return jobs.launch?.meta?.version ?? guessLastInstance() ?? null;
  }

  /** 运行时状态：真实 java pid、内存占用、是否还活着 */
  async function buildRuntime() {
    const instance = activeInstance();
    if (!instance) return null;
    const dir = safeVersionDir(instance);
    if (!dir) return null;
    const record = readRuntimeRecord(dir);
    if (!record) return null;
    const alive = isPidAlive(record.pid);
    const startedAt = record.startedAt ? Date.parse(record.startedAt) : null;
    return {
      instance,
      dir,
      pid: record.pid ?? null,
      memory: record.memory ?? null,
      username: record.username ?? null,
      online: Boolean(record.online),
      startedAt: record.startedAt ?? null,
      uptimeSec: alive && Number.isFinite(startedAt) ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : null,
      alive,
      rssMb: alive ? await processMemoryMb(record.pid) : null,
      stopped: Boolean(record.stopped),
      exitCode: record.exitCode ?? null,
    };
  }

  // 版本摘要缓存：每个版本要读 json + raddir mods 目录，浮窗 3 秒轮询一次很浪费
  let versionsCache = { at: 0, data: null };

  function invalidateVersions() {
    versionsCache = { at: 0, data: null };
  }

  /** 实例对应的 Minecraft 版本：先看版本 json，再按 mod 文件名投票 */
  function mcFor(id, json, jarNames) {
    const declared = json?.inheritsFrom ?? json?.clientVersion ?? null;
    if (declared && /^\d+\.\d+(\.\d+)?$/.test(String(declared))) return String(declared);
    if (/^\d+\.\d+(\.\d+)?$/.test(id)) return id;
    const inferred = inferMcFromNames(jarNames ?? []);
    return inferred ?? null;
  }

  function buildVersions() {
    if (versionsCache.data && Date.now() - versionsCache.at < 20_000) return versionsCache.data;
    const data = installedVersions().map((id) => {
      const json = readLocalVersionJson(id) ?? {};
      let playTime = null;
      try {
        const stat = fs.statSync(path.join(GAME_DIR, 'versions', id, 'options.txt'));
        playTime = stat.mtime.toISOString();
      } catch {
        /* ignore */
      }
      let jarNames = [];
      try {
        jarNames = fs.readdirSync(path.join(GAME_DIR, 'versions', id, 'mods')).filter((f) => f.endsWith('.jar'));
      } catch {
        /* ignore */
      }
      return {
        id,
        mc: mcFor(id, json, jarNames),
        type: json.type ?? 'release',
        loader: detectLoader(json),
        java: javaMajorFor(id),
        lastPlayed: playTime,
        mods: jarNames.length,
      };
    });
    versionsCache = { at: Date.now(), data };
    return data;
  }

  async function buildState() {
    const versions = buildVersions();
    const account = loadAuth();
    const runtime = await buildRuntime();
    return {
      gameDir: GAME_DIR,
      versions,
      instance: runtime?.instance ?? activeInstance(),
      memory: {
        totalGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
        freeGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
      },
      auth: account
        ? {
            loggedIn: true,
            name: account.name,
            uuid: account.uuid,
            expiresAt: account.expiresAt ?? null,
            expired: typeof account.expiresAt === 'number' ? account.expiresAt < Date.now() : null,
          }
        : { loggedIn: false },
      java: cachedJava(),
      runtime,
      // 命令行启动的游戏没有 job，但 java 进程还活着，也算运行中
      running: Boolean(jobs.launch) || Boolean(runtime?.alive),
      installing: Boolean(jobs.install),
      installTarget: jobs.install?.meta?.version ?? null,
    };
  }

  let currentUrl = '';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;
    res.cors = corsFor(req);

    if (HTTP_LOG) {
      const startedAt = Date.now();
      res.on('finish', () => {
        try {
          fs.appendFileSync(
            HTTP_LOG,
            `${new Date().toISOString()} ${res.statusCode} ${req.method} ${route}${url.search} ${Date.now() - startedAt}ms origin=${req.headers.origin ?? '-'}\n`,
          );
        } catch {
          /* 记日志失败不影响请求 */
        }
      });
    }

    // 非本机来源直接 403，不再只是“不给 CORS 头”
    if (req.headers.origin && !res.cors['Access-Control-Allow-Origin']) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden origin');
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsFor(req)).end();
      return;
    }

    try {
      if (route === '/' || route === '/index.html') {
        serveStatic(res, path.join(UI_DIR, 'index.html'));
        return;
      }
      if (route === '/app.js' || route === '/style.css') {
        serveStatic(res, path.join(UI_DIR, route.slice(1)));
        return;
      }

      if (route === '/api/client/mount') {
        try {
          const detail = Object.fromEntries(url.searchParams.entries());
          fs.appendFileSync(
            MOUNT_LOG,
            `${new Date().toISOString()} origin=${req.headers.origin ?? '-'} ${JSON.stringify(detail)}\n`,
          );
        } catch {
          /* ignore */
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (route === '/api/state') {
        sendJson(res, 200, await buildState());
        return;
      }

      if (route === '/api/logs') {
        const wanted = String(url.searchParams.get('instance') || activeInstance() || '').trim();
        const limit = Math.min(300, Math.max(1, Number(url.searchParams.get('lines')) || 40));
        if (!wanted) {
          sendJson(res, 200, { instance: null, source: null, lines: [], hint: '还没有启动过实例' });
          return;
        }
        const dir = safeVersionDir(wanted);
        if (!dir) {
          sendJson(res, 404, { error: `找不到实例 ${wanted}` });
          return;
        }
        const candidates = [path.join(dir, 'logs', 'latest.log'), path.join(dir, 'launcher-console.log')];
        const source = candidates.find((file) => fs.existsSync(file)) ?? null;
        const tail = source ? readTailLines(source, { lines: limit }) : { lines: [], size: 0, mtime: 0, truncated: false };
        // 这里只需要"在不在跑"，不要为了内存数字再起 tasklist
        const record = readRuntimeRecord(dir);
        const alive = record ? isPidAlive(record.pid) : false;
        sendJson(res, 200, {
          instance: wanted,
          dir,
          source,
          ...tail,
          running: jobs.launch?.meta?.version === wanted || (alive && record?.instance === wanted),
          updatedAt: Date.now(),
        });
        return;
      }

      if (route === '/api/loader/list') {
        const loader = String(url.searchParams.get('loader') || 'forge').toLowerCase();
        const mc = String(url.searchParams.get('mc') || '').trim();
        if (!mc) {
          sendJson(res, 400, { error: '缺少 mc 参数' });
          return;
        }
        try {
          sendJson(res, 200, { loader, mc, versions: await listLoaderVersions(loader, mc) });
        } catch (error) {
          sendJson(res, 400, { error: String(error?.message ?? error) });
        }
        return;
      }

      if (route === '/api/loader/install' && req.method === 'POST') {
        const body = await readBody(req);
        const loader = String(body.loader || 'forge').toLowerCase();
        const mc = String(body.mcVersion || '').trim();
        if (!['fabric', 'forge', 'neoforge'].includes(loader)) {
          sendJson(res, 400, { error: 'loader 只能是 fabric / forge / neoforge' });
          return;
        }
        if (!mc) {
          sendJson(res, 400, { error: '缺少 Minecraft 版本' });
          return;
        }
        const args = [loader === 'fabric' ? 'fabric' : loader, mc];
        if (body.loaderVersion) args.push('--loader', String(body.loaderVersion));
        runJob('install', args, {
          version: `${loader} ${mc}`,
          label: `安装 ${{ fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' }[loader]} → ${mc}`,
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (route === '/api/remote') {
        if (!remoteCache || Date.now() - remoteAt > 5 * 60_000) {
          const { manifest, sources } = await pickSource('auto');
          remoteCache = {
            source: sources[0].label,
            latest: manifest.latest,
            versions: manifest.versions
              .filter((v) => v.type === 'release')
              .slice(0, 60)
              .map((v) => ({ id: v.id, releaseTime: v.releaseTime })),
          };
          remoteAt = Date.now();
        }
        sendJson(res, 200, remoteCache);
        return;
      }

      if (route === '/api/install' && req.method === 'POST') {
        const body = await readBody(req);
        const version = String(body.version ?? '').trim();
        if (!version) {
          sendJson(res, 400, { error: '缺少版本号' });
          return;
        }
        const args = ['install', version];
        if (body.source) args.push('--source', String(body.source));
        runJob('install', args, { version });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (route === '/api/launch' && req.method === 'POST') {
        const body = await readBody(req);
        const version = String(body.version ?? '').trim();
        if (!version) {
          sendJson(res, 400, { error: '缺少版本号' });
          return;
        }
        const args = ['launch', version, '--user', String(body.username || 'Player')];
        if (body.memory) args.push('--memory', String(body.memory));
        if (body.width) args.push('--width', String(body.width));
        if (body.height) args.push('--height', String(body.height));
        if (body.auth && loadAuth()) args.push('--auth');
        lastLaunched = version;
        runJob('launch', args, { version, username: body.username || 'Player' });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (route === '/api/stop' && req.method === 'POST') {
        let stopped = killJob('launch') || killJob('install');
        if (!stopped) {
          // 命令行 / 别处启动的游戏：按运行时快照里的 pid 收掉
          const dir = lastLaunched ? safeVersionDir(lastLaunched) : null;
          const record = dir ? readRuntimeRecord(dir) : null;
          if (record?.pid && isPidAlive(record.pid)) {
            try {
              if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', String(record.pid), '/T', '/F'], { windowsHide: true });
              } else {
                process.kill(record.pid, 'SIGTERM');
              }
              stopped = true;
              memCache = { pid: 0, at: 0, value: null };
            } catch {
              /* ignore */
            }
          }
        }
        sendJson(res, 200, { ok: stopped });
        return;
      }

      if (route === '/api/mod/inspect-path' && req.method === 'POST') {
        const body = await readBody(req);
        const raw = String(body.path ?? '')
          .replace(/^["'“”「」『』\s]+|["'“”「」『』\s]+$/g, '')
          .replace(/[\u00a0\u3000]/g, ' ');
        const target = path.resolve(raw);
        if (!raw || !fs.existsSync(target)) {
          // 顺便看看目录里有没有相似的文件，方便排查
          let near = [];
          try {
            const dir = path.dirname(target);
            const want = path.basename(target).slice(0, 6);
            near = fs
              .readdirSync(dir)
              .filter((name) => name.includes(want.slice(0, 3)))
              .slice(0, 10);
          } catch {
            /* ignore */
          }
          sendJson(res, 400, {
            error: `文件不存在：${target}`,
            near,
          });
          return;
        }
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
          sendJson(res, 400, { error: '这是一个目录，请选文件' });
          return;
        }
        const buffer = fs.readFileSync(target);
        const result = inspectArchive(buffer, path.basename(target));
        sendJson(res, 200, result);
        return;
      }

      if (route === '/api/mod/inspect' && req.method === 'POST') {
        const body = await readBody(req);
        const data = String(body.data ?? '');
        if (!data) {
          sendJson(res, 400, { error: '缺少文件内容' });
          return;
        }
        const buffer = Buffer.from(data, 'base64');
        const result = inspectArchive(buffer, String(body.name ?? 'upload.bin'));
        sendJson(res, 200, result);
        return;
      }

      if (route === '/api/open-window' && req.method === 'POST') {
        openBrowser(currentUrl, true);
        sendJson(res, 200, { ok: true, url: currentUrl });
        return;
      }

      if (route === '/api/search' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await searchProjects({
          query: String(body.query ?? ''),
          type: body.type === 'modpack' ? 'modpack' : body.type === 'shader' ? 'shader' : 'mod',
          loader: body.loader ? String(body.loader) : undefined,
          mcVersion: body.mcVersion ? String(body.mcVersion) : undefined,
          index: body.index ? String(body.index) : 'relevance',
          offset: Number(body.offset ?? 0) || 0,
          limit: Math.min(Number(body.limit ?? 24) || 24, 48),
        });
        sendJson(res, 200, result);
        return;
      }

      if (route === '/api/mod/install' && req.method === 'POST') {
        const body = await readBody(req);
        const projectId = String(body.projectId ?? '').trim();
        const mc = String(body.mcVersion ?? '').trim();
        if (!projectId || !mc) {
          sendJson(res, 400, { error: '缺少项目 ID 或 Minecraft 版本' });
          return;
        }
        runJob('install', [
          'mod',
          projectId,
          '--mc',
          mc,
          ...(body.loader ? ['--loader', String(body.loader)] : []),
          ...(body.instance ? ['--instance', String(body.instance)] : []),
        ], { version: `模组 ${projectId}`, label: `安装模组 → ${body.instance ? String(body.instance) : mc}` });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (route === '/api/pack/install' && req.method === 'POST') {
        const body = await readBody(req);
        const projectId = String(body.projectId ?? '').trim();
        const mc = String(body.mcVersion ?? '').trim();
        if (!projectId) {
          sendJson(res, 400, { error: '缺少项目 ID' });
          return;
        }
        const args = ['pack', projectId];
        if (mc) args.push('--mc', mc);
        runJob('install', args, { version: `整合包 ${projectId}`, label: `安装整合包 → ${mc || '自动建实例'}` });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (route === '/api/mods/analyze' && req.method === 'POST') {
        const body = await readBody(req);
        const projectIds = Array.isArray(body.projectIds) ? body.projectIds.map(String) : [];
        if (projectIds.length === 0) {
          sendJson(res, 400, { error: '没有选中模组' });
          return;
        }
        const result = await analyzeProjects({
          projectIds,
          mcVersion: String(body.mcVersion ?? '1.20.1'),
          loader: body.loader ? String(body.loader) : 'fabric',
        });
        sendJson(res, 200, result);
        return;
      }

      if (route === '/api/mods/install-batch' && req.method === 'POST') {
        const body = await readBody(req);
        const projectIds = Array.isArray(body.projectIds) ? body.projectIds.map(String) : [];
        const mc = String(body.mcVersion ?? '').trim();
        if (projectIds.length === 0 || !mc) {
          sendJson(res, 400, { error: '缺少模组列表或 Minecraft 版本' });
          return;
        }
        const args = ['mods', ...projectIds, '--mc', mc];
        // 加载器要透传：Forge/NeoForge 的模组和 Fabric 不是同一批文件
        if (body.loader) args.push('--loader', String(body.loader));
        // 指定了实例就装进那个实例（插件里选中的），否则按加载器自动准备
        if (body.instance) args.push('--instance', String(body.instance));
        const where = body.instance ? String(body.instance) : mc;
        runJob('install', args, {
          version: `${projectIds.length} 个模组`,
          label: `安装 ${projectIds.length} 个模组 → ${where}`,
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      // 本地 jar 里的 mod id 反查 Modrinth 项目（给「一键装缺失前置」用）
      if (route === '/api/mods/resolve' && req.method === 'POST') {
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean).slice(0, 60) : [];
        if (ids.length === 0) {
          sendJson(res, 400, { error: '缺少 ids' });
          return;
        }
        try {
          const result = await resolveModIds(ids, {
            loader: body.loader ? String(body.loader) : 'fabric',
            mcVersion: body.mcVersion ? String(body.mcVersion) : undefined,
          });
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
        return;
      }

      if (route === '/api/project/detail' && req.method === 'POST') {
        const body = await readBody(req);
        const projectId = String(body.projectId ?? '').trim();
        if (!projectId) {
          sendJson(res, 400, { error: '缺少项目 ID' });
          return;
        }
        const detail = await getProjectDetail(projectId, {
          mcVersion: body.mcVersion ? String(body.mcVersion) : undefined,
          loader: body.loader ? String(body.loader) : 'fabric',
        });
        sendJson(res, 200, detail);
        return;
      }

      if (route === '/api/translate' && req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').slice(0, 450);
        if (!text.trim()) {
          sendJson(res, 200, { text: '' });
          return;
        }
        try {
          const data = await fetchJson(
            `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-CN`,
            { timeout: 20_000 },
          );
          sendJson(res, 200, { text: data?.responseData?.translatedText ?? '' });
        } catch (error) {
          sendJson(res, 200, { text: '', error: error.message });
        }
        return;
      }

      if (route === '/api/mod/import' && req.method === 'POST') {
        const body = await readBody(req);
        const target = String(body.path ?? '').trim();
        if (!target) {
          sendJson(res, 400, { error: '缺少文件路径' });
          return;
        }
        runJob('install', ['import', target], { version: '导入整合包' });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (route === '/api/shader/install' && req.method === 'POST') {
        const body = await readBody(req);
        const projectId = String(body.projectId ?? '').trim();
        const mc = String(body.mcVersion ?? '').trim();
        if (!projectId || !mc) {
          sendJson(res, 400, { error: '缺少项目 ID 或 Minecraft 版本' });
          return;
        }
        try {
          const result = await installShader(projectId, {
            mcVersion: mc,
            instance: body.instance ? String(body.instance) : undefined,
          });
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
        return;
      }

      if (route === '/api/diagnose' && req.method === 'POST') {
        const body = await readBody(req);
        const instance = String(body.instance ?? '').trim();
        if (!instance) {
          sendJson(res, 400, { error: '缺少实例名' });
          return;
        }
        try {
          sendJson(res, 200, diagnoseSummary(instance));
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
        return;
      }

      if (route === '/api/pick-file' && req.method === 'POST') {
        // 浏览器拿不到完整路径，改用系统文件对话框，服务端返回真实路径
        const script =
          "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Filter = 'Minecraft 文件|*.jar;*.zip;*.mrpack|所有文件|*.*'; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }";
        const { execFile } = await import('node:child_process');
        execFile(
          'powershell',
          ['-NoProfile', '-STA', '-Command', script],
          { windowsHide: true, timeout: 120_000 },
          (error, stdout) => {
            if (error) {
              sendJson(res, 500, { error: error.message });
              return;
            }
            sendJson(res, 200, { path: String(stdout).trim() });
          },
        );
        return;
      }

      if (route === '/api/auth/status') {
        const account = loadAuth();
        sendJson(res, 200, account
          ? { loggedIn: true, name: account.name, uuid: account.uuid, updatedAt: account.updatedAt }
          : { loggedIn: false });
        return;
      }

      if (route === '/api/auth/start' && req.method === 'POST') {
        const body = await readBody(req);
        const clientId = String(body.clientId || MSA_CLIENT_ID);
        try {
          let resolveCode;
          const codeReady = new Promise((resolve) => {
            resolveCode = resolve;
          });
          // 后台跑完整流程，界面先拿设备码
          loginWithDeviceCode({
            clientId,
            onDeviceCode: (info) => resolveCode(info),
          })
            .then((account) => broadcast({ type: 'auth', status: 'ok', name: account.name, uuid: account.uuid }))
            .catch((error) => broadcast({ type: 'auth', status: 'error', message: error.message }));
          const info = await codeReady;
          sendJson(res, 200, { ...info, clientId });
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
        return;
      }

      if (route === '/api/auth/logout' && req.method === 'POST') {
        try {
          const file = path.join(os.homedir(), '.mcl', 'auth.json');
          if (fs.existsSync(file)) fs.rmSync(file, { force: true });
          sendJson(res, 200, { ok: true });
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
        return;
      }

      if (route === '/api/events') {
        res.writeHead(200, {
          ...res.cors, // 跨源（DSH 页面 dsh-app://app）订阅 SSE 必须有 CORS 头
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
        clients.add(res);
        const keepAlive = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            /* ignore */
          }
        }, 20_000);
        req.on('close', () => {
          clearInterval(keepAlive);
          clients.delete(res);
        });
        return;
      }

      res.writeHead(404).end('not found');
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });

  const actualPort = await listenFree(server, port);
  const url = `http://127.0.0.1:${actualPort}`;
  currentUrl = url;
  writeServerInfo(actualPort);
  server.on('close', () => clearServerInfo(actualPort));
  process.on('exit', () => clearServerInfo(actualPort));
  if (open) openBrowser(url, openWindow);

  return { server, url, port: actualPort, close: () => server.close() };
}

/* ---------- 端口发现 ---------- */

const SERVER_INFO = path.join(os.homedir(), '.mcl', 'server.json');

/** 真正 listen 一次；被占用会 reject EADDRINUSE */
function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/** 从 prefer 开始往后找空闲端口，实在不行让系统分配 */
async function listenFree(server, prefer) {
  for (let offset = 0; offset < 20; offset += 1) {
    const candidate = prefer + offset;
    if (candidate > 65535) break;
    try {
      return await listenOn(server, candidate);
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  return listenOn(server, 0);
}

/** 写端口发现文件，插件/客户端靠它找到真实端口 */
function writeServerInfo(port) {
  try {
    fs.mkdirSync(path.dirname(SERVER_INFO), { recursive: true });
    fs.writeFileSync(
      SERVER_INFO,
      `${JSON.stringify({ port, pid: process.pid, url: `http://127.0.0.1:${port}`, startedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    /* 写不了就算了，插件还有端口扫描兜底 */
  }
}

/** 只清理自己写的那份（同时开着多个实例时别互相踩） */
function clearServerInfo(port) {
  try {
    const current = JSON.parse(fs.readFileSync(SERVER_INFO, 'utf8'));
    if (current.port === port && current.pid === process.pid) fs.rmSync(SERVER_INFO, { force: true });
  } catch {
    /* ignore */
  }
}

/** 优先后台 app 窗口模式打开，失败退回默认浏览器 */
function openBrowser(url, openWindow) {
  if (process.platform !== 'win32') {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      /* ignore */
    }
    return;
  }

  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];

  if (openWindow) {
    const browser = candidates.find((file) => fs.existsSync(file));
    if (browser) {
      try {
        // 走 cmd 的 start（ShellExecute）起窗口：窗口用自己的显示状态。
        // 直接 spawn 浏览器时，从隐藏窗口（DSH 宿主 / 启动.bat）拉起会继承隐藏状态，
        // 结果窗口是"开了但最小化"，看起来就像没打开。
        spawn(
          process.env.ComSpec || 'cmd.exe',
          [
            '/c',
            'start',
            '',
            browser,
            `--app=${url}`,
            '--window-size=1280,900',
            '--window-position=120,60',
            '--no-first-run',
            '--no-default-browser-check',
          ],
          { detached: true, stdio: 'ignore', windowsHide: true },
        ).unref();
        return;
      } catch {
        /* 落回默认浏览器 */
      }
    }
  }

  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* ignore */
  }
}
