import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PORT = 51730;
const PORT_SPAN = 20; // 和启动器的端口兜底范围一致：51730 ~ 51749
const INFO_FILE = path.join(os.homedir(), '.mcl', 'server.json');

function candidateRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.env.MCL_HOME) roots.push(process.env.MCL_HOME);
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
  for (const port of candidatePorts()) {
    if (await probePort(port)) return port;
  }
  return null;
}

/**
 * Host 半边：保证本地启动器服务在跑。
 * 界面本身由 Client 半边用 React 渲染，这里只负责进程生命周期。
 */
export function apply(ctx) {
  let child = null;
  let disposed = false;

  ctx.effect(() => {
    disposed = false;

    (async () => {
      if (await findRunningPort()) return;
      if (disposed) return; // 探测期间插件就被卸载了，别再拉进程

      const found = findLauncher();
      if (!found) return;

      const env = { ...process.env };
      // 打包版 DSH 的 execPath 是 Electron 主程序，这个变量让它以纯 Node 运行脚本
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

      const spawned = spawn(process.execPath, [found.entry, 'gui', '--port', String(DEFAULT_PORT), '--no-open'], {
        cwd: found.root,
        env,
        stdio: 'ignore',
        windowsHide: true,
      });
      child = spawned;
      spawned.on('error', () => {
        if (child === spawned) child = null;
      });
      spawned.on('exit', () => {
        if (child === spawned) child = null;
      });
    })();

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
