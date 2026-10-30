import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { download, fetchJson, runPool } from './http.mjs';
import { installVersion, installedVersions } from './install.mjs';
import { mavenPath } from './meta.mjs';
import { GAME_DIR, LIBRARIES_DIR, ensureDir, exists, versionDir } from './paths.mjs';
import { openZip, openZipBuffer } from './zip.mjs';
import { ensureJava } from './java.mjs';
import { Progress, info, ok, step, warn } from './log.mjs';

const FORGE_MAVEN = 'https://maven.minecraftforge.net/';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/';
const BMCLAPI_MAVEN = 'https://bmclapi2.bangbang93.com/maven/';
const FORGE_PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const NEOFORGE_METADATA = 'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml';
const NEOFORGE_METADATA_OFFICIAL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';

/** Forge / NeoForge 的 maven 在国内都不稳，统一改走 BMCLAPI 的 maven 代理 */
export function mirrorMavenUrl(url) {
  if (typeof url !== 'string') return url;
  if (url.startsWith(FORGE_MAVEN)) return BMCLAPI_MAVEN + url.slice(FORGE_MAVEN.length);
  if (url.startsWith(NEOFORGE_MAVEN)) return BMCLAPI_MAVEN + url.slice(NEOFORGE_MAVEN.length);
  if (url.includes('maven.minecraftforge.net')) return url.replace(/^https?:\/\/maven\.minecraftforge\.net\//, BMCLAPI_MAVEN);
  if (url.includes('maven.neoforged.net/releases/')) {
    return url.replace(/^https?:\/\/maven\.neoforged\.net\/releases\//, BMCLAPI_MAVEN);
  }
  return url;
}

export const LOADERS = {
  forge: { id: 'forge', label: 'Forge', maven: FORGE_MAVEN },
  neoforge: { id: 'neoforge', label: 'NeoForge', maven: NEOFORGE_MAVEN },
};

function asLoader(loader) {
  const key = String(loader ?? '').toLowerCase();
  if (!LOADERS[key]) throw new Error(`未知加载器：${loader}（可选 forge / neoforge）`);
  return LOADERS[key];
}

/** maven 坐标 -> libraries 下的绝对路径 */
export function libraryFile(name) {
  return path.join(LIBRARIES_DIR, mavenPath(name));
}

// ─── 版本列表 ───

/** Forge: promotions_slim.json 里有 <mc>-latest / <mc>-recommended */
export async function listForgeVersions(mcVersion) {
  const doc = await fetchJson(FORGE_PROMOTIONS, { timeout: 30_000 });
  const promos = doc?.promos ?? doc ?? {};
  const keys = [`${mcVersion}-recommended`, `${mcVersion}-latest`];
  const found = [];
  for (const key of keys) {
    const value = promos?.[key];
    if (value && !found.includes(value)) found.push(value);
  }
  return found;
}

/** NeoForge: maven-metadata.xml 里按 MC 版本前缀筛（1.21.1 -> 21.1.x） */
export async function listNeoForgeVersions(mcVersion) {
  const parts = String(mcVersion).split('.');
  const prefix = `${Number(parts[1])}.${Number(parts[2] ?? 0)}.`;
  let xml;
  try {
    xml = await (await fetch(NEOFORGE_METADATA, { headers: { 'user-agent': 'mc-launcher' } })).text();
  } catch {
    xml = await (await fetch(NEOFORGE_METADATA_OFFICIAL, { headers: { 'user-agent': 'mc-launcher' } })).text();
  }
  const versions = [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  return versions.filter((v) => v.startsWith(prefix)).reverse();
}

export async function listLoaderVersions(loader, mcVersion) {
  const meta = asLoader(loader);
  if (meta.id === 'forge') return listForgeVersions(mcVersion);
  return listNeoForgeVersions(mcVersion);
}

// ─── 下载 ───

function installerUrl(loader, mcVersion, loaderVersion) {
  if (loader === 'forge') {
    const full = `${mcVersion}-${loaderVersion}`;
    return `${FORGE_MAVEN}net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
  }
  return `${NEOFORGE_MAVEN}net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
}

/** 下载一个库（走镜像）；已存在且大小对得上就跳过 */
async function fetchLibrary(lib, progress) {
  const rel = lib.downloads?.artifact?.path ?? mavenPath(lib.name);
  const dest = path.join(LIBRARIES_DIR, rel);
  const sha1 = lib.downloads?.artifact?.sha1;
  const size = lib.downloads?.artifact?.size;
  if (exists(dest) && (!size || fs.statSync(dest).size === size)) {
    progress?.add(1);
    return dest;
  }
  const base = lib.url ?? (lib.name.startsWith('net.neoforged') ? NEOFORGE_MAVEN : FORGE_MAVEN);
  const url = mirrorMavenUrl(lib.downloads?.artifact?.url ?? `${base}${rel}`);
  await download({ url, dest, sha1, size });
  progress?.add(1);
  return dest;
}

/** 从 maven 元数据里挑一个加载器版本 */
async function pickLoaderVersion(loader, mcVersion, wanted) {
  if (wanted) return wanted;
  const list = await listLoaderVersions(loader, mcVersion);
  if (!list.length) throw new Error(`${LOADERS[loader].label} 没有适配 ${mcVersion} 的版本`);
  return list[0];
}

// ─── installer 解析 ───

function readJsonEntry(zipFile, entryName) {
  const zip = openZip(zipFile);
  const entry = zip.entries.find((e) => e.name === entryName);
  if (!entry) throw new Error(`installer 缺少 ${entryName}`);
  return JSON.parse(zip.read(entry).toString('utf8'));
}

function readEntryRaw(zipFile, entryName) {
  const zip = openZip(zipFile);
  const entry = zip.entries.find((e) => e.name === entryName);
  if (!entry) return null;
  return zip.read(entry);
}

/** 从 jar 的 MANIFEST.MF 里读 Main-Class（processor 的入口） */
function mainClassOf(jarPath) {
  const buf = readEntryRaw(jarPath, 'META-INF/MANIFEST.MF');
  if (!buf) throw new Error(`缺少 MANIFEST：${jarPath}`);
  const text = buf.toString('utf8');
  const match = /^Main-Class:\s*(\S+)\s*$/m.exec(text);
  if (!match) throw new Error(`MANIFEST 里没有 Main-Class：${jarPath}`);
  return match[1];
}

/** data 表的一项：'[坐标]' / "'sha1'" / '/相对路径' */
function resolveDataValue(raw, workDir) {
  const value = String(raw ?? '').trim();
  if (value.startsWith('[') && value.endsWith(']')) return libraryFile(value.slice(1, -1));
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  const rel = value.replace(/^[/\\]+/, '').split(/[/\\]+/).join(path.sep);
  return path.join(workDir, rel);
}

/** installer 里以路径形式出现的数据（如 /data/client.lzma）需要先解出来 */
function extractDataFiles(zipFile, profile, workDir) {
  const zip = openZip(zipFile);
  const extracted = [];
  for (const entry of Object.values(profile.data ?? {})) {
    const raw = String(entry?.client ?? entry?.server ?? '').trim();
    if (!raw || raw.startsWith('[') || raw.startsWith("'")) continue;
    const name = raw.replace(/^[/\\]+/, '');
    const item = zip.entries.find((e) => e.name === name);
    if (!item) continue;
    const dest = path.join(workDir, name.split('/').join(path.sep));
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, zip.read(item));
    extracted.push(name);
  }
  return extracted;
}

function processorSides(processor) {
  const sides = processor.sides;
  if (!Array.isArray(sides) || sides.length === 0) return ['client', 'server'];
  return sides;
}

function substituteArg(value, vars) {
  let out = String(value);
  // 内联的 [坐标]
  out = out.replace(/\[([A-Za-z0-9_.\-]+:[A-Za-z0-9_.\-]+:[^\]\s]+)\]/g, (_m, coords) => libraryFile(coords));
  // {KEY}
  out = out.replace(/\{([A-Z0-9_]+)\}/g, (match, key) => (key in vars ? vars[key] : match));
  return out;
}

function runJava(javaExe, args, { cwd, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaExe, args, { cwd, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${label} 失败（exit ${code}）\n${output.split('\n').slice(-15).join('\n')}`));
    });
  });
}

/**
 * 安装 Forge / NeoForge 实例。
 * 路线：从 installer 里取 version.json + install_profile.json，自己下载库，
 * 再按 install_profile 的 processors 顺序跑一遍（binpatch / jarsplitter 等），
 * 不调用官方 installer 本体（它会直连被墙的 maven）。
 */
export async function installLoader(loader, mcVersion, {
  loaderVersion,
  sourceName = 'auto',
  instanceId,
  javaMajor,
} = {}) {
  const meta = asLoader(loader);
  if (!installedVersions().includes(mcVersion)) {
    step(`先安装原版 ${mcVersion}`);
    await installVersion(mcVersion, { sourceName });
  }

  const version = await pickLoaderVersion(meta.id, mcVersion, loaderVersion);
  step(`准备 ${meta.label} ${version}（MC ${mcVersion}）`);

  const tmpDir = ensureDir(path.join(GAME_DIR, 'tmp', 'loaders'));
  const installerPath = path.join(tmpDir, `${meta.id}-${mcVersion}-${version}-installer.jar`);
  if (!exists(installerPath) || fs.statSync(installerPath).size < 1024) {
    step(`下载 ${meta.label} installer`);
    await download({ url: mirrorMavenUrl(installerUrl(meta.id, mcVersion, version)), dest: installerPath });
  }
  info(`installer：${installerPath}`);

  const versionJson = readJsonEntry(installerPath, 'version.json');
  const profile = readJsonEntry(installerPath, 'install_profile.json');
  const id = instanceId ?? versionJson.id ?? `${meta.id}-${mcVersion}-${version}`;

  const workDir = ensureDir(path.join(tmpDir, `work-${id}`));
  const extracted = extractDataFiles(installerPath, profile, workDir);
  if (extracted.length) info(`解出 installer 数据文件：${extracted.join('、')}`);

  // 1) 下载两类库：install_profile 的 processor 依赖 + version.json 的启动依赖
  const libraries = [...(profile.libraries ?? []), ...(versionJson.libraries ?? [])];
  const seen = new Set();
  const unique = [];
  for (const lib of libraries) {
    const rel = lib.downloads?.artifact?.path ?? mavenPath(lib.name);
    if (seen.has(rel)) continue;
    seen.add(rel);
    unique.push(lib);
  }
  if (unique.length) {
    step(`下载 ${meta.label} 依赖（${unique.length} 个）`);
    const progress = new Progress(`${meta.id} libs`, unique.length, { count: true });
    await runPool(unique, (lib) => fetchLibrary(lib, progress), 6);
    progress.finish(`${meta.label} 依赖就绪`);
  }

  // 2) 变量表
  const mcJar = path.join(versionDir(mcVersion), `${mcVersion}.jar`);
  if (!exists(mcJar)) throw new Error(`原版客户端 jar 不存在：${mcJar}（先 mcl install ${mcVersion}）`);
  const data = {};
  for (const [key, entry] of Object.entries(profile.data ?? {})) {
    data[key] = resolveDataValue(entry?.client ?? entry?.server, workDir);
  }
  const vars = {
    ...data,
    ROOT: GAME_DIR,
    INSTALLER: installerPath,
    MINECRAFT_JAR: mcJar,
    SIDE: 'client',
  };

  // 3) processors
  const java = await ensureJava(javaMajor ?? 17);
  const processors = (profile.processors ?? []).filter((p) => processorSides(p).includes('client'));
  step(`${meta.label} processors（${processors.length} 个）`);
  let index = 0;
  for (const processor of processors) {
    index += 1;
    const jarPath = libraryFile(processor.jar);
    if (!exists(jarPath)) throw new Error(`processor 缺少 jar：${processor.jar}`);
    const classpath = [jarPath, ...(processor.classpath ?? []).map(libraryFile)];
    const mainClass = mainClassOf(jarPath);
    const args = (processor.args ?? []).map((a) => substituteArg(a, vars));
    info(`processor ${index}/${processors.length}：${mainClass.split('.').pop()}`);
    await runJava(java.exe, ['-cp', classpath.join(path.delimiter), mainClass, ...args], {
      cwd: workDir,
      label: `processor ${index}`,
    });
  }

  // 4) 版本文件
  const dir = ensureDir(versionDir(id));
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify({ ...versionJson, id }, null, 2)}\n`);
  ok(`版本描述已保存：${id}`);

  // 5) 检查补丁产物（processors 的最终产物）
  const patched = libraryFile(`net.minecraftforge:forge:${mcVersion}-${version}:client`);
  if (meta.id === 'forge' && !exists(patched)) {
    throw new Error(`Forge 客户端补丁没有生成：${patched}`);
  }

  return { id, mcVersion, loader: meta.id, loaderVersion: version, created: true };
}

export const installForge = (mcVersion, options = {}) => installLoader('forge', mcVersion, options);
export const installNeoForge = (mcVersion, options = {}) => installLoader('neoforge', mcVersion, options);

/** 已安装实例里挑一个指定加载器的（给插件/命令行用） */
export function loaderOfVersion(id) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(versionDir(id), `${id}.json`), 'utf8'));
    const main = String(json.mainClass ?? '');
    if (main.includes('bootstraplauncher')) return 'forge';
    if (main.includes('fml')) return 'forge';
    if (main.includes('neoforge')) return 'neoforge';
    if (main.includes('fabric')) return 'fabric';
  } catch {
    /* 版本文件坏了就当未知 */
  }
  return 'vanilla';
}

export function instanceIdForLoader(loader, mcVersion, label) {
  const slug = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'instance';
  return `${loader}-${mcVersion}-${slug}`;
}

/**
 * 找一个已装的、指定加载器 + 指定 MC 版本的实例；没有就装一个。
 * 装 mod 时用它复用实例，而不是每次新建。
 */
export async function ensureLoaderInstance(loader, mcVersion, options = {}) {
  const meta = asLoader(loader);
  for (const id of installedVersions()) {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(versionDir(id), `${id}.json`), 'utf8'));
      if (json.inheritsFrom !== mcVersion) continue;
      const main = String(json.mainClass ?? '');
      if (meta.id === 'forge' && /bootstraplauncher|fml/i.test(main) && !/neoforge/i.test(main)) return id;
      if (meta.id === 'neoforge' && /neoforge|bootstraplauncher/i.test(main)) return id;
    } catch {
      /* 跳过坏文件 */
    }
  }
  const result = await installLoader(meta.id, mcVersion, options);
  return result.id;
}
