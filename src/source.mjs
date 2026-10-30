import { download, fetchJson } from './http.mjs';

const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const BMCLAPI_BASE = 'https://bmclapi2.bangbang93.com';

/** Mojang 官方源 */
export class MojangSource {
  constructor() {
    this.id = 'mojang';
    this.label = 'Mojang 官方源';
  }

  async manifest() {
    return fetchJson(MOJANG_MANIFEST);
  }

  versionJsonUrl(entry) {
    return entry.url;
  }

  clientUrl(id, versionJson) {
    return versionJson.downloads?.client?.url;
  }

  assetIndexUrl(versionJson) {
    return versionJson.assetIndex?.url;
  }

  libraryUrl(lib, relPath) {
    return lib.downloads?.artifact?.url ?? `${lib.url ?? 'https://libraries.minecraft.net/'}${relPath}`;
  }

  assetUrl(hash) {
    return `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`;
  }

  loggingUrl(file) {
    return file.url;
  }
}

/** BMCLAPI 镜像：有 UA 限制（浏览器 UA 会被 403），且可能限流 */
export class BmclapiSource {
  constructor() {
    this.id = 'bmclapi';
    this.label = 'BMCLAPI 镜像';
  }

  async manifest() {
    return fetchJson(`${BMCLAPI_BASE}/mc/game/version_manifest_v2.json`);
  }

  versionJsonUrl(entry) {
    return `${BMCLAPI_BASE}/version/${encodeURIComponent(entry.id)}/json`;
  }

  clientUrl(id) {
    return `${BMCLAPI_BASE}/version/${encodeURIComponent(id)}/client`;
  }

  assetIndexUrl(versionJson) {
    // 实测 BMCLAPI 不提供索引文件，索引很小，直接走官方
    return versionJson.assetIndex?.url;
  }

  libraryUrl(lib, relPath) {
    const official = lib.downloads?.artifact?.url ?? `${lib.url ?? 'https://libraries.minecraft.net/'}${relPath}`;
    try {
      const url = new URL(official);
      if (url.hostname === 'libraries.minecraft.net') return `${BMCLAPI_BASE}/maven${url.pathname}`;
    } catch {
      /* 非法 URL 原样返回 */
    }
    return official;
  }

  assetUrl(hash) {
    return `${BMCLAPI_BASE}/assets/${hash.slice(0, 2)}/${hash}`;
  }

  loggingUrl(file) {
    return file.url;
  }
}

const KNOWN = {
  mojang: () => new MojangSource(),
  official: () => new MojangSource(),
  bmclapi: () => new BmclapiSource(),
  bmcl: () => new BmclapiSource(),
};

export function createSource(name = 'mojang') {
  const factory = KNOWN[String(name).toLowerCase()];
  if (!factory) throw new Error(`未知下载源：${name}（可选 auto / mojang / bmclapi）`);
  return factory();
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 选源：
 *  - auto（默认）：并行探测官方与镜像，谁先答应用谁，另一个作为回退
 *  - 指定源：优先它，失败回退另一个
 * 返回 { sources: [首选, 回退...], manifest }
 */
export async function pickSource(name = 'auto') {
  const wanted = (name || 'auto').toLowerCase();

  if (wanted !== 'auto') {
    const preferred = createSource(wanted);
    const fallback = createSource(wanted === 'bmclapi' ? 'mojang' : 'bmclapi');
    return { sources: [preferred, fallback], manifest: await preferred.manifest() };
  }

  const candidates = [new MojangSource(), new BmclapiSource()];
  const settled = await Promise.any(
    candidates.map(async (source) => ({
      source,
      manifest: await withTimeout(source.manifest(), 15_000, source.id),
    })),
  );
  return {
    sources: [settled.source, ...candidates.filter((s) => s !== settled.source)],
    manifest: settled.manifest,
  };
}

/** 带源回退的下载 / 取 JSON */
export class Downloader {
  constructor(sources) {
    this.sources = sources;
  }

  get primary() {
    return this.sources[0];
  }

  async download(spec, options) {
    let lastError;
    for (const source of this.sources) {
      const url = spec(source);
      if (!url) continue;
      try {
        return await download({ url, ...options });
      } catch (error) {
        lastError = error;
        options?.onFallback?.(error, source);
      }
    }
    throw lastError ?? new Error('没有可用的下载地址');
  }

  async json(spec, options) {
    let lastError;
    for (const source of this.sources) {
      const url = spec(source);
      if (!url) continue;
      try {
        return await fetchJson(url, options);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('没有可用的下载地址');
  }
}

export { BMCLAPI_BASE, MOJANG_MANIFEST };
