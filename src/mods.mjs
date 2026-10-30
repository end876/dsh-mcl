import { openZipBuffer } from './zip.mjs';

export const LOADER_LABELS = {
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
};

function readText(zip, name) {
  const entry = zip.entries.find((e) => e.name === name);
  return entry ? zip.read(entry).toString('utf8') : null;
}

function readJson(zip, name) {
  const text = readText(zip, name);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从版本约束里抽出出现的 Minecraft 版本号 */
export function versionHints(constraint) {
  if (!constraint) return [];
  const text = Array.isArray(constraint) ? constraint.join(' ') : String(constraint);
  const out = new Set();
  for (const match of text.matchAll(/\b(1\.\d{1,2}(?:\.\d{1,2})?)\b/g)) {
    if (match[1] === '1.0') continue;
    out.add(match[1]);
  }
  return [...out];
}

/** 从文件名投票猜 Minecraft 版本（扁平化整合包没有 inheritsFrom 时用） */
export function inferMcFromNames(names) {
  const counts = new Map();
  for (const name of names) {
    const base = String(name).split('/').pop();
    for (const match of base.matchAll(/(1\.\d{1,2}(?:\.\d{1,2})?)/g)) {
      const version = match[1];
      // 只接受像样的 Minecraft 版本号，避免把模组版本 1.1.0 / 1.2.0 也算进来
      const minor = Number(version.split('.')[1]);
      if (!Number.isFinite(minor) || minor < 7 || minor > 30) continue;
      counts.set(version, (counts.get(version) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? sorted[0][0] : null;
}

function parseModsToml(text) {
  const result = { modLoader: null, mods: [], dependencies: [] };
  let current = null;
  const kv = (line) => {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s#]+))/);
    if (!m) return null;
    return { key: m[1], value: m[2] ?? m[3] ?? m[4] };
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[[')) {
      const name = line.replace(/\[\[|\]\]/g, '').trim();
      if (name === 'mods') current = {};
      else if (name.startsWith('dependencies.')) current = {};
      else current = null;
      if (name === 'mods' && current) result.mods.push(current);
      if (name.startsWith('dependencies.') && current) result.dependencies.push(current);
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    const pair = kv(line);
    if (!pair) continue;
    if (pair.key === 'modLoader') result.modLoader = pair.value;
    if (current) current[pair.key] = pair.value;
  }
  return result;
}

function detectModpack(zip) {
  const names = new Set(zip.entries.map((e) => e.name));
  if (names.has('modrinth.index.json')) {
    const index = readJson(zip, 'modrinth.index.json') ?? {};
    const deps = index.dependencies ?? {};
    let loader = null;
    if (deps['fabric-loader']) loader = 'fabric';
    else if (deps['quilt-loader']) loader = 'quilt';
    else if (deps['neoforge']) loader = 'neoforge';
    else if (deps['forge']) loader = 'forge';
    return {
      kind: 'modpack',
      format: 'Modrinth (.mrpack)',
      name: index.name ?? '未命名整合包',
      version: index.versionId ?? '',
      loader,
      loaderLabel: loader ? LOADER_LABELS[loader] : '未知',
      loaderVersion: loader ? deps[`${loader}-loader`] ?? deps[loader] ?? null : null,
      mcConstraint: deps.minecraft ?? null,
      files: (index.files ?? []).length,
      summary: null,
    };
  }

  if (names.has('manifest.json')) {
    const manifest = readJson(zip, 'manifest.json');
    const mc = manifest?.minecraft ?? {};
    const primary = (mc.modLoaders ?? []).find((item) => item.primary) ?? (mc.modLoaders ?? [])[0];
    let loader = null;
    if (primary?.id) {
      if (primary.id.startsWith('fabric')) loader = 'fabric';
      else if (primary.id.startsWith('quilt')) loader = 'quilt';
      else if (primary.id.startsWith('neoforge')) loader = 'neoforge';
      else if (primary.id.startsWith('forge')) loader = 'forge';
    }
    return {
      kind: 'modpack',
      format: 'CurseForge',
      name: manifest?.name ?? '未命名整合包',
      version: manifest?.version ?? '',
      loader,
      loaderLabel: loader ? LOADER_LABELS[loader] : '原版',
      loaderVersion: primary?.id ?? null,
      mcConstraint: mc.version ?? null,
      files: (manifest?.files ?? []).length,
      summary: null,
    };
  }

  return null;
}

/**
 * 识别一个压缩包（mod jar 或整合包）。
 * 返回结构化的识别结果，供界面决定"该装哪个框架"。
 */
/** 本地 jar 里「不是前置、是平台本身」的依赖，不用去装 */
const PLATFORM_DEPS = new Set(['minecraft', 'fabricloader', 'quilt_loader', 'forge', 'neoforge', 'java', 'fabric-language-kotlin']);

/** 从 depends 表里挑出真正要装的前置 */
function pickDeps(depends = {}) {
  return Object.entries(depends)
    .filter(([id]) => !PLATFORM_DEPS.has(id))
    .map(([id, range]) => ({ id, range: typeof range === 'string' ? range : null }));
}

export function inspectArchive(buf, fileName = '') {
  let zip;
  try {
    zip = openZipBuffer(buf, fileName);
  } catch (error) {
    throw new Error(`无法读取压缩包：${error.message}`);
  }

  const names = new Set(zip.entries.map((e) => e.name));
  const modpack = detectModpack(zip);
  if (modpack) return { file: fileName, ...modpack, hint: buildHint(modpack) };

  // Fabric / Quilt
  if (names.has('fabric.mod.json')) {
    const meta = readJson(zip, 'fabric.mod.json') ?? {};
    const mc = meta.depends?.minecraft ?? null;
    const result = {
      kind: 'mod',
      format: 'Fabric mod',
      loader: 'fabric',
      loaderLabel: 'Fabric',
      id: meta.id ?? '',
      name: meta.name ?? meta.id ?? fileName,
      version: typeof meta.version === 'string' ? meta.version : String(meta.version ?? ''),
      mcConstraint: mc ?? inferMcFromNames([fileName]),
      loaderConstraint: meta.depends?.fabricloader ?? null,
      description: typeof meta.description === 'string' ? meta.description : '',
      depends: pickDeps(meta.depends),
      hint: null,
    };
    result.hint = buildHint(result);
    return { file: fileName, ...result };
  }

  if (names.has('quilt.mod.json')) {
    const meta = readJson(zip, 'quilt.mod.json') ?? {};
    const ql = meta.quilt_loader ?? {};
    const result = {
      kind: 'mod',
      format: 'Quilt mod',
      loader: 'quilt',
      loaderLabel: 'Quilt',
      id: ql.id ?? '',
      name: ql.metadata?.name ?? ql.id ?? fileName,
      version: String(ql.version ?? ''),
      mcConstraint: ql.depends?.minecraft ?? null,
      loaderConstraint: ql.depends?.quilt_loader ?? null,
      description: '',
      depends: pickDeps(ql.depends),
      hint: null,
    };
    result.hint = buildHint(result);
    return { file: fileName, ...result };
  }

  // Forge / NeoForge
  const tomlName = names.has('META-INF/neoforge.mods.toml')
    ? 'META-INF/neoforge.mods.toml'
    : names.has('META-INF/mods.toml')
      ? 'META-INF/mods.toml'
      : null;

  if (tomlName) {
    const text = readText(zip, tomlName) ?? '';
    const parsed = parseModsToml(text);
    const isNeo = tomlName.includes('neoforge');
    const first = parsed.mods[0] ?? {};
    const mcDep = parsed.dependencies.find((dep) => dep.modId === 'minecraft');
    const result = {
      kind: 'mod',
      format: isNeo ? 'NeoForge mod' : 'Forge mod',
      loader: isNeo ? 'neoforge' : 'forge',
      loaderLabel: isNeo ? 'NeoForge' : 'Forge',
      id: first.modId ?? '',
      name: first.displayName ?? first.modId ?? fileName,
      version: String(first.version ?? ''),
      mcConstraint: mcDep?.versionRange ?? null,
      loaderConstraint: parsed.modLoader ?? null,
      description: String(first.description ?? '').slice(0, 300),
      depends: parsed.dependencies
        .filter((dep) => dep.modId && !PLATFORM_DEPS.has(dep.modId) && String(dep.mandatory ?? 'true') !== 'false')
        .map((dep) => ({ id: dep.modId, range: dep.versionRange ?? null })),
      ambiguous: !isNeo,
      hint: null,
    };
    result.hint = buildHint(result);
    return { file: fileName, ...result };
  }

  // 「解压即玩」整合包：PCL 版本隔离布局（.minecraft/versions/<名字>/<名字>.json）
  const versionJson = [...names].find((name) => /^\.minecraft\/versions\/[^/]+\/[^/]+\.json$/.test(name));
  if (versionJson) {
    let meta = null;
    try {
      meta = readJson(zip, versionJson);
    } catch {
      meta = null;
    }
    const dir = versionJson.slice(0, versionJson.lastIndexOf('/'));
    const modFiles = [...names].filter((name) => name.startsWith(`${dir}/mods/`) && name.endsWith('.jar'));
    const modsCount = modFiles.length;
    const mainClass = String(meta?.mainClass ?? '');
    let loader = null;
    if (mainClass.includes('fabric')) loader = 'fabric';
    else if (mainClass.includes('quilt')) loader = 'quilt';
    else if (mainClass.includes('neoforge') || mainClass.includes('neoforged')) loader = 'neoforge';
    else if (mainClass.includes('forge') || mainClass.includes('modlauncher') || mainClass.includes('cpw.mods')) loader = 'forge';
    // PCL 合并后的 json 往往没有 inheritsFrom，从 mod 文件名投票推断
    const inferred = meta?.inheritsFrom ?? inferMcFromNames(modFiles);
    const result = {
      kind: 'modpack',
      format: '解压即玩整合包（PCL 版本隔离布局）',
      name: meta?.id ?? dir.split('/').pop(),
      version: meta?.id ?? '',
      loader,
      loaderLabel: loader ? LOADER_LABELS[loader] : '原版',
      loaderVersion: meta?.inheritsFrom ?? null,
      mcConstraint: inferred ?? null,
      files: modsCount,
      summary: null,
      hint: null,
    };
    result.hint = `这是「解压即玩」整合包：自带游戏目录和 ${modsCount} 个 mod${loader ? `（${LOADER_LABELS[loader]}）` : ''}${
      inferred ? `，游戏版本推断为 ${inferred}` : ''
    }。导入时不需要联网下载本体，直接解压即可。`;
    return { file: fileName, ...result };
  }

  return {
    file: fileName,
    kind: 'unknown',
    format: '未识别',
    loader: null,
    loaderLabel: '未知',
    hint: '没找到 fabric.mod.json / mods.toml，可能不是模组，或者是资源包/光影。',
  };
}

function buildHint(info) {
  const hints = versionHints(info.mcConstraint);
  const mcText = hints.length ? `Minecraft ${hints.join(' / ')}` : 'Minecraft';

  if (info.kind === 'modpack') {
    const loader = info.loader ? info.loaderLabel : '原版';
    return `这是 ${info.format} 整合包，本体是 ${loader} ${mcText === 'Minecraft' ? '' : mcText}`.replace('  ', ' ');
  }

  const loader = info.loaderLabel;
  if (info.ambiguous) {
    return `这是 Forge 格式的模组。注意：1.20.1 的 NeoForge 也使用 mods.toml，无法只靠元数据区分，需要按目标版本选择 ${loader} 或 NeoForge。`;
  }
  return `这是一个 ${loader} 模组，目标 ${mcText}${info.mcConstraint ? `（版本约束 ${fmtConstraint(info.mcConstraint)}）` : ''}。`;
}

function fmtConstraint(constraint) {
  if (Array.isArray(constraint)) return constraint.join(', ');
  return String(constraint);
}
