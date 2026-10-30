import fs from 'node:fs';
import path from 'node:path';
import { findVersionDir, installedVersions } from './install.mjs';

/** 从文件名猜 mod 主名：第一个含数字的片段之前的部分 */
export function modKey(filename) {
  const base = String(filename).replace(/\.jar$/i, '');
  const parts = base.split(/[-_+. ]+/);
  const stop = parts.findIndex((part) => /\d/.test(part));
  const head = stop > 0 ? parts.slice(0, stop).join('-') : base;
  return head.toLowerCase();
}

/** 扫一个实例的 mods 目录，找出疑似重复（同名不同版本）的 mod */
export function scanInstance(instanceId) {
  const dir = path.join(findVersionDir(instanceId), 'mods');
  if (!fs.existsSync(dir)) return { instance: instanceId, jars: 0, groups: [] };
  const jars = fs.readdirSync(dir).filter((name) => name.endsWith('.jar'));
  const map = new Map();
  for (const jar of jars) {
    const key = modKey(jar);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(jar);
  }
  const groups = [...map.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, files: list }));
  return { instance: instanceId, jars: jars.length, groups };
}

/** 扫描全部已安装实例 */
export function scanAll() {
  return installedVersions().map((id) => scanInstance(id)).filter((item) => item.jars > 0);
}
