import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GAME_DIR, safeJoin, versionDir } from './paths.mjs';
import { readLocalVersionJson } from './install.mjs';
import { createZipWriter } from './zipwrite.mjs';

export const EXPORTS_DIR = path.join(os.homedir(), '.mcl', 'exports');

// 这些目录/文件不进整合包：日志、崩溃报告、存档（可选）、备份、缓存、运行时快照
const SKIP_NAMES = new Set([
  'logs',
  'crash-reports',
  'crash-reports-backup',
  'screenshots',
  'backups',
  'natives',
  'downloads',
  'server-resource-packs',
  '.cache',
  'journeymap',
  'xaero',
  'xaerominimap',
  'xaeroworldmap',
  'replay_videos',
  'mods-backup',
]);
const SKIP_PREFIXES = ['mods-backup-', 'backup-', '.mcl-'];
const SKIP_FILES = new Set(['.mcl-runtime.json', 'launcher-console.log', 'session.lock']);

function shouldSkip(rel, isDir, includeSaves) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  if (parts.some((part) => SKIP_NAMES.has(part))) return true;
  if (!includeSaves && parts[0] === 'saves') return true;
  if (parts.some((part) => SKIP_PREFIXES.some((prefix) => part.startsWith(prefix)))) return true;
  if (!isDir && SKIP_FILES.has(name)) return true;
  if (!isDir && /\.log$/i.test(name)) return true;
  return false;
}

function walk(dir, base, includeSaves, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (shouldSkip(rel, true, includeSaves)) continue;
      walk(full, base, includeSaves, out);
    } else if (entry.isFile()) {
      if (shouldSkip(rel, false, includeSaves)) continue;
      try {
        const stat = fs.statSync(full);
        out.push({ full, rel, size: stat.size });
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/** 从版本 json / 实例名推断加载器与版本 */
export function loaderInfoOf(json, instance) {
  const gameArgs = Array.isArray(json?.arguments?.game) ? json.arguments.game.map(String) : [];
  const flagValue = (flag) => {
    const index = gameArgs.indexOf(flag);
    return index >= 0 && gameArgs[index + 1] ? gameArgs[index + 1] : null;
  };
  const forgeVersion = flagValue('--fml.forgeVersion');
  if (forgeVersion) return { loader: 'forge', version: forgeVersion };
  const neoVersion = flagValue('--fml.neoForgeVersion');
  if (neoVersion) return { loader: 'neoforge', version: neoVersion };

  for (const lib of json?.libraries ?? []) {
    const name = String(lib.name ?? '');
    const match = name.match(/^(net\.fabricmc:fabric-loader|org\.quiltmc:quilt-loader):(.+)$/);
    if (match) return { loader: match[1].includes('fabric') ? 'fabric' : 'quilt', version: match[2] };
  }

  const text = `${json?.id ?? ''} ${instance ?? ''}`.toLowerCase();
  const patterns = [
    ['neoforge', /neoforge[-_ ]?([\d.]+)/],
    ['forge', /forge[-_ ]?([\d.]+)/],
    ['fabric', /fabric[-_ ]?(?:loader[-_ ]?)?([\d.]+)/],
    ['quilt', /quilt[-_ ]?(?:loader[-_ ]?)?([\d.]+)/],
  ];
  for (const [loader, pattern] of patterns) {
    const match = text.match(pattern);
    if (match) return { loader, version: match[1] };
  }
  return { loader: null, version: null };
}

export function mcVersionOf(json, instance) {
  const inherited = String(json?.inheritsFrom ?? '').trim();
  if (inherited) return inherited;
  const match = String(json?.id ?? instance ?? '').match(/(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

/**
 * 把本地实例导出成整合包 zip（CurseForge 结构：manifest.json + overrides/）。
 * 默认不导存档；includeSaves=true 才把 saves/ 一起打进去。
 */
export async function exportInstance(instance, { includeSaves = false, onProgress, onPlan } = {}) {
  const dir = versionDir(instance);
  if (!dir || !fs.existsSync(dir)) throw new Error(`找不到实例：${instance}`);
  const json = readLocalVersionJson(instance);
  const mcVersion = mcVersionOf(json, instance);
  if (!mcVersion) throw new Error(`读不出 ${instance} 的 Minecraft 版本，无法生成 manifest`);
  const loader = loaderInfoOf(json, instance);

  const files = walk(dir, dir, includeSaves);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, '-')
    .replace(/\..+$/, '')
    .replace(/-/g, '')
    .slice(0, 13);
  const safeName = String(instance).replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 60) || 'instance';
  const file = `${safeName}-${stamp}.zip`;
  const outPath = safeJoin(EXPORTS_DIR, file);
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });

  const manifest = {
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: instance,
    version: '1.0',
    author: 'MCL',
    minecraft: {
      version: mcVersion,
      modLoaders: loader.loader && loader.version ? [{ id: `${loader.loader}-${loader.version}`, primary: true }] : [],
    },
    overrides: 'overrides',
    files: [],
  };

  onPlan?.({ totalBytes, files: files.length, file, path: outPath });
  const zip = createZipWriter(outPath);
  try {
    zip.add('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
    for (const item of files) {
      const buffer = fs.readFileSync(item.full);
      zip.add(`overrides/${item.rel}`, buffer);
      onProgress?.(item.size, item.rel);
    }
  } finally {
    zip.close();
  }
  const stat = fs.statSync(outPath);
  return {
    file,
    path: outPath,
    instance,
    mcVersion,
    loader: loader.loader,
    loaderVersion: loader.version,
    files: files.length,
    bytes: stat.size,
    totalBytes,
    dir,
  };
}
