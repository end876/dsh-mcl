import fs from 'node:fs';
import path from 'node:path';
import { download, fetchJson, runPool } from './http.mjs';
import { openZipBuffer } from './zip.mjs';
import { ensureDir, GAME_DIR, versionDir } from './paths.mjs';
import { ensureFabricInstance, ensureInstance, instanceModsDir } from './fabric.mjs';
import { ensureLoaderInstance, installLoader } from './loader.mjs';
import { Progress, ok, step, warn } from './log.mjs';

const API = 'https://api.modrinth.com/v2';

function buildFacets({ type, loader, mcVersion }) {
  const facets = [];
  if (type) facets.push([`project_type:${type}`]);
  if (loader) facets.push([`categories:${loader}`]);
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  return facets.length ? JSON.stringify(facets) : null;
}

export async function searchProjects({ query = '', type = 'mod', loader, mcVersion, limit = 24, offset = 0, index = 'relevance' }) {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    offset: String(offset),
    index,
  });
  const facets = buildFacets({ type, loader, mcVersion });
  if (facets) params.set('facets', facets);

  const data = await fetchJson(`${API}/search?${params.toString()}`);
  return {
    total: data.total_hits ?? 0,
    offset,
    hits: (data.hits ?? []).map((hit) => ({
      id: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      icon: hit.icon_url,
      downloads: hit.downloads,
      type: hit.project_type,
      versions: hit.versions ?? [],
      categories: hit.categories ?? [],
      categoriesZh: zhCategories(hit.categories ?? []),
    })),
  };
}

async function pickVersion(projectId, { loader, mcVersion }) {
  const params = new URLSearchParams();
  if (loader) params.set('loaders', JSON.stringify([loader]));
  if (mcVersion) params.set('game_versions', JSON.stringify([mcVersion]));
  const list = await fetchJson(`${API}/project/${encodeURIComponent(projectId)}/version?${params.toString()}`);
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[0];
}

export const CATEGORY_ZH = {
  optimization: '性能优化',
  technology: '科技',
  magic: '魔法',
  adventure: '冒险',
  decoration: '装饰',
  storage: '存储',
  worldgen: '世界生成',
  mobs: '生物',
  equipment: '装备',
  food: '食物',
  utility: '实用',
  library: '前置库',
  transport: '交通',
  'game-mechanics': '机制',
  building: '建筑',
  management: '管理',
  minigame: '小游戏',
  social: '社交',
};

export function zhCategories(categories = []) {
  const out = categories.map((name) => CATEGORY_ZH[name] ?? name);
  return [...new Set(out)].slice(0, 4);
}

async function fetchProjects(ids) {
  if (ids.length === 0) return [];
  const params = new URLSearchParams({ ids: JSON.stringify(ids) });
  return fetchJson(`${API}/projects?${params.toString()}`);
}

export async function analyzeProjects({ projectIds, mcVersion, loader = 'fabric' }) {
  const ids = [...new Set(projectIds.filter(Boolean))];
  const [projects, versions] = await Promise.all([
    fetchProjects(ids).catch(() => []),
    Promise.all(ids.map((id) => pickVersion(id, { loader, mcVersion }).catch(() => null))),
  ]);
  const byId = new Map(projects.map((project) => [project.id, project]));

  const depIds = new Set();
  for (const version of versions) {
    for (const dep of version?.dependencies ?? []) {
      if (dep.project_id) depIds.add(dep.project_id);
    }
  }
  const depProjects = await fetchProjects([...depIds]).catch(() => []);
  const depById = new Map(depProjects.map((project) => [project.id, project]));

  const selected = new Set(ids);
  const result = ids.map((id, index) => {
    const project = byId.get(id) ?? {};
    const version = versions[index];
    const reasons = [];
    const dependencies = [];
    const incompatibleWith = [];

    if (!version) reasons.push(`没有适配 Minecraft ${mcVersion} / ${loader} 的版本`);

    for (const dep of version?.dependencies ?? []) {
      const depProject = dep.project_id ? depById.get(dep.project_id) : null;
      const name = depProject?.title ?? dep.project_id ?? '';
      if (dep.dependency_type === 'required' && dep.project_id) {
        dependencies.push({ id: dep.project_id, title: name, type: 'required' });
      } else if (dep.dependency_type === 'incompatible' && dep.project_id && selected.has(dep.project_id)) {
        incompatibleWith.push(name || dep.project_id);
      }
    }

    if (incompatibleWith.length > 0) reasons.push(`与已选模组不兼容：${incompatibleWith.join('、')}`);

    return {
      id,
      title: project.title ?? id,
      description: project.description ?? '',
      icon: project.icon_url ?? null,
      categories: zhCategories(project.categories ?? []),
      downloads: project.downloads ?? 0,
      versionNumber: version?.version_number ?? null,
      dependencies,
      reasons,
      conflict: reasons.length > 0,
    };
  });

  return {
    projects: result,
    conflicts: result.filter((item) => item.conflict).map((item) => ({ title: item.title, reasons: item.reasons })),
  };
}

export async function installMod(projectId, { mcVersion, loader = 'fabric', instance, sourceName = 'auto' } = {}) {
  if (!mcVersion) throw new Error('缺少目标 Minecraft 版本');
  const loaderKind = String(loader).toLowerCase();
  if (!['fabric', 'forge', 'neoforge'].includes(loaderKind)) {
    throw new Error(`不支持的加载器：${loader}（可用 fabric / forge / neoforge）`);
  }

  const version = await pickVersion(projectId, { loader: loaderKind, mcVersion });
  if (!version) throw new Error('这个模组没有适配当前版本的文件');

  const target = await resolveTargetInstance({ instance, loaderKind, mcVersion, sourceName });

  const file = version.files.find((item) => item.primary) ?? version.files[0];
  if (!file) throw new Error('这个版本没有可下载文件');

  const dest = path.join(instanceModsDir(target), file.filename);
  step(`下载 ${file.filename}`);
  await download({ url: file.url, dest, sha1: file.hashes?.sha1, size: file.size });
  ok(`已安装到 ${target}/mods`);

  return { instance: target, file: file.filename, title: version.name ?? projectId };
}

/**
 * 决定把模组装进哪个实例：
 * - 明确指定了实例（插件里选中的那个）→ 就用它，不再另建
 * - 没指定：Fabric 自动建 fabric-<mc>-mods；Forge/NeoForge 复用/新建对应加载器实例
 */
async function resolveTargetInstance({ instance, loaderKind, mcVersion, sourceName }) {
  if (instance) {
    const dir = versionDir(instance);
    if (!fs.existsSync(path.join(dir, `${instance}.json`))) {
      throw new Error(`找不到实例：${instance}`);
    }
    step(`安装到已有实例 ${instance}`);
    return instance;
  }
  if (loaderKind === 'fabric') {
    step(`准备 Fabric 实例（${mcVersion}）`);
    return ensureInstance(mcVersion, 'mods', { sourceName });
  }
  step(`准备 ${loaderKind} 实例（${mcVersion}）`);
  return ensureLoaderInstance(loaderKind, mcVersion, { sourceName });
}

export async function installModsBatch(projectIds, { mcVersion, loader = 'fabric', instance, sourceName = 'auto' } = {}) {
  if (!mcVersion) throw new Error('缺少目标 Minecraft 版本');
  const loaderKind = String(loader).toLowerCase();
  if (!['fabric', 'forge', 'neoforge'].includes(loaderKind)) {
    throw new Error(`不支持的加载器：${loader}（可用 fabric / forge / neoforge）`);
  }

  const instanceId = await resolveTargetInstance({ instance, loaderKind, mcVersion, sourceName });

  const wanted = [...new Set(projectIds)];
  const resolved = new Map();
  const missing = new Set();
  // 前置可能还带前置：一层层往外展开（最多 4 层，防环）
  let queue = wanted;
  for (let depth = 0; depth < 4 && queue.length > 0; depth += 1) {
    const next = [];
    for (const id of queue) {
      if (resolved.has(id) || missing.has(id)) continue;
      const version = await pickVersion(id, { loader, mcVersion }).catch(() => null);
      if (!version) {
        missing.add(id);
        warn(`跳过 ${id}：没有适配版本`);
        continue;
      }
      resolved.set(id, version);
      for (const dep of version.dependencies ?? []) {
        if (dep.dependency_type !== 'required' || !dep.project_id) continue;
        if (!resolved.has(dep.project_id) && !missing.has(dep.project_id)) next.push(dep.project_id);
      }
    }
    queue = [...new Set(next)];
  }

  const modsDir = instanceModsDir(instanceId);
  const installed = [];
  const tasks = [...resolved.entries()];
  const progress = new Progress('mods', tasks.length, { count: true });
  // 并发 5 个，串行下载 51 个文件要 9 分钟，并发后能压到 2-3 分钟
  await runPool(
    tasks,
    async ([id, version]) => {
      const file = version.files.find((item) => item.primary) ?? version.files[0];
      if (file) {
        step(`下载 ${version.name ?? id}`);
        await download({
          url: file.url,
          dest: path.join(modsDir, file.filename),
          sha1: file.hashes?.sha1,
          size: file.size,
        });
        installed.push(file.filename);
      }
      progress.add(1);
    },
    5,
  );
  progress.finish(`模组下载完成（${installed.length} 个）`);
  return { instance: instanceId, count: installed.length, files: installed };
}

export async function installModpack(projectId, { mcVersion, sourceName = 'auto' } = {}) {
  const version = await pickVersion(projectId, { mcVersion });
  const file =
    version?.files.find((item) => item.filename.endsWith('.mrpack')) ??
    version?.files.find((item) => item.primary) ??
    version?.files[0];
  if (!file) throw new Error('这个整合包没有可下载文件');

  const tmp = path.join(GAME_DIR, 'packages', file.filename);
  step(`下载整合包 ${file.filename}`);
  await download({ url: file.url, dest: tmp, sha1: file.hashes?.sha1, size: file.size });

  const zip = openZipBuffer(fs.readFileSync(tmp), file.filename);
  const indexEntry = zip.entries.find((entry) => entry.name === 'modrinth.index.json');
  if (!indexEntry) throw new Error('不是有效的 mrpack（缺少 modrinth.index.json）');
  const index = JSON.parse(zip.read(indexEntry).toString('utf8'));

  const deps = index.dependencies ?? {};
  const packMc = mcVersion ?? deps.minecraft;
  if (!packMc) throw new Error('整合包没有声明 Minecraft 版本');

  // 按 dependencies 分派加载器：fabric-loader / forge / neoforge
  let loaderKind = 'fabric';
  let loaderVersion;
  if (deps['fabric-loader']) {
    loaderKind = 'fabric';
    loaderVersion = deps['fabric-loader'];
  } else if (deps.neoforge) {
    loaderKind = 'neoforge';
    loaderVersion = deps.neoforge;
  } else if (deps.forge) {
    loaderKind = 'forge';
    loaderVersion = deps.forge;
  } else {
    const loaderText = deps['quilt-loader'] ? 'Quilt' : '其他加载器';
    throw new Error(`这个整合包需要 ${loaderText}，目前支持 Fabric / Forge / NeoForge`);
  }

  step(`准备整合包实例（${packMc} / ${loaderKind} / ${projectId}）`);
  const instance = loaderKind === 'fabric'
    ? await ensureInstance(packMc, projectId, { sourceName })
    : (await installLoader(loaderKind, packMc, {
      loaderVersion,
      sourceName,
      instanceId: `${loaderKind}-${packMc}-${String(projectId).slice(0, 12)}`,
    })).id;
  const instanceRoot = versionDir(instance);
  ensureDir(instanceRoot);

  const files = index.files ?? [];
  if (files.length > 0) {
    step(`下载整合包内容（${files.length} 个文件）`);
    const progress = new Progress('pack files', files.length, { count: true });
    await runPool(
      files,
      async (item) => {
        const url = item.downloads?.[0];
        const rel = String(item.path ?? '').replace(/^\/+/, '');
        if (url && rel) {
          await download({ url, dest: path.join(instanceRoot, rel), sha1: item.hashes?.sha1, size: item.fileSize });
        }
        progress.add(1);
      },
      6,
    );
    progress.finish('整合包内容下载完成');
  }

  const overrides = zip.entries.filter(
    (entry) => entry.name.startsWith('overrides/') || entry.name.startsWith('client-overrides/'),
  );
  if (overrides.length > 0) {
    step(`写入覆盖文件（${overrides.length} 个）`);
    for (const entry of overrides) {
      if (entry.isDir) continue;
      const rel = entry.name.replace(/^(client-)?overrides\//, '');
      const dest = path.join(instanceRoot, rel);
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, zip.read(entry));
    }
  }

  ok(`整合包已安装到 ${instance}`);
  return { instance, name: index.name ?? file.filename, version: index.versionId ?? '', files: files.length };
}

/** 安装光影包：下载到目标实例的 shaderpacks */
export async function installShader(projectId, { mcVersion, instance, sourceName = 'auto' } = {}) {
  const targetInstance = instance || (await ensureFabricInstance(mcVersion, { sourceName }));
  const version = await pickVersion(projectId, {});
  const file =
    version?.files.find((item) => item.filename.endsWith('.zip')) ?? version?.files[0];
  if (!file) throw new Error('这个光影包没有可下载文件');

  const shaderDir = path.join(versionDir(targetInstance), 'shaderpacks');
  ensureDir(shaderDir);
  const dest = path.join(shaderDir, file.filename);
  step(`下载光影 ${file.filename}`);
  await download({ url: file.url, dest, sha1: file.hashes?.sha1, size: file.size });

  // 没有 Iris/OptiFine 的话，光影装了也不会生效
  let hasShaderLoader = false;
  try {
    const mods = fs.readdirSync(path.join(versionDir(targetInstance), 'mods'));
    hasShaderLoader = mods.some((name) => /iris|oculus|optifine/i.test(name));
  } catch {
    hasShaderLoader = false;
  }

  ok(`已安装到 ${targetInstance}/shaderpacks`);
  return { instance: targetInstance, file: file.filename, title: version.name ?? projectId, hasShaderLoader };
}

export async function getProjectDetail(projectId, { mcVersion, loader = 'fabric' } = {}) {
  const [project, version] = await Promise.all([
    fetchJson(`${API}/project/${encodeURIComponent(projectId)}`),
    mcVersion ? pickVersion(projectId, { loader, mcVersion }).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    id: project.id,
    slug: project.slug,
    title: project.title,
    description: project.description ?? '',
    icon: project.icon_url ?? null,
    downloads: project.downloads ?? 0,
    followers: project.followers ?? 0,
    categories: zhCategories(project.categories ?? []),
    loaders: project.loaders ?? [],
    gameVersions: (project.game_versions ?? []).slice(-8),
    body: project.body ?? '',
    sourceUrl: project.source_url ?? '',
    issuesUrl: project.issues_url ?? '',
    version: version ? { number: version.version_number, date: version.date_published } : null,
    dependencies: (version?.dependencies ?? [])
      .filter((dep) => dep.project_id)
      .map((dep) => ({ id: dep.project_id, type: dep.dependency_type })),
  };
}

/**
 * 把本地 jar 里写的 mod id（fabric.mod.json / mods.toml 里的 depends 键）
 * 反查成 Modrinth 项目，好让界面直接给「一键装缺失前置」。
 * 先按 slug 直接查，查不到再搜索取命中。
 */
export async function resolveModIds(ids, { loader, mcVersion } = {}) {
  const unique = [...new Set((ids ?? []).map((id) => String(id).trim()).filter(Boolean))];
  const found = [];
  const missing = [];

  await runPool(
    unique,
    async (id) => {
      try {
        const project = await fetchJson(`${API}/project/${encodeURIComponent(id)}`).catch(() => null);
        if (project && project.id) {
          found.push({
            modId: id,
            projectId: project.id,
            slug: project.slug,
            title: project.title,
            icon: project.icon_url ?? null,
            downloads: project.downloads ?? 0,
            guess: false,
          });
          return;
        }

        const facets = [['project_type:mod']];
        if (loader) facets.push([`categories:${loader}`]);
        if (mcVersion) facets.push([`versions:${mcVersion}`]);
        const params = new URLSearchParams({ query: id, limit: '5', facets: JSON.stringify(facets) });
        const data = await fetchJson(`${API}/search?${params.toString()}`).catch(() => null);
        const hits = data?.hits ?? [];
        const hit =
          hits.find((item) => String(item.slug ?? '').toLowerCase() === id.toLowerCase()) ??
          hits.find((item) => String(item.title ?? '').toLowerCase().replace(/\s+/g, '-') === id.toLowerCase()) ??
          null;
        if (hit) {
          found.push({
            modId: id,
            projectId: hit.project_id,
            slug: hit.slug,
            title: hit.title,
            icon: hit.icon_url ?? null,
            downloads: hit.downloads ?? 0,
            guess: String(hit.slug ?? '').toLowerCase() !== id.toLowerCase(),
          });
        } else {
          missing.push(id);
        }
      } catch {
        missing.push(id);
      }
    },
    4,
  );

  return { found, missing };
}
