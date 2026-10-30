import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（源码目录的上一级） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** .minecraft 根目录，可用 MCL_GAME_DIR 覆盖 */
export const GAME_DIR = process.env.MCL_GAME_DIR
  ? path.resolve(process.env.MCL_GAME_DIR)
  : path.join(ROOT, '.minecraft');

export const VERSIONS_DIR = path.join(GAME_DIR, 'versions');
export const LIBRARIES_DIR = path.join(GAME_DIR, 'libraries');
export const ASSETS_DIR = path.join(GAME_DIR, 'assets');
export const RUNTIME_DIR = path.join(ROOT, 'runtime');

/** Mojang 规则里的 OS 名称 */
export const OS_NAME =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';

/** 当前架构（Adoptium / BMCLAPI 口径） */
export const ARCH =
  process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'aarch64' : process.arch === 'ia32' ? 'x86' : process.arch;

/** Mojang rules 里的 arch 口径 */
export const ARCH_BITS = process.arch === 'ia32' ? '32' : '64';

export const IS_WINDOWS = process.platform === 'win32';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function versionDir(id) {
  return path.join(VERSIONS_DIR, id);
}

/**
 * 把压缩包里的相对路径拼到 root 下，并保证结果不会跑出 root。
 * 拒绝绝对路径、盘符、UNC、以及含 .. 段的条目（整合包是不可信输入）。
 */
export function safeJoin(root, rel) {
  const raw = String(rel ?? '');
  if (!raw) throw new Error('空的条目路径');
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    throw new Error(`拒绝绝对路径条目：${raw}`);
  }
  const normalized = path.normalize(raw);
  // 任何 .. 段都拒绝（不静默改写路径），打包/解包两边都用它
  if (raw.split(/[\\/]+/).includes('..') || normalized.split(/[\\/]+/).includes('..')) {
    throw new Error(`拒绝越界路径条目：${raw}`);
  }
  const target = path.resolve(root, normalized);
  if (!isInside(root, target)) {
    throw new Error(`拒绝越界路径条目：${raw}`);
  }
  return target;
}

/** 判断 resolved 是否在 root 里面（含 root 本身） */
export function isInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}
