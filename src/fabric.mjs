import fs from 'node:fs';
import path from 'node:path';
import { download, fetchJson, runPool } from './http.mjs';
import { createSource } from './source.mjs';
import { installVersion, installedVersions } from './install.mjs';
import { libraryRelPath } from './meta.mjs';
import { LIBRARIES_DIR, ensureDir, versionDir } from './paths.mjs';
import { Progress, info, ok, step } from './log.mjs';

const FABRIC_META = 'https://meta.fabricmc.net/v2/versions/loader';
const FABRIC_META_MIRROR = 'https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader';
const FABRIC_MAVEN = 'https://maven.fabricmc.net/';
const FABRIC_MAVEN_MIRROR = 'https://bmclapi2.bangbang93.com/maven/';

/** maven.fabricmc.net 在国内经常超时，走 BMCLAPI 镜像 */
function mirrorMaven(url) {
  if (typeof url === 'string' && url.startsWith(FABRIC_MAVEN)) {
    return FABRIC_MAVEN_MIRROR + url.slice(FABRIC_MAVEN.length);
  }
  return url;
}

/** 优先镜像，失败回退官方 meta */
async function fetchFabric(path) {
  try {
    return await fetchJson(`${FABRIC_META_MIRROR}${path}`, { timeout: 20_000 });
  } catch {
    return fetchJson(`${FABRIC_META}${path}`, { timeout: 20_000 });
  }
}

/** 某 MC 版本可用的 Fabric 加载器列表 */
export async function listFabricLoaders(mcVersion) {
  return fetchFabric(`/${encodeURIComponent(mcVersion)}`);
}

/** 实例名：fabric-1.20.1 */
export function fabricInstanceId(mcVersion) {
  return `fabric-${mcVersion}`;
}

/**
 * 安装（或复用）一个 Fabric 实例。
 * 返回 { id, loader, mcVersion, created }
 */
export async function installFabric(mcVersion, { loaderVersion, sourceName = 'auto', instanceId } = {}) {
  const installed = installedVersions();
  if (!installed.includes(mcVersion)) {
    step(`先安装原版 ${mcVersion}`);
    await installVersion(mcVersion, { sourceName });
  }

  step(`查询 Fabric 加载器（${mcVersion}）`);
  const list = await listFabricLoaders(mcVersion);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`Fabric 没有适配 ${mcVersion} 的加载器`);
  }
  const loader =
    loaderVersion ??
    list.find((entry) => entry.loader?.stable)?.loader?.version ??
    list[0]?.loader?.version;
  info(`加载器版本：${loader}`);

  step('获取 Fabric 启动配置');
  const profile = await fetchFabric(`/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loader)}/profile/json`);
  if (!profile?.id) throw new Error('Fabric 返回的版本配置不完整');

  const id = instanceId ?? profile.id;
  const dir = ensureDir(versionDir(id));
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify({ ...profile, id }, null, 2)}\n`);
  ok(`版本描述已保存：${id}`);

  const source = createSource(sourceName === 'auto' ? 'mojang' : sourceName);
  const libraries = profile.libraries ?? [];
  if (libraries.length > 0) {
    step(`下载 Fabric 依赖（${libraries.length} 个）`);
    const progress = new Progress('fabric libs', libraries.length, { count: true });
    await runPool(
      libraries,
      async (lib) => {
        const relPath = libraryRelPath(lib);
        const url = mirrorMaven(source.libraryUrl(lib, relPath));
        await download({
          url,
          dest: path.join(LIBRARIES_DIR, relPath),
          sha1: lib.downloads?.artifact?.sha1,
          size: lib.downloads?.artifact?.size,
        });
        progress.add(1);
      },
      8,
    );
    progress.finish(`Fabric 依赖就绪（${libraries.length} 个）`);
  }

  return { id, loader, mcVersion, created: !installed.includes(id) };
}

/** 配置名 → 目录安全片段 */
function slugify(text, max = 24) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return slug || 'instance';
}

/** 按配置隔离的实例 id：fabric-1.20.1-modpack-fo */
export function instanceIdFor(mcVersion, label) {
  return `fabric-${mcVersion}-${slugify(label)}`;
}

/** 取（或建）某个配置专属实例，互不污染 */
export async function ensureInstance(mcVersion, label, options = {}) {
  const id = instanceIdFor(mcVersion, label);
  if (fs.existsSync(path.join(versionDir(id), `${id}.json`))) return id;
  const result = await installFabric(mcVersion, { ...options, instanceId: id });
  return result.id;
}

/** 给某个实例准备 mods 目录 */
export function instanceModsDir(instanceId) {
  const dir = path.join(versionDir(instanceId), 'mods');
  ensureDir(dir);
  return dir;
}

/** 找到（或创建）某 MC 版本对应的 Fabric 实例 id（真实 id 是 fabric-loader-x.y.z-1.20.1） */
export async function ensureFabricInstance(mcVersion, options = {}) {
  for (const id of installedVersions()) {
    if (!id.startsWith('fabric-loader-')) continue;
    try {
      const json = JSON.parse(fs.readFileSync(path.join(versionDir(id), `${id}.json`), 'utf8'));
      if (json.inheritsFrom === mcVersion) return id;
    } catch {
      /* 忽略坏文件 */
    }
  }
  const result = await installFabric(mcVersion, options);
  return result.id;
}
