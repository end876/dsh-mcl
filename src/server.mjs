import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GAME_DIR, ROOT, VERSIONS_DIR, isInside } from './paths.mjs';
import { fetchJson, sha1Hex } from './http.mjs';
import { findVersionDir, installedVersions, readLocalVersionJson } from './install.mjs';
import { RUNTIME_NAME } from './launch.mjs';
import { ensureJava, listJava } from './java.mjs';
import { applyModAction, buildFixReport, crashSummary, detectCrash } from './crashfix.mjs';
import { pickSource } from './source.mjs';
import { inspectArchiveFile, inferMcFromNames } from './mods.mjs';
import { EXPORTS_DIR } from './exportpack.mjs';
import { diagnoseSummary } from './diagnose.mjs';
import { ensureFreshAuth, loadAuth, loginWithDeviceCode } from './auth.mjs';
import { listLoaderVersions, detectLoader as detectLoaderId, loaderLabelFor } from './loader.mjs';

// 默认用社区验证过的 client id（Prism Launcher 的），但允许用户换成自己的 Azure 应用
const MSA_CLIENT_ID = process.env.MCL_CLIENT_ID || 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';
import { searchProjects, analyzeProjects, installModsBatch, getProjectDetail, installShader, resolveModIds, assertModProjects } from './modrinth.mjs';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const CLI = path.join(ROOT, 'bin', 'mcl.mjs');

// ── 外观：主题 + 背景图（存 ~/.mcl/ui/，浏览器版和 DSH 插件共用）──
const UI_HOME = path.join(os.homedir(), '.mcl', 'ui');
// 拖进来的大文件先落到这里，识别后保留 12 小时，装完/过期再删
const UPLOAD_DIR = path.join(os.homedir(), '.mcl', 'uploads');
const UPLOAD_TTL = 12 * 60 * 60 * 1000;
function ensureUploadDir() {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}
function sweepUploads() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      const file = path.join(UPLOAD_DIR, name);
      try {
        if (now - fs.statSync(file).mtimeMs > UPLOAD_TTL) fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
function resolveUpload(id) {
  const name = String(id ?? '').trim();
  if (!/^[A-Za-z0-9._-]{4,120}$/.test(name)) return null;
  const file = path.join(UPLOAD_DIR, name);
  if (!isInside(UPLOAD_DIR, file) || !fs.existsSync(file)) return null;
  return file;
}
const APPEARANCE_FILE = path.join(UI_HOME, 'appearance.json');
const APPEARANCE_DEFAULTS = {
  theme: 'minimal',
  preset: 'dark',
  blur: 8,
  dim: 35,
  glass: 62,
  pos: 30,
  bgFile: '',
  bgMime: '',
  bgVersion: '',
  bgEnabled: true,
};
const APPEARANCE_THEMES = new Set(['minimal', 'deepsea', 'pixel']);
const APPEARANCE_PRESETS = new Set(['light-fog', 'deepsea', 'gradient', 'dark']);
const BG_MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function readAppearance() {
  let doc = {};
  try {
    doc = JSON.parse(fs.readFileSync(APPEARANCE_FILE, 'utf8')) || {};
  } catch {
    /* 没配置就是默认外观 */
  }
  const appear = { ...APPEARANCE_DEFAULTS, ...doc };
  if (!APPEARANCE_THEMES.has(appear.theme)) appear.theme = APPEARANCE_DEFAULTS.theme;
  if (!APPEARANCE_PRESETS.has(appear.preset)) appear.preset = APPEARANCE_DEFAULTS.preset;
  appear.blur = clampInt(appear.blur, 0, 30, APPEARANCE_DEFAULTS.blur);
  appear.dim = clampInt(appear.dim, 0, 80, APPEARANCE_DEFAULTS.dim);
  appear.glass = clampInt(appear.glass, 30, 95, APPEARANCE_DEFAULTS.glass);
  appear.pos = clampInt(appear.pos, 0, 100, APPEARANCE_DEFAULTS.pos);
  const bgPath = appear.bgFile ? path.join(UI_HOME, appear.bgFile) : '';
  const hasFile = Boolean(bgPath && fs.existsSync(bgPath));
  return {
    ...appear,
    hasFile,
    hasBg: hasFile && appear.bgEnabled !== false,
    bgPath,
  };
}

function writeAppearance(next) {
  fs.mkdirSync(UI_HOME, { recursive: true });
  const tmp = `${APPEARANCE_FILE}.tmp`;
  const { bgPath, hasBg, ...rest } = next;
  fs.writeFileSync(tmp, `${JSON.stringify(rest, null, 2)}\n`);
  fs.renameSync(tmp, APPEARANCE_FILE);
}

/** 读原始请求体（图片上传用） */
function readRawBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('图片太大（上限 16MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

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
  const name = String(id ?? '').trim();
  if (!name) return null;
  // 白名单：只认已登记的实例名，杜绝 `..\..\..` 这种拼路径（/api/logs、/api/diagnose 都走这里）
  if (!installedVersions().includes(name)) return null;
  try {
    const dir = findVersionDir(name);
    if (!dir || !fs.existsSync(dir)) return null;
    if (!isInside(VERSIONS_DIR, dir)) return null;
    return dir;
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

// PID 会被系统回收复用（昨天退出的 8780 今天可能是 svchost）：
// 光判断「PID 存在」不够，Windows 上还要确认它还是不是 java 进程。
const pidProbeCache = new Map();
const PID_PROBE_TTL = 3000;

async function probeProcess(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return { alive: false, image: null };
  const cached = pidProbeCache.get(value);
  if (cached && Date.now() - cached.at < PID_PROBE_TTL) return { alive: cached.alive, image: cached.image };

  let alive = isPidAlive(value);
  let image = null;
  if (alive && process.platform === 'win32') {
    const out = await runCommand('tasklist', ['/FI', `PID eq ${value}`, '/FO', 'CSV', '/NH']);
    const line = out
      .split(/\r?\n/)
      .map((row) => row.trim())
      .find((row) => row.startsWith('"'));
    if (!line) {
      alive = false;
    } else {
      image = (line.match(/^"([^"]+)"/)?.[1] ?? '').toLowerCase();
      if (!image.includes('java')) alive = false; // 被复用成别的进程了
    }
  }
  pidProbeCache.set(value, { at: Date.now(), alive, image });
  return { alive, image };
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
  try {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, {
      ...res.cors,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch {
    // 头已经发出去了（SSE 之类）就别再写，静默结束，避免 ERR_HTTP_HEADERS_SENT 逃逸
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
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

/** 在系统文件管理器里定位/打开路径（调用前必须校验过路径范围） */
function revealPath(target) {
  try {
    if (process.platform === 'win32') {
      const stat = fs.existsSync(target) ? fs.statSync(target) : null;
      if (stat?.isFile()) spawn('explorer.exe', ['/select,', target], { windowsHide: true });
      else spawn('explorer.exe', [target], { windowsHide: true });
    } else if (process.platform === 'darwin') {
      spawn('open', [target]);
    } else {
      spawn('xdg-open', [target]);
    }
  } catch {
    /* 打不开就算了，不影响接口返回 */
  }
}

export async function startGui({ port = 51730, open = true, openWindow = true } = {}) {
  const clients = new Set();
  const jobs = { install: null, launch: null };
  let remoteCache = null;
  let remoteAt = 0;
  // 最近一次崩溃修复报告（/api/crash/last、/api/state.lastCrash、重开页面时用）
  let lastCrash = null;

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
    const job = { id: `${kind}-${Date.now()}`, kind, meta, child, status: 'running', startedAt: Date.now() };
    jobs[kind] = job;
    if (kind === 'launch') {
      // 新一次启动开始：清掉上一次的崩溃状态，别让旧报告误导
      lastCrash = null;
      broadcast({ type: 'crash', report: null });
    }
    broadcast({ type: 'job', kind, status: 'running', meta });

    let lastPct = -1;
    const flush = (chunk) => {
      const text = chunk.toString();
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\r/g, '').replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
        if (!line) continue;
        if (line.startsWith('EXPORT:')) {
          job.meta = { ...(job.meta ?? {}), exportFile: line.slice('EXPORT:'.length).trim() };
          continue; // 这类内部标记不进日志
        }
        broadcast({ type: 'line', kind, line });
        // 从 CLI 的进度行里抽百分比：整百分点变化才推一次，别每行都广播
        const match = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
        if (!match) continue;
        const pct = Math.max(0, Math.min(100, Math.round(Number(match[1]))));
        if (!Number.isFinite(pct) || pct === lastPct) continue;
        lastPct = pct;
        const detail = line
          .replace(/[█░▓▒]/g, ' ')
          .replace(/^\s*\d+(?:\.\d+)?%\s*/, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        job.progress = { percent: pct, text: detail };
        broadcast({ type: 'job', kind, status: 'running', meta: job.meta, progress: job.progress });
      }
    };
    child.stdout.on('data', flush);
    child.stderr.on('data', flush);

    const done = (status) => {
      if (jobs[kind] !== job) return;
      job.status = status;
      jobs[kind] = null;
      // 从上传暂存文件装的任务：结束后把临时文件删掉
      if (job.meta?.stagedFile) {
        fs.promises.unlink(job.meta.stagedFile).catch(() => {});
      }
      if (job.meta?.invalidateJava) javaCache = null; // Java 装完后状态缓存要刷新
      invalidateVersions(); // 装完/启动完版本列表可能变了，别让缓存拖着
      broadcast({ type: 'job', kind, status, meta: job.meta });
      broadcast({ type: 'refresh' });
    };

    child.on('close', (code) => {
      done(code === 0 ? 'done' : 'error');
      if (kind === 'launch') handleLaunchFinished(job, code);
    });
    child.on('error', () => {
      done('error');
      if (kind === 'launch') handleLaunchFinished(job, -1);
    });
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

  /**
   * 生成崩溃修复报告并缓存；手动诊断和启动失败自动诊断共用。
   * 返回报告；实例不存在返回 null。
   */
  function analyzeCrash(instance, options = {}) {
    const dir = safeVersionDir(instance);
    if (!dir) return null;
    const report = buildFixReport(instance, {
      dir,
      exitCode: options.exitCode,
      launchedAt: options.launchedAt,
      auto: Boolean(options.auto),
      java: { available: cachedJava() },
    });
    if (report.crashed || report.causes.length > 0) {
      lastCrash = report;
      if (options.broadcast) broadcast({ type: 'crash', report });
    }
    return report;
  }

  /** 启动任务结束后：只有异常退出 / 有崩溃痕迹才自动生成修复报告并广播 */
  function handleLaunchFinished(job, cliExitCode) {
    const instance = job.meta?.version;
    if (!instance) return;
    // 等启动器把运行时快照和日志 flush 完，再分析
    setTimeout(() => {
      try {
        const dir = safeVersionDir(instance);
        if (!dir) return;
        const detected = detectCrash(dir, { launchedAt: job.startedAt, exitCode: cliExitCode });
        const failed = typeof cliExitCode === 'number' && cliExitCode !== 0;
        if (!detected.crashed && !failed) return;
        analyzeCrash(instance, {
          exitCode: detected.exitCode ?? cliExitCode,
          launchedAt: job.startedAt,
          auto: true,
          broadcast: true,
        });
      } catch {
        /* 自动诊断失败不能影响服务进程 */
      }
    }, 700);
  }

  let lastLaunched = null;
  let scannedRuntime = false;
  let authFlow = false; // 同一时间只允许一个设备码流程

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
    // stopped:true 是启动器亲眼看到退出后写的，优先级最高；没标记再验 PID 身份
    const alive = record.stopped ? false : (await probeProcess(record.pid)).alive;
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
      state: alive ? 'running' : record.stopped ? 'exited' : 'unknown',
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
      // 当前后台任务（安装/启动）的进度，界面用来画进度条
      job: (() => {
        const active = jobs.install || jobs.launch;
        if (!active) return null;
        return { kind: active.kind, progress: active.progress ?? null, meta: active.meta ?? null };
      })(),
      // 命令行启动的游戏没有 job，但 java 进程还活着，也算运行中
      running: Boolean(jobs.launch) || Boolean(runtime?.alive),
      installing: Boolean(jobs.install),
      installTarget: jobs.install?.meta?.version ?? null,
      // 最近一次崩溃修复报告（重新打开界面 / DSH 浮窗重连时用）
      lastCrash: crashSummary(lastCrash),
    };
  }

  let currentUrl = '';

  /**
   * 单个请求的处理。任何异常都不许逃逸：
   * createServer 不消费 handler 返回的 Promise，逃逸出去就是未捕获拒绝，Node/DSH 会直接退出。
   */
  async function handleRequest(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('bad request target');
      return;
    }
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
      if (route === '/app.js' || route === '/appearance.js' || route === '/style.css') {
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
        // 这里只需要"在不在跑"：stopped 优先，再用 tasklist 确认 PID 没被复用
        const record = readRuntimeRecord(dir);
        const alive = record ? !record.stopped && (await probeProcess(record.pid)).alive : false;
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
        if (!['fabric', 'quilt', 'forge', 'neoforge'].includes(loader)) {
          sendJson(res, 400, { error: 'loader 只能是 fabric / quilt / forge / neoforge' });
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
          label: `安装 ${{ fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }[loader]} → ${mc}`,
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      // ── 外观配置（主题 / 背景样式 / 滑杆）──
      if (route === '/api/ui/appearance') {
        if (req.method === 'GET') {
          const { bgPath, ...appear } = readAppearance();
          sendJson(res, 200, appear);
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const current = readAppearance();
          const next = { ...current };
          if (APPEARANCE_THEMES.has(String(body.theme))) next.theme = String(body.theme);
          if (APPEARANCE_PRESETS.has(String(body.preset))) next.preset = String(body.preset);
          if (body.blur !== undefined) next.blur = clampInt(body.blur, 0, 30, next.blur);
          if (body.dim !== undefined) next.dim = clampInt(body.dim, 0, 80, next.dim);
          if (body.glass !== undefined) next.glass = clampInt(body.glass, 30, 95, next.glass);
          if (body.pos !== undefined) next.pos = clampInt(body.pos, 0, 100, next.pos);
          if (body.bgEnabled !== undefined) next.bgEnabled = Boolean(body.bgEnabled);
          writeAppearance(next);
          const { bgPath, ...appear } = readAppearance();
          sendJson(res, 200, { ok: true, ...appear });
          return;
        }
      }

      // ── 背景图（上传 / 读取 / 删除）──
      if (route === '/api/ui/background') {
        if (req.method === 'GET') {
          const appear = readAppearance();
          if (!appear.hasBg) {
            sendJson(res, 404, { error: '还没有背景图' });
            return;
          }
          try {
            const buf = fs.readFileSync(appear.bgPath);
            res.writeHead(200, {
              ...res.cors,
              'Content-Type': appear.bgMime || 'image/jpeg',
              'Cache-Control': 'no-store',
              'Content-Length': buf.length,
            });
            res.end(buf);
          } catch {
            sendJson(res, 404, { error: '背景图读不到' });
          }
          return;
        }
        if (req.method === 'POST') {
          try {
            const buf = await readRawBody(req);
            const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            const ext = BG_MIME_EXT[mime];
            if (!ext) {
              sendJson(res, 415, { error: '只支持 jpg / png / webp / gif' });
              return;
            }
            if (buf.length < 64) {
              sendJson(res, 400, { error: '图片内容是空的' });
              return;
            }
            fs.mkdirSync(UI_HOME, { recursive: true });
            const bgFile = `background.${ext}`;
            fs.writeFileSync(path.join(UI_HOME, bgFile), buf);
            // 换扩展名时把旧图删掉
            const current = readAppearance();
            if (current.bgFile && current.bgFile !== bgFile) {
              try {
                fs.rmSync(path.join(UI_HOME, current.bgFile), { force: true });
              } catch {
                /* ignore */
              }
            }
            writeAppearance({ ...current, bgFile, bgMime: mime, bgVersion: sha1Hex(buf).slice(0, 12), bgEnabled: true });
            const { bgPath, ...appear } = readAppearance();
            sendJson(res, 200, { ok: true, version: appear.bgVersion, bytes: buf.length });
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) });
          }
          return;
        }
        if (req.method === 'DELETE') {
          const current = readAppearance();
          if (current.bgFile) {
            try {
              fs.rmSync(path.join(UI_HOME, current.bgFile), { force: true });
            } catch {
              /* ignore */
            }
          }
          writeAppearance({ ...current, bgFile: '', bgMime: '', bgVersion: '' });
          sendJson(res, 200, { ok: true });
          return;
        }
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
        if (body.auth && (await ensureFreshAuth())) args.push('--auth');
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
          const probe = record?.pid ? await probeProcess(record.pid) : { alive: false };
          if (record?.pid && !record.stopped && probe.alive) {
            try {
              if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', String(record.pid), '/T', '/F'], { windowsHide: true });
              } else {
                process.kill(record.pid, 'SIGTERM');
              }
              stopped = true;
              pidProbeCache.set(Number(record.pid), { at: Date.now(), alive: false, image: null });
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
          // 不回显同目录的文件名（避免被当成目录枚举接口）
          sendJson(res, 400, { error: `文件不存在：${target}` });
          return;
        }
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
          sendJson(res, 400, { error: '这是一个目录，请选文件' });
          return;
        }
        const result = inspectArchiveFile(target, path.basename(target));
        sendJson(res, 200, result);
        return;
      }

      if (route === '/api/mod/inspect-file' && req.method === 'POST') {
        // 几百 MB 的整合包走原始字节流：不经过 base64/JSON，也不受 readBody 的 96MB 限制
        const rawName = String(req.headers['x-file-name'] ?? 'upload.zip');
        let name = 'upload.zip';
        try {
          name = decodeURIComponent(rawName) || 'upload.zip';
        } catch {
          name = 'upload.zip';
        }
        name = path.basename(name).slice(0, 160) || 'upload.zip';
        ensureUploadDir();
        sweepUploads();
        const uploadId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}.bin`;
        const tmp = path.join(UPLOAD_DIR, uploadId);
        const discard = String(req.headers['x-discard-upload'] ?? '') === '1';
        const MAX = 4 * 1024 * 1024 * 1024;
        let size = 0;
        try {
          await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(tmp);
            let done = false;
            const fail = (error) => {
              if (done) return;
              done = true;
              try {
                out.destroy();
              } catch {
                /* ignore */
              }
              reject(error);
            };
            req.on('data', (chunk) => {
              size += chunk.length;
              if (size > MAX) {
                req.destroy();
                fail(new Error('文件太大（超过 4GB）'));
              }
            });
            req.on('aborted', () => fail(new Error('上传中断')));
            req.on('error', fail);
            out.on('error', fail);
            out.on('finish', () => {
              if (done) return;
              done = true;
              resolve();
            });
            req.pipe(out);
          });
          const result = inspectArchiveFile(tmp, name);
          sendJson(res, 200, { ...result, uploadId: discard ? null : uploadId, uploadName: name });
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        } finally {
          if (discard) fs.promises.unlink(tmp).catch(() => {});
        }
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

      if (route === '/api/open-url' && req.method === 'POST') {
        // 给插件打开微软设备码登录页用：只放行 https 的微软域名，避免变成任意 URL 打开器
        const body = await readBody(req);
        let target = null;
        try {
          target = new URL(String(body.url ?? ''));
        } catch {
          target = null;
        }
        const host = target?.hostname?.toLowerCase() ?? '';
        const allowed =
          target?.protocol === 'https:' &&
          (host === 'microsoft.com' ||
            host.endsWith('.microsoft.com') ||
            host.endsWith('.microsoftonline.com') ||
            host.endsWith('.microsoftlive.com'));
        if (!allowed) {
          sendJson(res, 400, { error: '只允许打开微软登录相关页面' });
          return;
        }
        openBrowser(target.toString(), false);
        sendJson(res, 200, { ok: true });
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
        // 整合包/光影不能走模组安装（否则会把 .mrpack 下进 mods/），在这里就给出明确错误
        try {
          await assertModProjects([projectId]);
        } catch (error) {
          sendJson(res, 400, { error: error.message });
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
        // 同 /api/mod/install：整合包/光影不允许走批量模组安装
        try {
          await assertModProjects(projectIds);
        } catch (error) {
          sendJson(res, 400, { error: error.message });
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

      if (route === '/api/instance/export' && req.method === 'POST') {
        const body = await readBody(req);
        const instance = String(body.instance ?? '').trim();
        if (!instance || !safeVersionDir(instance)) {
          sendJson(res, 404, { error: `找不到实例 ${instance}` });
          return;
        }
        const includeSaves = Boolean(body.includeSaves);
        try {
          runJob('install', ['export', instance, ...(includeSaves ? ['--include-saves'] : [])], {
            version: `导出 ${instance}`,
            label: `导出实例 → ${instance}`,
            exporting: true,
          });
        } catch (jobError) {
          sendJson(res, 409, { error: jobError.message });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (route === '/api/instance/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const instance = String(body.instance ?? '').trim();
        const dir = safeVersionDir(instance);
        if (!dir) {
          sendJson(res, 404, { error: `找不到实例 ${instance}` });
          return;
        }
        if (jobs.launch?.meta?.version === instance) {
          sendJson(res, 409, { error: '这个实例正在运行，先停止再删除' });
          return;
        }
        try {
          const record = readRuntimeRecord(dir);
          if (record && !record.stopped && (await probeProcess(record.pid)).alive) {
            sendJson(res, 409, { error: '这个实例的游戏进程还活着，先停止再删除' });
            return;
          }
        } catch {
          /* 探测失败不阻塞删除 */
        }
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          invalidateVersions();
          broadcast({ type: 'refresh' });
          sendJson(res, 200, { ok: true, message: `已删除 ${instance}` });
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
        return;
      }

      if (route.startsWith('/api/exports/')) {
        const name = decodeURIComponent(route.slice('/api/exports/'.length));
        let target = null;
        try {
          target = safeJoin(EXPORTS_DIR, name);
        } catch {
          target = null;
        }
        if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          sendJson(res, 404, { error: '导出文件不存在' });
          return;
        }
        res.writeHead(200, {
          ...(res.cors ?? {}),
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Content-Length': fs.statSync(target).size,
        });
        fs.createReadStream(target).pipe(res);
        return;
      }

      if (route === '/api/mod/import' && req.method === 'POST') {
        const body = await readBody(req);
        let target = String(body.path ?? '').trim();
        let stagedFile = '';
        if (!target && body.uploadId) {
          const file = resolveUpload(body.uploadId);
          if (!file) {
            sendJson(res, 400, { error: '上传的文件已过期，请重新拖入或选择' });
            return;
          }
          target = file;
          stagedFile = file;
        }
        if (!target) {
          sendJson(res, 400, { error: '缺少文件路径' });
          return;
        }
        runJob('install', ['import', target], { version: '导入整合包', stagedFile });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (route === '/api/pack/import-local' && req.method === 'POST') {
        const body = await readBody(req);
        let target = String(body.path ?? '').trim();
        let stagedFile = '';
        if (!target && body.uploadId) {
          const file = resolveUpload(body.uploadId);
          if (!file) {
            sendJson(res, 400, { error: '上传的文件已过期，请重新拖入或选择' });
            return;
          }
          target = file;
          stagedFile = file;
        }
        if (!target) {
          sendJson(res, 400, { error: '缺少整合包路径' });
          return;
        }
        const name = String(body.name ?? '').trim();
        runJob('install', ['importpack', target, ...(name ? ['--name', name] : [])], {
          version: name || path.basename(target),
          stagedFile,
        });
        sendJson(res, 200, { ok: true, name });
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
        // 只诊断已登记的实例（diagnose 会读该目录下的日志，别让它指向任意路径）
        if (!safeVersionDir(instance)) {
          sendJson(res, 404, { error: `找不到实例 ${instance}` });
          return;
        }
        try {
          sendJson(res, 200, diagnoseSummary(instance));
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
        return;
      }

      // ── 崩溃修复助手：结构化报告 + 可执行修复动作 ──
      if (route === '/api/crashfix' && req.method === 'POST') {
        const body = await readBody(req);
        const instance = String(body.instance ?? activeInstance() ?? '').trim();
        if (!instance) {
          sendJson(res, 400, { error: '缺少实例名' });
          return;
        }
        try {
          const report = analyzeCrash(instance, {});
          if (!report) {
            sendJson(res, 404, { error: `找不到实例 ${instance}` });
            return;
          }
          sendJson(res, 200, { report });
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
        return;
      }

      if (route === '/api/crash/last') {
        sendJson(res, 200, { report: lastCrash });
        return;
      }

      if (route === '/api/crashfix/apply' && req.method === 'POST') {
        const body = await readBody(req);
        const instance = String(body.instance ?? '').trim();
        const kind = String(body.kind ?? '').trim();
        const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
        const dir = safeVersionDir(instance);
        if (!dir) {
          sendJson(res, 404, { error: `找不到实例 ${instance}` });
          return;
        }
        try {
          if (kind === 'disable-mod' || kind === 'enable-mod' || kind === 'remove-mod') {
            sendJson(res, 200, applyModAction(dir, kind, payload));
            return;
          }
          if (kind === 'open-report' || kind === 'open-log') {
            const raw = String(payload.path ?? '').trim();
            const target = raw ? path.resolve(raw) : path.join(dir, 'logs');
            if (!isInside(GAME_DIR, target) && !isInside(dir, target)) {
              sendJson(res, 400, { error: '拒绝打开实例目录之外的位置' });
              return;
            }
            if (!fs.existsSync(target)) {
              sendJson(res, 404, { error: `路径不存在：${target}` });
              return;
            }
            revealPath(target);
            sendJson(res, 200, { ok: true, message: `已在资源管理器打开：${target}` });
            return;
          }
          if (kind === 'install-java') {
            const major = Number(payload.major);
            if (!Number.isFinite(major) || major < 8 || major > 25) {
              sendJson(res, 400, { error: 'Java 大版本不合法' });
              return;
            }
            // 下载 Java 可能要几分钟：别挂在请求里，改成后台任务（进度走 SSE）
            try {
              runJob('install', ['java-install', String(major)], {
                version: `Java ${major}`,
                label: `安装 Java ${major}`,
                invalidateJava: true,
              });
            } catch (jobError) {
              sendJson(res, 409, { error: jobError.message });
              return;
            }
            sendJson(res, 200, {
              ok: true,
              running: true,
              message: `已开始下载 Java ${major}，进度看安装日志`,
            });
            return;
          }
          // 调内存 / 重试启动 / 去模组库搜索这些动作归界面执行
          sendJson(res, 200, { ok: false, needsClient: true, message: `动作 ${kind} 由界面处理` });
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
        return;
      }

      if (route === '/api/mods/toggle' && req.method === 'POST') {
        const body = await readBody(req);
        const instance = String(body.instance ?? '').trim();
        const dir = safeVersionDir(instance);
        if (!dir) {
          sendJson(res, 404, { error: `找不到实例 ${instance}` });
          return;
        }
        try {
          const kind = body.enable ? 'enable-mod' : 'disable-mod';
          sendJson(res, 200, applyModAction(dir, kind, { jar: body.jar }));
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
        return;
      }

      if (route === '/api/reveal' && req.method === 'POST') {
        const body = await readBody(req);
        const raw = String(body.path ?? '').trim();
        const target = raw ? path.resolve(raw) : '';
        if (!target || (!isInside(GAME_DIR, target) && !isInside(path.join(os.homedir(), '.mcl'), target))) {
          sendJson(res, 400, { error: '拒绝打开该路径' });
          return;
        }
        if (!fs.existsSync(target)) {
          sendJson(res, 404, { error: '路径不存在' });
          return;
        }
        revealPath(target);
        sendJson(res, 200, { ok: true });
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
        if (authFlow) {
          sendJson(res, 409, { error: '上一次登录还在进行中，等它超时或先取消' });
          return;
        }
        authFlow = true;
        let timer;
        try {
          let resolveCode;
          let rejectCode;
          // 设备码请求本身也可能失败（断网 / client id 非法），必须 reject 掉，否则这个请求永远挂着
          const codeReady = new Promise((resolve, reject) => {
            resolveCode = resolve;
            rejectCode = reject;
          });
          timer = setTimeout(() => rejectCode(new Error('申请设备码超时')), 30_000);
          // 后台跑完整流程，界面先拿设备码
          loginWithDeviceCode({
            clientId,
            onDeviceCode: (info) => resolveCode(info),
          })
            .then((account) => broadcast({ type: 'auth', status: 'ok', name: account.name, uuid: account.uuid }))
            .catch((error) => {
              rejectCode(error); // 还没拿到码就失败了 → 让 HTTP 请求立刻报错
              broadcast({ type: 'auth', status: 'error', message: error.message });
            })
            .finally(() => {
              authFlow = false;
            });
          const info = await codeReady;
          sendJson(res, 200, { ...info, clientId });
        } catch (error) {
          authFlow = false;
          sendJson(res, 500, { error: error.message });
        } finally {
          if (timer) clearTimeout(timer);
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
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      try {
        if (!res.headersSent) sendJson(res, 500, { error: error?.message ?? 'internal error' });
        else res.end();
      } catch {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
    });
  });

  // 畸形请求行（绝对形式 target、超长头等）：直接断开，别让它顶到默认错误路径
  server.on('clientError', (_error, socket) => {
    try {
      socket.destroy();
    } catch {
      /* ignore */
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
