import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 51730;
const PORT_SPAN = 20; // 和启动器的端口兜底范围一致：51730 ~ 51749
const INFO_FILE = path.join(os.homedir(), '.mcl', 'server.json');
const MAX_RESTARTS = 3;
// 插件被单独搬走时，仍然能找回同一仓库里的启动器源码
const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function candidateRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.env.MCL_HOME) roots.push(process.env.MCL_HOME);
  roots.push(SELF_ROOT);
  roots.push(path.join(home, 'Documents', 'mc-launcher'));
  roots.push(path.join(home, 'mc-launcher'));
  return roots;
}

function findLauncher() {
  for (const root of candidateRoots()) {
    const entry = path.join(root, 'bin', 'mcl.mjs');
    if (fs.existsSync(entry)) return { root, entry };
  }
  return null;
}

/** 启动器启动时会把真实端口写进 ~/.mcl/server.json */
function readServerInfoPort() {
  try {
    const info = JSON.parse(fs.readFileSync(INFO_FILE, 'utf8'));
    const port = Number(info.port);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    /* 没有发现文件也正常 */
  }
  return null;
}

/** 端口上跑的是不是我们的启动器（TCP 能连上不代表是它） */
async function probePort(port) {
  try {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(1200) : undefined;
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return Boolean(body && Array.isArray(body.versions));
  } catch {
    return false;
  }
}

/** 候选端口：发现文件里的优先，然后按范围扫 */
function candidatePorts() {
  const list = [];
  const fromFile = readServerInfoPort();
  if (fromFile) list.push(fromFile);
  for (let i = 0; i < PORT_SPAN; i += 1) list.push(DEFAULT_PORT + i);
  return [...new Set(list)];
}

async function findRunningPort() {
  // 并行探，别一个个等超时（服务没起来时串行要 20 多秒）
  const ports = candidatePorts();
  const hits = await Promise.all(ports.map((port) => probePort(port).then((ok) => (ok ? port : 0))));
  return hits.find(Boolean) ?? null;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Host 半边：保证本地启动器服务在跑。
 * 界面本身由 Client 半边用 React 渲染，这里只负责进程生命周期。
 *
 * 所有异常都在本函数里吞掉：DSH 是 fail-loud 的，这里的 Promise 拒绝会直接结束整个应用。
 */
export function apply(ctx) {
  let child = null;
  let disposed = false;
  let restarts = 0;
  let stderrTail = [];

  function log(message) {
    try {
      console.error(`[mc-launcher] ${message}`); // 进 DSH 宿主日志
    } catch {
      /* ignore */
    }
  }

  async function startOnce() {
    if (disposed) return;
    if (await findRunningPort()) return;
    if (disposed) return; // 探测期间插件被卸载了

    const found = findLauncher();
    if (!found) {
      log('找不到启动器源码（试过 MCL_HOME / 插件所在仓库 / Documents/mc-launcher）');
      return;
    }

    const env = { ...process.env };
    // 打包版 DSH 的 execPath 是 Electron 主程序，这个变量让它以纯 Node 运行脚本
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

    const spawned = spawn(process.execPath, [found.entry, 'gui', '--port', String(DEFAULT_PORT), '--no-open'], {
      cwd: found.root,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child = spawned;
    stderrTail = [];

    spawned.stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        stderrTail.push(line.trim());
        if (stderrTail.length > 40) stderrTail.shift();
      }
    });

    spawned.on('error', (error) => {
      log(`拉起失败：${error.message}`);
      if (child === spawned) child = null;
    });

    // 活过一分钟说明这次是正常起来的，把重启额度还回去
    const stableTimer = setTimeout(() => {
      if (child === spawned) restarts = 0;
    }, 60_000);

    spawned.on('exit', (code) => {
      clearTimeout(stableTimer);
      if (child !== spawned) return;
      child = null;
      if (disposed) return;
      const tail = stderrTail.slice(-3).join(' | ');
      log(`启动器退出（code=${code}）${tail ? `：${tail}` : ''}`);
      // 有限次退避重启：偶发崩溃能自愈，端口全占那种重试几次也就别试了
      if (restarts < MAX_RESTARTS) {
        restarts += 1;
        const delay = 3000 * restarts;
        wait(delay).then(() => {
          if (!disposed) startOnce().catch((error) => log(`重启失败：${error.message}`));
        });
      }
    });
  }

  ctx.effect(() => {
    disposed = false;
    restarts = 0;
    startOnce().catch((error) => log(`初始化失败：${error?.message ?? error}`));

    return () => {
      disposed = true;
      if (child) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        child = null;
      }
    };
  });
}
