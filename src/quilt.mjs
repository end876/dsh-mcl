import fs from 'node:fs';
import path from 'node:path';
import { download, fetchBuffer, fetchJson, runPool } from './http.mjs';
import { installVersion, installedVersions } from './install.mjs';
import { libraryRelPath } from './meta.mjs';
import { GAME_DIR, LIBRARIES_DIR, ensureDir, exists, versionDir } from './paths.mjs';
import { Progress, info, ok, step, warn } from './log.mjs';

// Quilt 的元数据/仓库都在 Cloudflare 后面，国内直连很慢但通常能通（BMCLAPI 没有 quilt 镜像）
const QUILT_META = 'https://meta.quiltmc.org/v3/versions/loader';
const QUILT_MAVEN = 'https://maven.quiltmc.org/repository/release/';
const QUILT_LOADER_METADATA = `${QUILT_MAVEN}org/quiltmc/quilt-loader/maven-metadata.xml`;
const FABRIC_MAVEN = 'https://maven.fabricmc.net/';
const BMCLAPI_MAVEN = 'https://bmclapi2.bangbang93.com/maven/';
const CACHE_TTL = 3 * 24 * 60 * 60 * 1000;
// Quilt 的 profile 很小（~1.5KB），但握手慢；给足超时
const META_TIMEOUT = 60_000;

/** maven.fabricmc.net 走 BMCLAPI，quilt 自己的仓库只能直连 */
function mirrorQuiltUrl(url) {
  if (typeof url !== 'string') return url;
  if (url.startsWith(FABRIC_MAVEN)) return BMCLAPI_MAVEN + url.slice(FABRIC_MAVEN.length);
  return url;
}

function sanitize(text) {
  return String(text ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function cacheFile(mcVersion) {
  return path.join(GAME_DIR, 'packages', `quilt-loaders-${sanitize(mcVersion)}.json`);
}

function readCache(mcVersion) {
  try {
    const doc = JSON.parse(fs.readFileSync(cacheFile(mcVersion), 'utf8'));
    if (Array.isArray(doc.data) && doc.data.length > 0 && Date.now() - doc.at < CACHE_TTL) return doc.data;
  } catch {
    /* 没缓存/坏了就当没有 */
  }
  return null;
}

function writeCache(mcVersion, data) {
  try {
    ensureDir(path.join(GAME_DIR, 'packages'));
    fs.writeFileSync(cacheFile(mcVersion), `${JSON.stringify({ at: Date.now(), data }, null, 2)}\n`);
  } catch {
    /* 缓存写失败不影响安装 */
  }
}

/** maven 元数据里所有 quilt-loader 版本（新 → 旧） */
async function loaderVersionsFromMaven() {
  const xml = (await fetchBuffer(QUILT_LOADER_METADATA, { timeout: META_TIMEOUT, retries: 2 })).toString('utf8');
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((match) => match[1])
    .filter((version) => /^\d+\.\d+\.\d+/.test(version))
    .reverse();
}

const profileCache = new Map();

function profileFile(mcVersion, loaderVersion) {
  return path.join(GAME_DIR, 'packages', `quilt-profile-${sanitize(mcVersion)}-${sanitize(loaderVersion)}.json`);
}

/** 某个 MC + 加载器版本对应的 profile json；404 返回 null（该组合不支持） */
export async function fetchQuiltProfile(mcVersion, loaderVersion) {
  const key = `${mcVersion}/${loaderVersion}`;
  if (profileCache.has(key)) return profileCache.get(key);

  // profile 是只读的：落到 packages 里，下次（含重装/失败重试）就不用再走慢网络
  const file = profileFile(mcVersion, loaderVersion);
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached?.id) {
      profileCache.set(key, cached);
      return cached;
    }
  } catch {
    /* 没缓存 */
  }

  const url = `${QUILT_META}/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`;
  let profile = null;
  try {
    profile = await fetchJson(url, { timeout: META_TIMEOUT, retries: 2 });
  } catch (error) {
    if (/HTTP 404/.test(String(error?.message ?? ''))) {
      profile = null;
    } else {
      throw error;
    }
  }
  if (profile?.id) {
    profileCache.set(key, profile);
    try {
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`);
    } catch {
      /* 缓存写失败不影响安装 */
    }
  }
  return profile;
}

/**
 * 某 MC 版本可用的 Quilt 加载器（新 → 旧）。
 * 官方 `/v3/versions/loader/<mc>` 一次要下 ~900KB，太慢；
 * 这里先用 maven 元数据拿候选版本，再并发探测 profile（每个 ~1.5KB），结果缓存 3 天。
 */
export async function listQuiltLoaders(mcVersion, { refresh = false } = {}) {
  const mc = String(mcVersion);
  if (!refresh) {
    const cached = readCache(mc);
    if (cached) return cached;
  }

  let candidates = [];
  try {
    const all = await loaderVersionsFromMaven();
    // 优先稳定版（0.30.1），beta 只在稳定版都不支持该 MC 时兜底
    const stable = all.filter((version) => !version.includes('-'));
    const pre = all.filter((version) => version.includes('-'));
    candidates = [...stable, ...pre].slice(0, 8);
  } catch (error) {
    warn(`Quilt maven 元数据读取失败：${error.message}`);
  }

  const found = [];
  if (candidates.length > 0) {
    step(`探测 Quilt 加载器（${mc}，最多 ${candidates.length} 个候选）`);
    const results = await Promise.all(
      candidates.map((version) =>
        fetchQuiltProfile(mc, version)
          .then((profile) => (profile ? version : null))
          .catch(() => null),
      ),
    );
    for (const version of results) {
      if (version) found.push(version);
      if (found.length >= 4) break;
    }
  }

  if (found.length === 0) {
    // 兜底：官方大列表（很慢，可能一两分钟）
    warn('候选探测没命中，回退 Quilt 官方版本列表（较慢）');
    const list = await fetchJson(`${QUILT_META}/${encodeURIComponent(mc)}`, {
      timeout: 240_000,
      retries: 1,
    });
    for (const entry of list ?? []) {
      const version = entry?.loader?.version;
      if (version) found.push(version);
    }
  }

  const unique = [...new Set(found)];
  if (unique.length > 0) writeCache(mc, unique);
  return unique;
}

/**
 * 安装（或复用）一个 Quilt 实例。
 * 走 Quilt Meta 的 profile json（和 Fabric 一样不需要 processors）。
 */
export async function installQuilt(mcVersion, { loaderVersion, sourceName = 'auto', instanceId } = {}) {
  const installed = installedVersions();
  if (!installed.includes(mcVersion)) {
    step(`先安装原版 ${mcVersion}`);
    await installVersion(mcVersion, { sourceName });
  }

  let loader = loaderVersion;
  if (!loader) {
    step(`查询 Quilt 加载器（${mcVersion}）`);
    const list = await listQuiltLoaders(mcVersion);
    if (list.length === 0) throw new Error(`Quilt 没有适配 ${mcVersion} 的加载器`);
    loader = list[0];
  }
  info(`加载器版本：${loader}`);

  step('获取 Quilt 启动配置');
  const profile = await fetchQuiltProfile(mcVersion, loader);
  if (!profile?.id) throw new Error(`Quilt 没有适配 ${mcVersion} 的加载器版本 ${loader}`);

  const id = instanceId ?? profile.id;
  const dir = ensureDir(versionDir(id));
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify({ ...profile, id }, null, 2)}\n`);
  ok(`版本描述已保存：${id}`);

  const libraries = profile.libraries ?? [];
  if (libraries.length > 0) {
    step(`下载 Quilt 依赖（${libraries.length} 个，quilt 仓库可能较慢）`);
    const progress = new Progress('quilt libs', libraries.length, { count: true });
    await runPool(
      libraries,
      async (lib) => {
        const relPath = libraryRelPath(lib);
        const dest = path.join(LIBRARIES_DIR, relPath);
        // Quilt 的 profile 不带 sha1/size：文件在且非空就跳过，省得慢网络下重复下
        if (exists(dest) && fs.statSync(dest).size > 0) {
          progress.add(1);
          return;
        }
        const url = mirrorQuiltUrl(`${lib.url ?? QUILT_MAVEN}${relPath}`);
        await download({ url, dest });
        progress.add(1);
      },
      4,
    );
    progress.finish(`Quilt 依赖就绪（${libraries.length} 个）`);
  }

  return { id, loader: 'quilt', loaderVersion: loader, mcVersion, created: !installed.includes(id) };
}

/** 找（或装）一个 Quilt 实例 */
export async function ensureQuiltInstance(mcVersion, options = {}) {
  for (const id of installedVersions()) {
    if (!id.startsWith('quilt-loader-')) continue;
    try {
      const json = JSON.parse(fs.readFileSync(path.join(versionDir(id), `${id}.json`), 'utf8'));
      if (json.inheritsFrom === mcVersion) return id;
    } catch {
      /* 忽略坏文件 */
    }
  }
  const result = await installQuilt(mcVersion, options);
  return result.id;
}
