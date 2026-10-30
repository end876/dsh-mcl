import fs from 'node:fs';
import path from 'node:path';
import {
  ASSETS_DIR,
  GAME_DIR,
  LIBRARIES_DIR,
  VERSIONS_DIR,
  ensureDir,
  exists,
  versionDir,
} from './paths.mjs';
import { Downloader, pickSource } from './source.mjs';
import { fetchJson, runPool } from './http.mjs';
import { filterLibraries, libraryRelPath, nativeArtifacts, pickVersion } from './meta.mjs';
import { extractZip } from './zip.mjs';
import { Progress, fmtBytes, info, ok, step, warn } from './log.mjs';

const ASSET_CONCURRENCY = 24;
const LIB_CONCURRENCY = 8;

/** 已安装的版本 id 列表（有 json 才算） */
export function installedVersions() {
  try {
    return fs
      .readdirSync(VERSIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((id) => {
        const dir = path.join(VERSIONS_DIR, id);
        if (exists(path.join(dir, `${id}.json`))) return true;
        // 目录名 ≠ json 里的 id 时，只要目录里有任意版本 json 也算已安装
        try {
          return fs.readdirSync(dir).some((name) => name.endsWith('.json'));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** 找版本目录：目录名不一定等于 json 里的 id（PCL 手动改名后会不一致） */
export function findVersionDir(id) {
  const direct = versionDir(id);
  if (exists(path.join(direct, `${id}.json`))) return direct;
  try {
    for (const entry of fs.readdirSync(VERSIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(VERSIONS_DIR, entry.name);
      let files = [];
      try {
        // 跳过隐藏文件（.mcl-runtime.json 这类快照不是版本描述）
        files = fs.readdirSync(full).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const json = JSON.parse(fs.readFileSync(path.join(full, file), 'utf8'));
          if (json.id === id) return full;
        } catch {
          /* 跳过坏文件 */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return direct;
}

export function readLocalVersionJson(id) {
  const dir = findVersionDir(id);
  const exact = path.join(dir, `${id}.json`);
  // 目录名和 id 不一致时退而求其次，但只认"像版本描述"的 json，且坏文件直接跳过
  const others = versionJsonFiles(dir).filter((file) => file !== exact);
  for (const file of [exact, ...others]) {
    if (!exists(file)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (json && (json.id || json.mainClass || json.inheritsFrom)) return json;
    } catch {
      /* 截断/损坏的 json 跳过，别让整个状态接口挂掉 */
    }
  }
  return null;
}

/** 目录里像版本描述的 json（排除点开头的运行时快照） */
function versionJsonFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** 安装一个原版版本 */
export async function installVersion(target, { sourceName = 'auto', force = false } = {}) {
  step('选择下载源');
  const { sources, manifest } = await pickSource(sourceName);
  const dl = new Downloader(sources);
  info(`主源：${sources[0].label}${sources[1] ? `（回退：${sources[1].label}）` : ''}`);

  const entry = pickVersion(manifest, target);
  if (!entry) throw new Error(`版本清单里找不到「${target}」`);

  const id = entry.id;
  const dir = ensureDir(versionDir(id));
  info(`目标版本：${id}（${entry.type}）`);

  step('获取版本描述 json');
  const versionJson = await dl.json((s) => s.versionJsonUrl(entry));
  if (versionJson.id !== id) warn(`版本描述 id 不一致：期望 ${id}，实际 ${versionJson.id}`);
  // 注意：版本描述**最后**才落盘（见函数末尾），否则下载中断后会被当成"已安装"
  ok('版本描述已获取');

  // 客户端 jar
  const client = versionJson.downloads?.client;
  step('下载客户端 jar');
  const jarProgress = new Progress('client.jar', client?.size ?? 0);
  const jarResult = await dl.download((s) => s.clientUrl(id, versionJson), {
    dest: path.join(dir, `${id}.jar`),
    sha1: client?.sha1,
    size: client?.size,
    force,
    onBytes: (n) => jarProgress.add(n),
  });
  jarProgress.finish(jarResult === 'skip' ? '客户端 jar 已存在，跳过' : '客户端 jar 下载完成');

  // 依赖库
  const libraries = filterLibraries(versionJson.libraries);
  step(`下载依赖库（${libraries.length} 个）`);
  const libProgress = new Progress('libraries', libraries.length, { count: true });
  const nativeFiles = [];

  await runPool(
    libraries,
    async (lib) => {
      const relPath = libraryRelPath(lib);
      await dl.download((s) => s.libraryUrl(lib, relPath), {
        dest: path.join(LIBRARIES_DIR, relPath),
        sha1: lib.downloads?.artifact?.sha1,
        size: lib.downloads?.artifact?.size,
        force,
      });
      nativeFiles.push(...nativeArtifacts(lib));
      libProgress.add(1);
    },
    LIB_CONCURRENCY,
  );
  libProgress.finish(`依赖库就绪（${libraries.length} 个）`);

  // natives
  if (nativeFiles.length > 0) {
    step(`解压 natives（${nativeFiles.length} 个）`);
    const nativesDir = ensureDir(path.join(dir, 'natives'));
    for (const native of nativeFiles) {
      const jarFile = path.join(LIBRARIES_DIR, native.path);
      if (!exists(jarFile)) {
        const fakeLib = {
          name: native.path,
          downloads: { artifact: { url: native.url, path: native.path } },
        };
        await dl.download((s) => s.libraryUrl(fakeLib, native.path), {
          dest: jarFile,
          sha1: native.sha1,
          size: native.size,
          force,
        });
      }
      extractZip(jarFile, nativesDir, (name) => !name.endsWith('/'));
    }
    ok('natives 已解压');
  }

  await installAssets(versionJson, dl, { force });

  // 日志配置
  const loggingFile = versionJson.logging?.client?.file;
  if (loggingFile) {
    await dl.download((s) => s.loggingUrl(loggingFile), {
      dest: path.join(ASSETS_DIR, 'logging', loggingFile.id),
      sha1: loggingFile.sha1,
      size: loggingFile.size,
      force,
    });
  }

  // 全部下载成功后才写版本描述：中途失败不会留下"看起来装好了"的半成品
  const jsonPath = path.join(dir, `${id}.json`);
  const tmpPath = `${jsonPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(versionJson, null, 2)}\n`);
  fs.renameSync(tmpPath, jsonPath);
  ok('版本描述已保存');

  ok(`版本 ${id} 安装完成`);
  return { id, dir, versionJson, libraries };
}

async function installAssets(versionJson, dl, { force = false } = {}) {
  step('获取资源索引');
  const index = await dl.json((s) => s.assetIndexUrl(versionJson));
  if (!index) {
    warn('该版本没有 assets 索引，跳过资源下载');
    return;
  }

  ensureDir(path.join(ASSETS_DIR, 'indexes'));
  fs.writeFileSync(
    path.join(ASSETS_DIR, 'indexes', `${versionJson.assetIndex.id}.json`),
    JSON.stringify(index),
  );

  const objects = Object.entries(index.objects ?? {}).map(([name, obj]) => ({ name, ...obj }));
  const totalBytes = objects.reduce((sum, obj) => sum + (obj.size ?? 0), 0);
  step(`下载资源文件（${objects.length} 个 / ${fmtBytes(totalBytes)}）`);

  const progress = new Progress('assets', totalBytes);
  await runPool(
    objects,
    async (obj) => {
      await dl.download((s) => s.assetUrl(obj.hash), {
        dest: path.join(ASSETS_DIR, 'objects', obj.hash.slice(0, 2), obj.hash),
        sha1: obj.hash,
        size: obj.size,
        force,
      });
      progress.add(obj.size ?? 0);
    },
    ASSET_CONCURRENCY,
  );
  progress.finish('资源文件就绪');

  // 1.6 及更早需要虚拟资源目录；1.7~1.12 的资源包可能用到 resources 映射
  if (index.virtual || index.map_to_resources) {
    step('展开 legacy 资源目录');
    const virtualDir = path.join(ASSETS_DIR, 'virtual', versionJson.assetIndex.id);
    const resourcesDir = path.join(GAME_DIR, 'resources');
    for (const obj of objects) {
      const src = path.join(ASSETS_DIR, 'objects', obj.hash.slice(0, 2), obj.hash);
      const dest = path.join(index.map_to_resources ? resourcesDir : virtualDir, obj.name);
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
    }
    ok('legacy 资源目录已展开');
  }
}
