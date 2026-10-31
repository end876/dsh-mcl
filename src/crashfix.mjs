import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findVersionDir, readLocalVersionJson } from './install.mjs';
import { listJava } from './java.mjs';
import { scanInstance } from './dupes.mjs';
import { inspectArchive } from './mods.mjs';
import { detectLoader, loaderLabelFor } from './loader.mjs';
import { ensureDir, isInside } from './paths.mjs';

/**
 * 崩溃修复助手（Crash Fix Assistant）。
 *
 * 目标：游戏异常退出后，把 crash-report / latest.log / launcher-console.log /
 * 运行时快照 / mods 目录一起读出来，归一成「结论 + 原因 + 可执行修复动作」，
 * 浏览器界面和 DSH 插件直接渲染，用户点一下就能修（禁 mod / 调内存 / 装 Java…）。
 *
 * 这里坚持「先规则、再给动作」：每条规则都必须说明证据，且尽量产出真的能执行的
 * Fix 对象，而不是一段让用户自己猜的散文。零第三方依赖。
 */

const CRASH_DIR_NAME = 'crash-reports';
const RUNTIME_NAME = '.mcl-runtime.json';
const MAX_TEXT = 256 * 1024;
const MAX_EVIDENCE = 6;
const MAX_EVIDENCE_CHARS = 300;

/* ────────────────────────── 基础读写 ────────────────────────── */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function statOf(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function existsFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function readHead(file, bytes = MAX_TEXT) {
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0) return '';
    const length = Math.min(bytes, stat.size);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, 0);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readTail(file, bytes = MAX_TEXT) {
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0) return '';
    const length = Math.min(bytes, stat.size);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, stat.size - length);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** 目录里 mtime 最新的文件（按扩展名过滤） */
function newestFile(dir, exts) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (exts && !exts.some((ext) => entry.name.toLowerCase().endsWith(ext))) continue;
    const file = path.join(dir, entry.name);
    const stat = statOf(file);
    if (!stat) continue;
    if (!best || stat.mtimeMs > best.stat.mtimeMs) best = { file, stat };
  }
  return best;
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

/** 把日志文本切成「值得读」的行（去掉空行/纯进度行），最多留 40000 行防爆内存 */
function toLines(text) {
  const out = [];
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    out.push(line);
    if (out.length >= 40000) break;
  }
  return out;
}

function pickEvidence(lines, patterns, max = MAX_EVIDENCE) {
  const out = [];
  for (const line of lines) {
    if (!patterns.some((pattern) => pattern.test(line))) continue;
    out.push(line.trim().slice(0, MAX_EVIDENCE_CHARS));
    if (out.length >= max) break;
  }
  return out;
}

function findFirst(lines, patterns) {
  for (const line of lines) if (patterns.some((pattern) => pattern.test(line))) return line.trim().slice(0, 400);
  return null;
}

/* ────────────────────────── 实例上下文 ────────────────────────── */

function parseHeapGb(value) {
  const match = String(value ?? '').match(/(\d+(?:\.\d+)?)\s*([gkm])/i);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return null;
  const unit = match[2].toLowerCase();
  return unit === 'g' ? num : unit === 'm' ? num / 1024 : num / 1024 / 1024;
}

function memoryStatus(runtime) {
  const totalGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const freeGb = Math.round((os.freemem() / 1024 ** 3) * 10) / 10;
  const xmx = typeof runtime?.memory === 'string' ? runtime.memory : null;
  const currentGb = parseHeapGb(xmx);
  // 启动面板的安全上限：可用内存 - 1G（和浏览器界面一致）
  const safeMaxGb = Math.max(1, Math.floor(freeGb) - 1);
  return { xmx, currentGb, totalGb, freeGb, safeMaxGb };
}

/** 建议的堆大小：至少 4G，比当前多 2G，但不超过安全上限 / 12G */
function suggestMemory(memory) {
  const current = memory.currentGb ?? 2;
  let target = Math.min(12, Math.max(current + 2, 4));
  if (target > memory.safeMaxGb) target = memory.safeMaxGb;
  if (target <= current + 0.5) return null;
  return Math.round(target);
}

function versionInfo(instance, dir) {
  const json = readLocalVersionJson(instance) ?? {};
  let mc = null;
  if (/^\d+\.\d+(\.\d+)?$/.test(String(instance))) mc = String(instance);
  let cursor = json;
  let javaMajor = 8;
  let loaderId = detectLoader(json);
  for (let guard = 0; cursor && guard < 10; guard += 1) {
    if (cursor.javaVersion?.majorVersion) javaMajor = Number(cursor.javaVersion.majorVersion) || javaMajor;
    const declared = cursor.clientVersion ?? cursor.inheritsFrom;
    if (!mc && declared && /^\d+\.\d+(\.\d+)?$/.test(String(declared))) mc = String(declared);
    if (!loaderId) loaderId = detectLoader(cursor);
    if (!cursor.inheritsFrom) break;
    cursor = readLocalVersionJson(cursor.inheritsFrom);
  }
  return {
    dir,
    id: json.id ?? instance,
    mc: mc ?? instance,
    type: json.type ?? 'release',
    mainClass: json.mainClass ?? null,
    loaderId: loaderId ?? null,
    loader: loaderId ? loaderLabelFor(loaderId) : '原版',
    javaMajor,
  };
}

function normalizeJava(input) {
  const rawList = Array.isArray(input) ? input : Array.isArray(input?.available) ? input.available : null;
  const available = (rawList ?? safeListJava())
    .map((item) => ({ major: Number(item?.major) || 0, raw: String(item?.raw ?? ''), exe: String(item?.exe ?? '') }))
    .filter((item) => item.major > 0)
    .sort((a, b) => a.major - b.major);
  return { available };
}

function safeListJava() {
  try {
    return listJava();
  } catch {
    return [];
  }
}

/* ────────────────────────── 崩溃检测 ────────────────────────── */

// 真正的崩溃特征（注意：launcher-console.log 是跨次启动追加的，不能拿整份文件当证据；
// 另外 "Could not authorize you against Realms server: java.lang.RuntimeException" 这类
// 是 Realms 的 INFO 噪声，匹配到了会误报）
const CRASH_SIGNATURES = [
  /crash report/i,
  /Exception in thread/i,
  /java\.lang\.OutOfMemoryError/i,
  /#\s*EXCEPTION_ACCESS_VIOLATION/i,
  /A fatal error has been detected/i,
  /Error: A fatal exception has occurred/i,
];

/** 只看日志最后 40 行：崩溃堆栈总在末尾，老日志里的历史报错不算 */
function hasCrashTail(text) {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-40);
  return lines.some((line) => CRASH_SIGNATURES.some((re) => re.test(line)));
}

/**
 * 判断「这次启动是不是崩了」。只看窗口期内新产生的日志/崩溃报告，避免拿上周的崩溃当今天的问题。
 * @param {string} dir 实例目录
 * @param {{launchedAt?: number|string, exitCode?: number}} options
 */
export function detectCrash(dir, options = {}) {
  const runtime = readJson(path.join(dir, RUNTIME_NAME));
  const launchedMs = options.launchedAt
    ? typeof options.launchedAt === 'string'
      ? Date.parse(options.launchedAt)
      : options.launchedAt
    : runtime?.startedAt
      ? Date.parse(runtime.startedAt)
      : null;
  const windowStart = (Number.isFinite(launchedMs) ? launchedMs : 0) - 60_000;

  const crash = newestFile(path.join(dir, CRASH_DIR_NAME), ['.txt', '.log']);
  const log = statOf(path.join(dir, 'logs', 'latest.log'));
  const consoleLog = statOf(path.join(dir, 'launcher-console.log'));
  const fresh = (stat) => Boolean(stat && (!windowStart || stat.mtimeMs >= windowStart));

  const runtimeExit = typeof runtime?.exitCode === 'number' ? runtime.exitCode : null;
  const cliExit = typeof options.exitCode === 'number' ? options.exitCode : null;
  // 真实退出码优先用运行时快照（CLI 的退出码只表示“启动器视角成功与否”）
  const exitCode = runtimeExit ?? cliExit;

  const logTail = fresh(log) ? readTail(path.join(dir, 'logs', 'latest.log'), 60 * 1024) : '';
  const consoleTail = fresh(consoleLog) ? readTail(path.join(dir, 'launcher-console.log'), 60 * 1024) : '';

  // 判定顺序：真实退出码 > 新崩溃报告 > 启动器退出码 > （无退出信息时）日志尾部特征
  let reason = null;
  if (runtimeExit !== null && runtimeExit !== 0) reason = 'exit-code';
  else if (crash && crash.stat.mtimeMs >= (Number.isFinite(launchedMs) ? launchedMs - 5000 : 0)) reason = 'crash-report';
  else if (cliExit !== null && cliExit !== 0) reason = 'exit-code';
  else if (runtimeExit === null && cliExit === null && hasCrashTail(`${logTail}\n${consoleTail}`)) reason = 'log-signature';

  return {
    crashed: Boolean(reason),
    reason,
    exitCode,
    gameExitCode: runtimeExit,
    cliExitCode: cliExit,
    crashReport: crash?.file ?? null,
    crashReportAt: crash?.stat.mtimeMs ?? null,
    logFile: log ? path.join(dir, 'logs', 'latest.log') : null,
    logAt: log?.mtimeMs ?? null,
    launcherConsole: consoleLog ? path.join(dir, 'launcher-console.log') : null,
    launcherConsoleAt: consoleLog?.mtimeMs ?? null,
    startedAt: runtime?.startedAt ?? null,
    runtime,
  };
}

/* ────────────────────────── mods 盘点 ────────────────────────── */

/**
 * 扫实例 mods 目录：文件名 + mtime + （尽量）jar 里的 id/name/version。
 * 大 jar 跳过元数据解析，避免崩溃分析把内存再吃爆。
 */
function listMods(dir) {
  const modsDir = path.join(dir, 'mods');
  let names = [];
  try {
    names = fs.readdirSync(modsDir).filter((name) => /\.jar(\.disabled)?$/i.test(name));
  } catch {
    return { modsDir, mods: [] };
  }
  const mods = [];
  let metaBudget = 80 * 1024 * 1024;
  for (const file of names) {
    const full = path.join(modsDir, file);
    const stat = statOf(full);
    if (!stat) continue;
    const entry = {
      file,
      disabled: /\.disabled$/i.test(file),
      size: stat.size,
      mtime: stat.mtimeMs,
      id: null,
      name: null,
      version: null,
    };
    if (!entry.disabled && stat.size <= 24 * 1024 * 1024 && metaBudget >= stat.size) {
      try {
        const buf = fs.readFileSync(full);
        const meta = inspectArchive(buf, file);
        entry.id = meta.id || null;
        entry.name = meta.name || null;
        entry.version = meta.version ? String(meta.version) : null;
        metaBudget -= stat.size;
      } catch {
        /* 读不出元数据没关系，文件信息足够给建议 */
      }
    }
    mods.push(entry);
  }
  mods.sort((a, b) => b.mtime - a.mtime);
  return { modsDir, mods };
}

function recentMods(mods, count = 4) {
  return mods.filter((mod) => !mod.disabled).slice(0, count);
}

/* ────────────────────────── Fix 构造 ────────────────────────── */

let fixSeq = 0;

function mkFix(kind, label, payload = {}, description = '') {
  return {
    id: `fix-${Date.now().toString(36)}-${++fixSeq}`,
    kind,
    label,
    description,
    executable: kind !== 'advisory',
    payload,
  };
}

/* ────────────────────────── 原因规则 ────────────────────────── */

const RULES = [
  {
    id: 'oom',
    title: '内存不足（Java 堆耗尽）',
    severity: 'fatal',
    confidence: 0.95,
    patterns: [
      /OutOfMemoryError/i,
      /Java heap space/i,
      /insufficient (memory|heap)/i,
      /GC overhead limit exceeded/i,
      /Could not reserve enough space for .*object heap/i,
      /unable to create (new )?native thread/i,
      /The system is out of physical RAM/i,
    ],
    build(ctx) {
      const evidence = pickEvidence(ctx.lines, this.patterns);
      if (evidence.length === 0) return null;
      const fixes = [];
      const target = suggestMemory(ctx.memory);
      if (target) {
        fixes.push(
          mkFix(
            'set-memory',
            `把内存调到 ${target}G 后重启`,
            { memory: `${target}G` },
            `当前 -Xmx${ctx.memory.xmx ?? '未知'}，本机可用 ${ctx.memory.freeGb}G`,
          ),
        );
      } else {
        fixes.push(
          mkFix(
            'advisory',
            '可用内存不够再往上调了，先关掉占内存的程序再试',
            {},
            `当前 -Xmx${ctx.memory.xmx ?? '未知'}，本机可用仅 ${ctx.memory.freeGb}G`,
          ),
        );
      }
      fixes.push(mkFix('advisory', '确认用的是 64 位 Java', {}, '32 位 Java 堆上限约 1.5G，大整合包必崩'));
      if (ctx.memory.currentGb && ctx.memory.currentGb >= 2) {
        fixes.push(mkFix('advisory', '给整合包留够内存：300+ mod 建议 6~8G', {}, '但不要超过「可用内存 - 1G」'));
      }
      return {
        explanation: `游戏申请的内存已经被用完（-Xmx${ctx.memory.xmx ?? '未知'}）。大整合包、光影、区块加载过远都会推高内存占用。`,
        evidence,
        fixes,
      };
    },
  },
  {
    id: 'duplicate-mod',
    title: '存在重复模组（同名不同版本）',
    severity: 'fatal',
    confidence: 0.9,
    patterns: [/DuplicateModsFoundException/i, /duplicate mods/i, /multiple versions of .* found/i, /Duplicate key/i],
    build(ctx) {
      const evidence = pickEvidence(ctx.lines, this.patterns);
      const groups = ctx.dupes.groups ?? [];
      if (evidence.length === 0 && groups.length === 0) return null;
      const fixes = [];
      for (const group of groups.slice(0, 5)) {
        const sorted = group.files
          .map((file) => ({ file, mtime: ctx.modMtime(file) }))
          .sort((a, b) => b.mtime - a.mtime);
        for (const old of sorted.slice(1, 3)) {
          fixes.push(
            mkFix('disable-mod', `禁用旧版本 ${old.file}`, { jar: old.file }, `保留最新的 ${sorted[0].file}`),
          );
        }
      }
      if (fixes.length === 0) {
        fixes.push(mkFix('advisory', '用 `mcl check <实例>` 找出重复 mod 后删旧版', {}, '同名不同版本会抢同一个注册项'));
      }
      return {
        explanation: '同一个 mod 放了两个版本（或两个功能重复的 mod），加载器在注册阶段直接失败。',
        evidence: evidence.length ? evidence : groups.slice(0, 3).map((group) => `重复：${group.files.join(' / ')}`),
        fixes,
      };
    },
  },
  {
    id: 'mixin-conflict',
    title: '模组 Mixin 冲突',
    severity: 'fatal',
    confidence: 0.8,
    patterns: [
      /Mixin apply failed/i,
      /MixinTransformerError/i,
      /InvalidMixinException/i,
      /Mixin apply conflict/i,
      /mixin.*(?:failed|error)/i,
    ],
    build(ctx) {
      const evidence = pickEvidence(ctx.lines, this.patterns);
      if (evidence.length === 0) return null;
      const fixes = [];
      for (const mod of recentMods(ctx.mods, 3)) {
        fixes.push(mkFix('disable-mod', `先禁用最近添加的 ${mod.file}`, { jar: mod.file }, '按添加时间倒序，最新加的最可疑'));
      }
      fixes.push(mkFix('advisory', '还有问题就用二分法：每次停用一半 mod 缩小范围', {}, '特别是两个功能重复的优化 mod'));
      return {
        explanation:
          '两个模组同时改写了同一个游戏类（Mixin 注入冲突）。常见于同类优化/UI 模组，或模组与当前游戏版本不匹配。',
        evidence,
        fixes,
      };
    },
  },
  {
    id: 'missing-dep',
    title: '缺少前置模组',
    severity: 'fatal',
    confidence: 0.85,
    patterns: [
      /Missing or unsupported mandatory dependencies/i,
      /requires .* which is missing/i,
      /Missing dependencies/i,
      /ModResolutionException/i,
      /Incompatible mod set/i,
      /requires any version of/i,
    ],
    build(ctx) {
      const evidence = pickEvidence(ctx.lines, this.patterns);
      const ids = extractMissingIds(ctx.lines);
      if (evidence.length === 0 && ids.length === 0) return null;
      const fixes = [];
      for (const id of ids.slice(0, 3)) {
        fixes.push(
          mkFix('install-mod', `安装前置 ${id}`, { query: id, mc: ctx.version.mc }, '跳到模组库搜索并一键安装'),
        );
      }
      if (fixes.length === 0) {
        fixes.push(mkFix('advisory', '按崩溃报告里提到的 mod id 去模组库补装前置', {}, '批量安装时会自动补齐前置'));
      }
      return {
        explanation: '某个模组依赖的前置库/API 没有安装，或者装的前置版本不满足要求。',
        evidence: evidence.length ? evidence : ids.map((id) => `缺少前置：${id}`),
        fixes,
      };
    },
  },
  {
    id: 'java-version',
    title: 'Java 版本不匹配',
    severity: 'fatal',
    confidence: 0.9,
    patterns: [
      /UnsupportedClassVersionError/i,
      /class file version \d+/i,
      /requires Java \d+/i,
      /has been compiled by a more recent version/i,
      /Unsupported Java/i,
    ],
    build(ctx) {
      const evidence = pickEvidence(ctx.lines, this.patterns);
      if (evidence.length === 0) return null;
      const required = detectRequiredJava(ctx.lines) ?? ctx.version.javaMajor;
      const available = ctx.java.available.map((item) => item.major);
      const fixes = [];
      if (required && !available.includes(required)) {
        fixes.push(
          mkFix('install-java', `自动下载并安装 Java ${required}`, { major: required }, '下载运行时可能需要一两分钟'),
        );
      }
      fixes.push(
        mkFix(
          'advisory',
          `这个游戏版本需要 Java ${required}`,
          {},
          '启动器会自动选 Java；本机已装：' + (available.length ? available.map((m) => `Java ${m}`).join('、') : '无'),
        ),
      );
      return {
        explanation: `游戏/模组编译时用的 Java 版本比当前运行的高（需要 Java ${required}）。`,
        evidence,
        fixes,
      };
    },
  },
  {
    id: 'loader-mismatch',
    title: '加载器版本不匹配',
    severity: 'warn',
    confidence: 0.75,
    patterns: [
      /Incompatible mods found/i,
      /requires (?:fabric|quilt|forge|neoforge)[^\n]*?(?:loader )?version/i,
      /(?:fabricloader|quilt_loader|forge|neoforge)[^\n]{0,40}requires/i,
    ],
    build(ctx) {
      const evidence = pickEvidence(ctx.lines, this.patterns);
      if (evidence.length === 0) return null;
      const fixes = [
        mkFix(
          'update-loader',
          `升级 ${ctx.version.loader} 加载器后重试`,
          { loader: ctx.version.loaderId, mc: ctx.version.mc },
          '模组要求的加载器版本比当前实例高',
        ),
        mkFix('advisory', '或者把该模组换成匹配当前加载器版本的旧版本', {}),
      ];
      return {
        explanation: '某些模组要求的 Fabric/Quilt/Forge/NeoForge 加载器版本比当前实例里的新。',
        evidence,
        fixes,
      };
    },
  },
  {
    id: 'gl-driver',
    title: '显卡 / OpenGL 初始化失败',
    severity: 'fatal',
    confidence: 0.8,
    patterns: [
      /GLFW error/i,
      /Failed to create window/i,
      /OpenGL.{0,30}(?:error|unsupported|not available)/i,
      /Pixel format not accelerated/i,
      /WGL[^\n]{0,30}(?:error|fail)/i,
      /No OpenGL context/i,
    ],
    build(ctx) {
      const evidence = pickEvidence(ctx.lines, this.patterns);
      if (evidence.length === 0) return null;
      const fixes = [
        mkFix('advisory', '更新显卡驱动，或改用独显启动', {}, '集显/远程桌面环境下可能建不出 OpenGL 上下文'),
        mkFix('advisory', '关掉光影与高画质设置再试', {}, '光影会显著加重显卡初始化负担'),
        mkFix('open-settings', '打开外观设置关掉背景/特效', { page: 'appearance' }, '界面特效不吃显卡，但能减少干扰'),
      ];
      return {
        explanation: '游戏窗口/渲染上下文创建失败，通常是显卡驱动、远程桌面、或光影配置问题。',
        evidence,
        fixes,
      };
    },
  },
  {
    id: 'access-denied',
    title: '文件权限 / 文件被占用',
    severity: 'warn',
    confidence: 0.7,
    patterns: [/AccessDeniedException/i, /Permission denied/i, /拒绝访问/i, /另一个程序正在使用此文件/i, /EBUSY/i],
    build(ctx) {
      const evidence = pickEvidence(ctx.lines, this.patterns);
      if (evidence.length === 0) return null;
      const fixes = [
        mkFix('open-log', '打开实例目录检查文件', { instance: ctx.instance }, '看日志/存档是否被占用'),
        mkFix('advisory', '把启动器目录加入杀毒软件白名单', {}, '安全软件拦截写入很常见'),
      ];
      return {
        explanation: '游戏写文件时被系统或安全软件拦住（或者文件正被其他程序占用）。',
        evidence,
        fixes,
      };
    },
  },
  {
    id: 'corrupt-jar',
    title: '模组文件损坏 / 无法读取',
    severity: 'fatal',
    confidence: 0.8,
    patterns: [
      /InvalidModFileException/i,
      /zip END header not found/i,
      /Invalid or corrupt jarfile/i,
      /Error reading .*\.jar/i,
      /Corrupt/i,
    ],
    build(ctx) {
      const evidence = pickEvidence(ctx.lines, this.patterns);
      if (evidence.length === 0) return null;
      const fixes = [];
      for (const mod of recentMods(ctx.mods, 2)) {
        fixes.push(mkFix('disable-mod', `禁用可疑模组 ${mod.file}`, { jar: mod.file }, '重新下载这个 jar 更稳妥'));
      }
      fixes.push(mkFix('advisory', '把报错里点名的 jar 删掉重新下载', {}));
      return {
        explanation: '某个 mod 的 jar 下载不完整/损坏，加载器读不出来。',
        evidence,
        fixes,
      };
    },
  },
  {
    id: 'jvm-args',
    title: 'JVM 参数被拒绝',
    severity: 'fatal',
    confidence: 0.85,
    patterns: [
      /Unrecognized VM option/i,
      /Could not create the Java Virtual Machine/i,
      /Error occurred during initialization of VM/i,
      /Unrecognized option/i,
    ],
    build(ctx) {
      const evidence = pickEvidence(ctx.lines, this.patterns);
      if (evidence.length === 0) return null;
      return {
        explanation: '当前 Java 不认启动参数里的某个 -XX 选项（通常是手写了不兼容的 JVM 参数）。',
        evidence,
        fixes: [
          mkFix('advisory', '清掉自定义 JVM 参数后用默认参数启动', {}, '启动器默认参数已按 Java 版本分档'),
          mkFix('advisory', '确认 Java 版本与游戏版本匹配', {}),
        ],
      };
    },
  },
  {
    id: 'missing-class',
    title: '类找不到 / 游戏文件不完整',
    severity: 'fatal',
    confidence: 0.7,
    patterns: [
      /NoClassDefFoundError/i,
      /ClassNotFoundException/i,
      /Could not find or load main class/i,
      /LinkageError/i,
      /NoSuchMethodError/i,
    ],
    build(ctx) {
      const evidence = pickEvidence(ctx.lines, this.patterns);
      if (evidence.length === 0) return null;
      const fixes = [];
      for (const mod of recentMods(ctx.mods, 2)) {
        fixes.push(mkFix('disable-mod', `先禁用最近添加的 ${mod.file}`, { jar: mod.file }, '新装模组与当前版本不匹配最常见'));
      }
      fixes.push(mkFix('advisory', '校验游戏文件完整性（重装该版本）', {}, '`mcl install <版本> --force` 可重新下载'));
      return {
        explanation: '游戏主类或某个 mod 的类加载不到，可能是实例文件不完整，或 mod 与游戏版本不匹配。',
        evidence,
        fixes,
      };
    },
  },
  {
    id: 'mod-crash',
    title: '疑似模组引发的异常',
    severity: 'warn',
    confidence: 0.55,
    patterns: [/Exception in thread/i, /ModLoadingException/i, /ModLoadingContext/i, /LoadingFailedException/i],
    build(ctx) {
      const evidence = pickEvidence(ctx.lines, this.patterns);
      if (evidence.length === 0) return null;
      const fixes = [];
      for (const mod of recentMods(ctx.mods, 3)) {
        fixes.push(mkFix('disable-mod', `禁用最近添加的 ${mod.file}`, { jar: mod.file }, '按添加时间倒序排查'));
      }
      fixes.push(mkFix('advisory', '看崩溃报告里的 Caused by 链，通常能看到具体 mod 类名', {}));
      return {
        explanation: '异常发生在模组加载/初始化阶段，但没有命中更具体的关键字。',
        evidence,
        fixes,
      };
    },
  },
];

const PLATFORM_IDS = new Set([
  'minecraft',
  'fabric',
  'fabricloader',
  'quilt',
  'quilt_loader',
  'forge',
  'neoforge',
  'java',
]);

// 日志里大量普通英文单词，弱匹配必须滤掉这些，否则会把 "missing or unsupported" 当成 mod id
const STOP_WORDS = new Set([
  'any',
  'which',
  'version',
  'versions',
  'the',
  'and',
  'for',
  'from',
  'with',
  'required',
  'requires',
  'missing',
  'mod',
  'mods',
  'dependency',
  'dependencies',
  'or',
  'is',
  'of',
  'to',
  'in',
  'on',
  'by',
  'not',
  'found',
  'unsupported',
  'mandatory',
  'set',
  'incompatible',
  'but',
  'this',
  'that',
  'has',
  'have',
  'was',
]);

function extractMissingIds(lines) {
  const ids = [];
  const add = (raw) => {
    const id = String(raw ?? '')
      .toLowerCase()
      .replace(/[.,;:)\]]+$/, '');
    if (!id || id.length < 2) return;
    if (PLATFORM_IDS.has(id) || STOP_WORDS.has(id) || /^\d+$/.test(id)) return;
    if (!/^[a-z][a-z0-9_\-.]*$/.test(id)) return;
    if (!ids.includes(id)) ids.push(id);
  };

  // 强特征优先：Fabric/Quilt 的依赖声明、Forge/NeoForge 的「Mod ID:」声明
  const strong = [
    /requires any version of ([a-z0-9_\-.]{2,})/i,
    /Mod ID:\s*['"]?([a-z0-9_\-.]{2,})['"]?/i,
    /['"]([a-z0-9_\-.]{3,})['"]\s+is required/i,
  ];
  for (const line of lines) {
    for (const pattern of strong) {
      const match = line.match(pattern);
      if (match) add(match[1]);
      if (ids.length >= 4) return ids;
    }
  }
  if (ids.length > 0) return ids;

  // 弱特征兜底（严格过滤常见英文词）
  const weak = [
    /\b([a-z0-9_\-]{3,})\s+is missing\b/i,
    /\bmissing\s+(?:mod|dependency|dependencies|mods)\b[:\s]*['"]?([a-z0-9_\-.]{2,})['"]?/i,
  ];
  for (const line of lines) {
    for (const pattern of weak) {
      const match = line.match(pattern);
      if (match) add(match[1]);
      if (ids.length >= 4) return ids;
    }
  }
  return ids;
}

/** class file version → Java 大版本（52→8, 55→11, 61→17, 65→21；9 以后差值固定 44） */
function javaMajorFromClassFile(classFile) {
  const value = Number(classFile);
  if (!Number.isFinite(value)) return null;
  if (value >= 52 && value <= 70) return value - 44;
  return null;
}

function detectRequiredJava(lines) {
  // 1) 明确写了 requires Java N / Java N or newer
  for (const line of lines) {
    const match =
      line.match(/requires Java (\d+)/i) ||
      line.match(/Java (\d+)(?:\+|\s+or newer)/i) ||
      line.match(/Java \((\d+)\) or newer/i);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value >= 8 && value <= 25) return value;
    }
  }
  // 2) 只有 class file version 时换算
  for (const line of lines) {
    const match = line.match(/class file version (\d+)/i);
    if (match) {
      const major = javaMajorFromClassFile(Number(match[1]));
      if (major) return major;
    }
  }
  return null;
}

/** 常见 Windows 异常退出码 → 人话解释 */
const EXIT_CODE_HINTS = {
  3221225477: {
    title: '原生崩溃（EXCEPTION_ACCESS_VIOLATION）',
    explanation: '游戏在原生代码里访问了非法内存（0xC0000005）。常见于显卡驱动、渲染类模组、或超频不稳。',
    fixes: [
      ['advisory', '更新/回滚显卡驱动后重试', '特别是刚更新过驱动的话'],
      ['advisory', '关掉渲染类/优化类模组再试', '如光影、Sodium/Embeddium 等'],
      ['advisory', '关闭内存超频（XMP/EXPO）后重试', '原生崩溃也可能是内存不稳'],
    ],
  },
  3221225725: {
    title: '栈溢出（EXCEPTION_STACK_OVERFLOW）',
    explanation: '递归过深或栈空间不足（0xC00000FD）。常见于模组 bug 或过小的 -Xss。',
    fixes: [['advisory', '减少模组后重试', '尤其是最近新装的那个']],
  },
  3221225781: {
    title: '缺少系统 DLL（EXCEPTION_DLL_NOT_FOUND）',
    explanation: '启动时找不到某个系统动态库（0xC0000135）。常见于缺 VC++ 运行库或 Java 安装损坏。',
    fixes: [
      ['advisory', '安装/修复 Microsoft Visual C++ 运行库', 'x64 版'],
      ['advisory', '重新安装 Java 运行时', ''],
    ],
  },
  3221225794: {
    title: 'DLL 初始化失败（EXCEPTION_DLL_INIT_FAILED）',
    explanation: '系统 DLL 初始化失败（0xC0000142），通常和杀毒软件/系统环境有关。',
    fixes: [['advisory', '把启动器目录加入安全软件白名单', '']],
  },
  3221226505: {
    title: '堆栈缓冲溢出（EXCEPTION_STACK_BUFFER_OVERRUN）',
    explanation: '进程被快速失败机制终止（0xC0000409），常见于原生库/mods 崩溃。',
    fixes: [['advisory', '禁用最近安装的模组后重试', '']],
  },
};

function signedExitCode(code) {
  const value = Number(code);
  if (!Number.isFinite(value)) return null;
  // Node 在 Windows 上可能拿到负数（有符号），统一换算成无符号辅助查表
  return value < 0 ? value + 0x100000000 : value;
}

function exitCodeCause(exitCode) {
  const unsigned = signedExitCode(exitCode);
  if (unsigned === null || unsigned === 0) return null;
  const hint = EXIT_CODE_HINTS[unsigned];
  if (hint) {
    return {
      id: `exit-${unsigned}`,
      title: hint.title,
      severity: 'fatal',
      confidence: 0.6,
      explanation: `${hint.explanation}（退出码 ${exitCode}）`,
      evidence: [],
      fixes: [
        mkFix('retry-launch', '改完设置后重新启动', {}),
        ...hint.fixes.map(([kind, label, description]) => mkFix(kind, label, {}, description)),
      ],
    };
  }
  if (unsigned === 1) {
    return {
      id: 'exit-1',
      title: '游戏进程异常退出',
      severity: 'warn',
      confidence: 0.4,
      explanation: '游戏以退出码 1 结束，但没有在日志里命中更具体的原因。可以先按模组冲突/内存不足排查。',
      evidence: [],
      fixes: [
        mkFix('advisory', '把报告复制给 AI，附上 crash-reports 里的原始文件', {}),
        mkFix('retry-launch', '直接重试启动一次', {}),
      ],
    };
  }
  return null;
}

/* ────────────────────────── 报告生成 ────────────────────────── */

function buildMarkdown(report, excerpt) {
  const lines = [];
  lines.push('# MCL 崩溃修复报告');
  lines.push('');
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 实例：${report.instance}${report.mc ? `（Minecraft ${report.mc}${report.loader ? ` / ${report.loader}` : ''}）` : ''}`);
  lines.push(`- 是否崩溃：${report.crashed ? '是' : '否（未发现崩溃痕迹）'}`);
  if (report.exitCode !== null && report.exitCode !== undefined) lines.push(`- 退出码：${report.exitCode}`);
  lines.push(
    `- 内存：-Xmx${report.memory.xmx ?? '未知'}；系统 ${report.memory.totalGb}G / 可用 ${report.memory.freeGb}G`,
  );
  if (report.java) lines.push(`- Java：需要 ${report.java.required ?? '?'}；本机 ${report.java.major ?? '未知'}`);
  if (report.sources.crashReport) lines.push(`- 崩溃报告：${report.sources.crashReport}`);
  if (report.sources.log) lines.push(`- 游戏日志：${report.sources.log}`);
  if (report.sources.launcherConsole) lines.push(`- 启动器日志：${report.sources.launcherConsole}`);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(`**${report.summary}**`);
  lines.push('');
  lines.push(`置信度：${report.confidence}`);
  lines.push('');
  if (report.causes.length > 0) {
    lines.push('## 原因与修复');
    report.causes.forEach((cause, index) => {
      lines.push('');
      lines.push(`### ${index + 1}. ${cause.title}（${Math.round(cause.confidence * 100)}%）`);
      lines.push('');
      lines.push(cause.explanation);
      if (cause.evidence?.length) {
        lines.push('');
        lines.push('证据：');
        lines.push('```');
        for (const line of cause.evidence) lines.push(line);
        lines.push('```');
      }
      if (cause.fixes?.length) {
        lines.push('');
        lines.push('修复：');
        for (const fix of cause.fixes) {
          lines.push(`- ${fix.executable ? '☐' : '·'} ${fix.label}${fix.description ? `（${fix.description}）` : ''}`);
        }
      }
    });
  } else if (!report.crashed) {
    lines.push('## 原因与修复');
    lines.push('');
    lines.push('没有发现崩溃痕迹（游戏正常退出或还没进入游戏），无需修复。');
  } else {
    lines.push('## 原因与修复');
    lines.push('');
    lines.push('没有命中已知的崩溃规则。把下面的报错片段或整个 crash-report 贴给 AI 继续分析。');
  }
  if (report.fixes?.length) {
    lines.push('');
    lines.push('## 可执行动作清单');
    lines.push('');
    for (const fix of report.fixes) {
      lines.push(`- \`${fix.kind}\` ${fix.label}${fix.description ? ` —— ${fix.description}` : ''}`);
    }
  }
  if (excerpt?.length) {
    lines.push('');
    lines.push('## 报错摘录');
    lines.push('');
    lines.push('```');
    for (const line of excerpt) lines.push(line);
    lines.push('```');
  }
  lines.push('');
  lines.push('_由 MCL 崩溃修复助手生成；规则命中结果仅供参考，大整合包建议优先看 crash-report 原文。_');
  return lines.join('\n');
}

function dedupeFixes(causes) {
  const seen = new Set();
  const out = [];
  for (const cause of causes) {
    for (const fix of cause.fixes ?? []) {
      const key = `${fix.kind}|${JSON.stringify(fix.payload ?? {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(fix);
    }
  }
  // 通用动作排在最后
  out.sort((a, b) => Number(b.kind !== 'advisory') - Number(a.kind !== 'advisory'));
  return out;
}

/**
 * 生成结构化崩溃修复报告。
 * @param {string} instance 实例 id
 * @param {{ exitCode?: number, launchedAt?: number|string, auto?: boolean, java?: any, dir?: string, write?: boolean }} options
 */
export function buildFixReport(instance, options = {}) {
  const dir = options.dir && fs.existsSync(options.dir) ? options.dir : findVersionDir(instance);
  const generatedAt = new Date().toISOString();
  const baseReport = {
    instance,
    mc: instance,
    loader: '原版',
    generatedAt,
    auto: Boolean(options.auto),
    crashed: false,
    exitCode: typeof options.exitCode === 'number' ? options.exitCode : null,
    launchedAt: options.launchedAt ?? null,
    crashAt: null,
    memory: { xmx: null, totalGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10, freeGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10, suggestion: null, safeMaxGb: 1 },
    java: null,
    sources: { crashReport: null, log: null, launcherConsole: null, kind: null },
    summary: '没有找到崩溃日志（游戏可能还没运行过）',
    confidence: 'low',
    causes: [],
    fixes: [],
    reportPath: null,
    text: '',
  };
  if (!dir || !fs.existsSync(dir)) {
    baseReport.summary = `找不到实例 ${instance} 的目录，无法分析`;
    baseReport.text = buildMarkdown(baseReport, []);
    return baseReport;
  }

  const crash = detectCrash(dir, { launchedAt: options.launchedAt, exitCode: options.exitCode });
  const version = versionInfo(instance, dir);
  const memory = memoryStatus(crash.runtime);
  const java = normalizeJava(options.java);
  const javaMajor = java.available.length ? java.available[0].major : null;
  const { mods } = listMods(dir);
  let dupes = { instance, jars: 0, groups: [] };
  try {
    dupes = scanInstance(instance);
  } catch {
    /* 重复检查失败不影响主流程 */
  }

  // 读取证据文本：崩溃报告读开头（摘要在前），日志读末尾（堆栈在末尾）
  const texts = [];
  if (crash.crashReport) texts.push(readHead(crash.crashReport, MAX_TEXT));
  if (crash.logFile) texts.push(readTail(crash.logFile, MAX_TEXT));
  if (crash.launcherConsole) texts.push(readTail(crash.launcherConsole, MAX_TEXT));
  const corpus = texts.join('\n');
  const lines = toLines(corpus);

  const ctx = {
    instance,
    dir,
    runtime: crash.runtime,
    exitCode: crash.exitCode,
    memory,
    java,
    version,
    mods,
    dupes,
    lines,
    modMtime(file) {
      const found = mods.find((mod) => mod.file === file);
      return found ? found.mtime : 0;
    },
  };

  const causes = [];
  // 只有真的崩了（或有启动器失败退出码）才跑规则：正常退出的实例不能被历史日志误报
  if (crash.crashed) {
    for (const rule of RULES) {
      let cause;
      try {
        cause = rule.build(ctx);
      } catch {
        cause = null;
      }
      if (!cause) continue;
      causes.push({
        id: rule.id,
        title: rule.title,
        severity: rule.severity,
        confidence: cause.confidence ?? rule.confidence,
        explanation: cause.explanation,
        evidence: cause.evidence ?? [],
        fixes: (cause.fixes ?? []).filter(Boolean),
      });
    }
  }

  const hasSources = Boolean(crash.crashReport || crash.logFile || crash.launcherConsole || crash.runtime);

  // 没有命中规则但确实崩了：按退出码给通用解释
  if (causes.length === 0 && crash.crashed) {
    const fallback = exitCodeCause(crash.exitCode);
    if (fallback) causes.push(fallback);
  }
  // 启动器视角失败（例如 Java 没下完）：即使没有崩溃痕迹也要给结论
  if (causes.length === 0 && typeof options.exitCode === 'number' && options.exitCode !== 0) {
    causes.push({
      id: 'launch-failed',
      title: '启动失败（游戏没有正常跑起来）',
      severity: 'fatal',
      confidence: 0.5,
      explanation: '启动器进程异常退出，但游戏可能根本没启动。看下面的日志片段确认是缺 Java、参数错误还是文件缺失。',
      evidence: pickEvidence(lines, [/error/i, /失败/i, /not found/i, /missing/i], 4),
      fixes: [
        mkFix('open-log', '打开实例目录查看启动日志', { instance }),
        mkFix('advisory', '确认 Java 已安装且版本正确', {}),
        mkFix('retry-launch', '直接重试启动一次', {}),
      ],
    });
  }

  causes.sort((a, b) => b.confidence - a.confidence);
  const fixes = dedupeFixes(causes);
  const top = causes[0] ?? null;
  let summary;
  if (top) {
    summary = `${top.title}${causes.length > 1 ? `（另见 ${causes.length - 1} 个相关原因）` : ''}`;
  } else if (!crash.crashed) {
    summary = hasSources
      ? '没有发现崩溃痕迹（游戏正常退出或还没进入游戏）'
      : '没有找到崩溃日志（游戏可能还没运行过）';
  } else {
    summary = '没有命中已知规则，建议把报告复制给 AI 分析';
  }

  const excerpt = lines
    .filter((line) => /ERROR|Exception|Caused by|FATAL|at [a-z]+\.[a-z0-9_.]+\(/i.test(line))
    .slice(-12)
    .map((line) => line.trim().slice(0, MAX_EVIDENCE_CHARS));

  const report = {
    ...baseReport,
    mc: version.mc,
    loader: version.loader,
    crashed: crash.crashed,
    exitCode: crash.exitCode,
    crashAt: crash.crashReportAt ? new Date(crash.crashReportAt).toISOString() : null,
    memory: { ...memory, suggestion: null },
    java: {
      required: version.javaMajor,
      major: javaMajor,
      exe: java.available.find((item) => item.major === version.javaMajor)?.exe ?? null,
      available: java.available,
    },
    sources: {
      crashReport: crash.crashReport,
      log: crash.logFile,
      launcherConsole: crash.launcherConsole,
      kind: crash.crashReport ? 'crash-report' : crash.logFile ? 'log' : crash.launcherConsole ? 'launcher-console' : null,
    },
    summary,
    confidence: top ? (top.confidence >= 0.8 ? 'high' : top.confidence >= 0.6 ? 'medium' : 'low') : 'low',
    causes,
    fixes,
    excerpt,
  };
  // memory.suggestion 用真实数值（上面为了写简洁用了临时占位）
  const suggestion = causes.some((cause) => cause.id === 'oom') ? suggestMemory(memory) : null;
  report.memory.suggestion = suggestion ? `${suggestion}G` : null;

  report.text = buildMarkdown(report, excerpt);

  // 落盘：崩溃/自动分析（或显式 --write）才写入；正常退出的人工检查不留垃圾文件
  const shouldWrite = options.write === true || (options.write !== false && (report.crashed || report.auto));
  if (shouldWrite) {
    try {
      const crashDir = ensureDir(path.join(dir, CRASH_DIR_NAME));
      const latestPath = path.join(crashDir, 'mcl-fix-latest.md');
      fs.writeFileSync(latestPath, `${report.text}\n`, 'utf8');
      report.reportPath = latestPath;
      if (report.auto) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        const stamped = path.join(crashDir, `mcl-fix-${stamp}.md`);
        fs.writeFileSync(stamped, `${report.text}\n`, 'utf8');
        report.reportPath = stamped;
      }
    } catch {
      report.reportPath = null;
    }
  }

  return report;
}

/** /api/state 里的轻量崩溃摘要 */
export function crashSummary(report) {
  if (!report) return null;
  return {
    instance: report.instance,
    at: report.generatedAt,
    summary: report.summary,
    exitCode: report.exitCode,
    crashed: Boolean(report.crashed),
    causeIds: (report.causes ?? []).map((cause) => cause.id),
    reportPath: report.reportPath ?? null,
  };
}

/* ────────────────────────── 修复动作（服务端可执行部分） ────────────────────────── */

function assertPlainFileName(name) {
  const file = String(name ?? '').trim();
  if (!file) throw new Error('缺少文件名');
  if (file !== path.basename(file) || file.includes('..') || /[\\/]/.test(file)) throw new Error('非法文件名');
  return file;
}

function timestampTag() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/**
 * 执行 mod 文件动作（disable / enable / remove），返回 { ok, message }。
 * 所有路径都限定在实例的 mods/ 目录内，拒绝越界。
 * @param {string} dir 实例目录
 */
export function applyModAction(dir, kind, payload = {}) {
  const modsDir = path.join(dir, 'mods');
  const file = assertPlainFileName(payload.jar);
  const full = path.join(modsDir, file);
  if (!isInside(modsDir, full)) throw new Error('路径越界');
  if (!fs.existsSync(full)) throw new Error(`找不到文件：${file}`);

  if (kind === 'disable-mod') {
    if (/\.disabled$/i.test(file)) return { ok: true, message: `已经处于禁用状态：${file}` };
    const target = `${full}.disabled`;
    fs.renameSync(full, target);
    return { ok: true, message: `已禁用 ${file}（改名为 ${path.basename(target)}）` };
  }
  if (kind === 'enable-mod') {
    if (!/\.disabled$/i.test(file)) return { ok: true, message: `该文件本来就是启用状态：${file}` };
    const target = full.replace(/\.disabled$/i, '');
    fs.renameSync(full, target);
    return { ok: true, message: `已重新启用 ${path.basename(target)}` };
  }
  if (kind === 'remove-mod') {
    const backupDir = path.join(dir, `mods-backup-${timestampTag()}`);
    ensureDir(backupDir);
    fs.renameSync(full, path.join(backupDir, path.basename(full)));
    return { ok: true, message: `已移除 ${file}（备份在 ${path.basename(backupDir)}，可恢复）` };
  }
  throw new Error(`不支持的 mod 动作：${kind}`);
}
