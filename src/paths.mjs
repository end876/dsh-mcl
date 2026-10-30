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
