import { ARCH, ARCH_BITS, OS_NAME } from './paths.mjs';

/** Mojang 规则：后一条匹配的规则覆盖前一条，默认拒绝 */
export function rulesAllowed(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (!ruleMatches(rule, features)) continue;
    allowed = rule.action === 'allow';
  }
  return allowed;
}

function ruleMatches(rule, features) {
  if (rule.os) {
    const os = rule.os;
    if (os.name && os.name !== OS_NAME) return false;
    if (os.arch) {
      if (os.arch === 'x86' && ARCH_BITS !== '32') return false;
      if (os.arch === 'arm64' && ARCH !== 'aarch64') return false;
    }
    if (os.version) {
      // 少数老版本会用正则匹配系统版本，本机情况不精确，直接放行
    }
  }
  if (rule.features) {
    for (const [key, value] of Object.entries(rule.features)) {
      if (Boolean(features[key]) !== Boolean(value)) return false;
    }
  }
  return true;
}

/** group:artifact:version[:classifier][@ext] -> maven 相对路径 */
export function mavenPath(name) {
  const [coords, ext = 'jar'] = name.split('@');
  const parts = coords.split(':');
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) throw new Error(`无法解析的 maven 坐标：${name}`);
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

export function libraryRelPath(lib) {
  return lib.downloads?.artifact?.path ?? mavenPath(lib.name);
}

export function librarySha1(lib) {
  return lib.downloads?.artifact?.sha1;
}

export function librarySize(lib) {
  return lib.downloads?.artifact?.size;
}

/**
 * 返回需要解压进 natives 目录的 jar 列表（统一成 {path, url, sha1, size}）。
 * 兼容两种格式：
 *  1. 老格式：libraries[].natives + downloads.classifiers
 *  2. 新格式（1.19+）：独立的 :natives-windows 库
 */
export function nativeArtifacts(lib) {
  const result = [];

  if (lib.natives) {
    const key = lib.natives[OS_NAME];
    if (!key) return result;
    const classifier = String(key).replace('${arch}', ARCH_BITS);
    const dl = lib.downloads?.classifiers?.[classifier];
    if (!dl) return result;
    result.push({ path: dl.path, url: dl.url, sha1: dl.sha1, size: dl.size });
    return result;
  }

  const classifier = lib.name.split('@')[0].split(':')[3];
  if (!classifier || !classifier.startsWith('natives-')) return result;
  if (classifier.includes('arm64') && ARCH !== 'aarch64') return result;
  if (classifier.endsWith('-x86') && ARCH_BITS !== '32') return result;

  const dl = lib.downloads?.artifact;
  if (!dl?.url) return result;
  result.push({ path: dl.path, url: dl.url, sha1: dl.sha1, size: dl.size });
  return result;
}

export function filterLibraries(libraries, features = {}) {
  return (libraries ?? []).filter((lib) => rulesAllowed(lib.rules, features));
}

/**
 * 处理 inheritsFrom 继承链：父在前，子覆盖父。
 * lookup(id) 需要返回父版本 json（本地或远程）。
 */
export function resolveVersionChain(versionJson, lookup) {
  const chain = [versionJson];
  const seen = new Set([versionJson.id]);
  let current = versionJson;

  while (current.inheritsFrom) {
    if (seen.has(current.inheritsFrom)) throw new Error(`版本继承出现循环：${current.inheritsFrom}`);
    seen.add(current.inheritsFrom);
    const parent = lookup(current.inheritsFrom);
    if (!parent) throw new Error(`找不到父版本：${current.inheritsFrom}`);
    chain.unshift(parent);
    current = parent;
  }

  const merged = {};
  const libraries = [];
  const jvmArgs = [];
  const gameArgs = [];
  let legacyArgs = null;

  for (const layer of chain) {
    for (const [key, value] of Object.entries(layer)) {
      if (key === 'libraries' || key === 'arguments' || key === 'minecraftArguments') continue;
      merged[key] = value;
    }
    if (layer.libraries) libraries.push(...layer.libraries);
    if (layer.minecraftArguments) legacyArgs = layer.minecraftArguments;
    if (layer.arguments?.jvm) jvmArgs.push(...layer.arguments.jvm);
    if (layer.arguments?.game) gameArgs.push(...layer.arguments.game);
  }

  merged.libraries = libraries;
  merged.arguments = { jvm: jvmArgs, game: gameArgs };
  if (legacyArgs) merged.legacyArguments = legacyArgs;
  return merged;
}

/** 把老的 minecraftArguments 字符串拆成参数数组 */
export function legacyGameArgs(str) {
  return str.split(/\s+/).filter(Boolean);
}

/** 从版本清单里挑版本，支持 latest / latest-snapshot / 前缀匹配 */
export function pickVersion(manifest, target) {
  const wanted = (target || 'latest').trim();
  const versions = manifest.versions ?? [];

  if (wanted === 'latest' || wanted === 'release' || wanted === 'latest-release') {
    return versions.find((v) => v.id === manifest.latest?.release) ?? versions[0];
  }
  if (wanted === 'snapshot' || wanted === 'latest-snapshot') {
    return versions.find((v) => v.id === manifest.latest?.snapshot);
  }

  const exact = versions.find((v) => v.id === wanted);
  if (exact) return exact;

  const prefix = versions.filter((v) => v.id.startsWith(wanted));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    const releases = prefix.filter((v) => v.type === 'release');
    if (releases.length >= 1) return releases[0];
    return prefix[0];
  }
  return null;
}

/** 参数里的 ${var} 替换 */
export function substitute(value, vars) {
  return String(value).replace(/\$\{([^}]+)\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name) && vars[name] != null) return String(vars[name]);
    return match;
  });
}

/** 展开 arguments 里可能存在的 rules / value 结构 */
export function expandArguments(entries, features = {}) {
  const out = [];
  for (const entry of entries ?? []) {
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object') {
      if (!rulesAllowed(entry.rules, features)) continue;
      const value = entry.value;
      if (Array.isArray(value)) out.push(...value);
      else if (typeof value === 'string') out.push(value);
    }
  }
  return out;
}

export function isLibraryAllowed(lib, features = {}) {
  return rulesAllowed(lib.rules, features);
}

export { OS_NAME, ARCH, ARCH_BITS };
