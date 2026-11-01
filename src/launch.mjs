import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  ASSETS_DIR,
  GAME_DIR,
  LIBRARIES_DIR,
  ensureDir,
  exists,
  versionDir,
} from './paths.mjs';
import {
  expandArguments,
  filterLibraries,
  legacyGameArgs,
  libraryRelPath,
  resolveVersionChain,
  substitute,
} from './meta.mjs';
import { findVersionDir, readLocalVersionJson } from './install.mjs';
import { ensureJava } from './java.mjs';
import { c, info, ok, step, warn } from './log.mjs';

export const LAUNCHER_NAME = 'mc-launcher';
export const LAUNCHER_VERSION = '1.1.2';

/** 实例目录里的运行时快照文件名（DSH 浮窗 / `mcl status` 读它） */
export const RUNTIME_NAME = '.mcl-runtime.json';

/** 标准离线 UUID：UUIDv3("OfflinePlayer:" + name) */
export function offlineUuid(username) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function classpathSeparator() {
  return process.platform === 'win32' ? ';' : ':';
}

export function loadVersion(versionId) {
  const json = readLocalVersionJson(versionId);
  if (!json) {
    throw new Error(`版本未安装：${versionId}（先运行 mcl install ${versionId}）`);
  }
  return resolveVersionChain(json, (id) => readLocalVersionJson(id));
}

/**
 * 组装启动命令，但不真正启动。
 */
export function buildCommand(versionId, options = {}) {
  const {
    username = 'Player',
    memory = '2G',
    width,
    height,
    gameDir: customGameDir,
    extraJvmArgs = [],
  } = options;

  const resolved = loadVersion(versionId);
  const dir = findVersionDir(versionId);
  const gameDir = customGameDir ? path.resolve(customGameDir) : dir;

  // 继承链（如 Fabric 实例）没有自己的客户端 jar / natives，要回退到根版本
  const chain = [];
  let cursor = readLocalVersionJson(versionId);
  while (cursor?.inheritsFrom) {
    chain.push(cursor.inheritsFrom);
    cursor = readLocalVersionJson(cursor.inheritsFrom);
  }
  const rootId = chain.length > 0 ? chain[chain.length - 1] : versionId;

  let nativesDir = path.join(dir, 'natives');
  if (!exists(nativesDir) && rootId !== versionId) {
    const inherited = path.join(versionDir(rootId), 'natives');
    if (exists(inherited)) nativesDir = inherited;
  }
  ensureDir(gameDir);

  const libraries = filterLibraries(resolved.libraries);
  // 继承链会把父版本和子版本都列的库重复拼进来（例如 Forge/NeoForge 与 1.21.1
  // 都写 gson 2.10.1）。同一个 jar 在 classpath 出现两次会让 BootstrapLauncher 2.x
  // 的 UnionFileSystem 抛 "Duplicate key"。
  const seenLib = new Set();
  const classpathEntries = [];
  for (const lib of libraries) {
    const rel = libraryRelPath(lib);
    if (seenLib.has(rel)) continue;
    seenLib.add(rel);
    classpathEntries.push(path.join(LIBRARIES_DIR, rel));
  }
  const jarId = resolved.jar ?? rootId;
  const clientJar = path.join(versionDir(jarId), `${jarId}.jar`);
  // Forge / NeoForge 1.17+ 走 BootstrapLauncher：补丁后的 client jar 由它扫描
  // libraryDirectory 自己装进 module path，原版 jar 再进 classpath 会和它抢
  // com.mojang.blaze3d.systems 的导出权（module ResolutionException）。
  const modularLoader = /bootstraplauncher/i.test(String(resolved.mainClass ?? ''));
  if (!modularLoader) classpathEntries.push(clientJar);

  const separator = classpathSeparator();
  const assetsIndex = resolved.assets ?? resolved.assetIndex?.id ?? 'legacy';
  const loggingFile = resolved.logging?.client?.file;
  const loggingPath = loggingFile ? path.join(ASSETS_DIR, 'logging', loggingFile.id) : '';

  const features = {
    is_demo_user: false,
    has_custom_resolution: Boolean(width && height),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
  };

  const auth = options.auth ?? null;
  const vars = {
    auth_player_name: auth?.name ?? username,
    version_name: versionId,
    game_directory: gameDir,
    assets_root: ASSETS_DIR,
    game_assets: path.join(ASSETS_DIR, 'virtual', assetsIndex),
    assets_index_name: assetsIndex,
    auth_uuid: auth?.uuid ?? offlineUuid(username),
    auth_access_token: auth?.accessToken ?? crypto.randomBytes(16).toString('hex'),
    auth_session: auth?.accessToken ?? crypto.randomBytes(16).toString('hex'),
    user_type: auth ? 'msa' : 'legacy',
    user_properties: '{}',
    clientid: auth?.clientId ?? '',
    auth_xuid: auth?.xuid ?? '',
    version_type: resolved.type ?? 'release',
    natives_directory: nativesDir,
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    classpath: classpathEntries.join(separator),
    classpath_separator: separator,
    library_directory: LIBRARIES_DIR,
    resolution_width: width ?? 854,
    resolution_height: height ?? 480,
    quickPlayPath: '',
    quickPlaySingleplayer: '',
    quickPlayMultiplayer: '',
    quickPlayRealms: '',
    path: loggingPath,
  };

  const jvmTemplate = expandArguments(resolved.arguments?.jvm ?? [], features);
  const hasModernJvmArgs = jvmTemplate.length > 0;

  const jvmArgs = [];
  const totalRamGb = Math.floor(os.totalmem() / 1024 / 1024 / 1024);
  let heap = memory;
  if (!memory || memory === 'auto') {
    // 自动：物理内存的 1/4，夹在 2G~8G
    const suggested = Math.min(8, Math.max(2, Math.round(totalRamGb / 4)));
    heap = `${suggested}G`;
  }
  jvmArgs.push(`-Xmx${heap}`);
  const javaMajor = resolved.javaVersion?.majorVersion ?? 8;
  // SoftMaxHeapSize 是 JDK 12+ 才有；G1 细调参数老版本也不全支持
  if (javaMajor >= 12) jvmArgs.push(`-XX:SoftMaxHeapSize=${heap}`);
  jvmArgs.push('-XX:+UseG1GC');
  if (javaMajor >= 9) {
    // G1NewSizePercent / G1MaxNewSizePercent 在 JDK 9+ 是实验参数，
    // 不加 UnlockExperimentalVMOptions 会直接 "Could not create the Java Virtual Machine"
    jvmArgs.push('-XX:+UnlockExperimentalVMOptions');
    jvmArgs.push('-XX:+ParallelRefProcEnabled');
    jvmArgs.push('-XX:MaxGCPauseMillis=200');
    jvmArgs.push('-XX:+DisableExplicitGC');
    jvmArgs.push('-XX:G1NewSizePercent=30');
    jvmArgs.push('-XX:G1MaxNewSizePercent=40');
    jvmArgs.push('-XX:G1HeapRegionSize=8M');
    jvmArgs.push('-XX:G1ReservePercent=20');
    jvmArgs.push('-XX:InitiatingHeapOccupancyPercent=15');
  } else {
    jvmArgs.push('-XX:+ParallelRefProcEnabled');
  }
  jvmArgs.push('-Dfile.encoding=UTF-8');
  jvmArgs.push('-Dstdout.encoding=UTF-8');
  jvmArgs.push('-Dstderr.encoding=UTF-8');
  jvmArgs.push('-Dlog4j2.formatMsgNoLookups=true');
  jvmArgs.push(...extraJvmArgs);

  if (hasModernJvmArgs) {
    jvmArgs.push(...jvmTemplate.map((arg) => substitute(arg, vars)));
  } else {
    // 1.13 之前的老版本没有 arguments.jvm
    jvmArgs.push(`-Djava.library.path=${nativesDir}`);
    jvmArgs.push('-cp');
    jvmArgs.push(vars.classpath);
  }

  const mainClass = resolved.mainClass;
  if (!mainClass) throw new Error(`版本 ${versionId} 缺少 mainClass`);

  let gameArgs;
  if (resolved.arguments?.game?.length) {
    gameArgs = expandArguments(resolved.arguments.game, features);
  } else if (resolved.legacyArguments) {
    gameArgs = legacyGameArgs(resolved.legacyArguments);
  } else {
    throw new Error(`版本 ${versionId} 缺少游戏参数`);
  }
  gameArgs = gameArgs.map((arg) => substitute(arg, vars));

  return {
    versionId,
    resolved,
    gameDir,
    nativesDir,
    classpath: classpathEntries,
    jvmArgs,
    mainClass,
    gameArgs,
    javaMajor: resolved.javaVersion?.majorVersion ?? 8,
    vars,
  };
}

/** 打印将要执行的完整命令（调试用） */
export function printCommand(command, javaExe = 'java') {
  const parts = [javaExe, ...command.jvmArgs, command.mainClass, ...command.gameArgs];
  const quote = (s) => (s === '' ? '""' : /\s/.test(s) ? `"${s}"` : s);
  console.log(parts.map(quote).join(' '));
}

/**
 * 启动游戏。返回子进程。
 */
export async function launch(versionId, options = {}) {
  const command = buildCommand(versionId, options);
  if (!exists(command.nativesDir)) {
    warn(`natives 目录不存在：${command.nativesDir}（老版本没有 natives 时可以忽略）`);
  }

  const java = await ensureJava(command.javaMajor, { autoDownload: options.autoDownloadJava !== false });
  const args = [...command.jvmArgs, command.mainClass, ...command.gameArgs];

  step(`启动 ${versionId}（离线玩家 ${options.username ?? 'Player'}）`);
  info(`游戏目录：${command.gameDir}`);
  info(`内存上限：${options.memory ?? '2G'}`);

  const child = spawn(java.exe, args, {
    cwd: command.gameDir,
    stdio: options.detach ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    detached: Boolean(options.detach),
  });

  const logFile = path.join(command.gameDir, 'launcher-console.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  // 运行时快照：状态面板靠它拿到真实 java pid / 内存上限 / 启动时间
  const runtimeFile = path.join(command.gameDir, RUNTIME_NAME);
  const startedAt = new Date().toISOString();
  const xmx = (command.jvmArgs.find((arg) => arg.startsWith('-Xmx')) ?? '').slice(4) || null;
  const writeRuntime = (extra = {}) => {
    try {
      fs.writeFileSync(
        runtimeFile,
        `${JSON.stringify(
          {
            instance: versionId,
            pid: child.pid,
            java: java.exe,
            memory: xmx,
            username: options.auth?.name ?? options.username ?? 'Player',
            online: Boolean(options.auth),
            startedAt,
            ...extra,
          },
          null,
          2,
        )}\n`,
      );
    } catch {
      /* 写不了就算了，不影响启动 */
    }
  };

  if (!options.detach) {
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(c.dim(chunk.toString()));
      logStream.write(chunk);
    });
  }

  child.on('spawn', () => {
    writeRuntime();
    ok(`已启动（pid ${child.pid}）`);
    if (options.detach) {
      info('后台运行中，本次命令会立即返回');
      child.unref();
    }
  });

  if (options.detach) return child;

  await new Promise((resolve) => {
    child.on('close', (code) => {
      logStream.end();
      writeRuntime({ stopped: true, stoppedAt: new Date().toISOString(), exitCode: code });
      if (code === 0) {
        ok('游戏正常退出');
      } else {
        warn(`游戏异常退出（exit code ${code}）`);
        tailLog(command.gameDir);
      }
      resolve();
    });
  });

  return child;
}

function tailLog(gameDir, lines = 30) {
  const candidates = [path.join(gameDir, 'logs', 'latest.log'), path.join(gameDir, 'launcher-console.log')];
  for (const file of candidates) {
    if (!exists(file)) continue;
    try {
      const content = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
      info(`=== ${path.basename(file)} 末尾 ===`);
      for (const line of content.slice(-lines)) console.log(c.dim(`  ${line}`));
      return;
    } catch {
      /* ignore */
    }
  }
}
