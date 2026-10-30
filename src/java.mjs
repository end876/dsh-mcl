import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ARCH, IS_WINDOWS, RUNTIME_DIR, ensureDir, exists } from './paths.mjs';
import { download, fetchBuffer, fileSize } from './http.mjs';
import { extractZip } from './zip.mjs';
import { Progress, info, ok, step, warn } from './log.mjs';

const ADOPTIUM = 'https://api.adoptium.net/v3';

export function parseJavaMajor(versionString) {
  const parts = String(versionString).split(/[.\-_+]/);
  let major = Number.parseInt(parts[0], 10);
  if (major === 1 && parts[1]) major = Number.parseInt(parts[1], 10);
  return Number.isFinite(major) ? major : 0;
}

/** 读取某个 java 可执行文件的版本；读不到返回 major=0 */
export function readJavaVersion(exe) {
  try {
    const res = spawnSync(exe, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    });
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    const match = text.match(/version "([^"]+)"/i);
    return { major: match ? parseJavaMajor(match[1]) : 0, raw: match?.[1] ?? '', text };
  } catch {
    return { major: 0, raw: '', text: '' };
  }
}

function whereJava() {
  const found = [];
  try {
    const res = spawnSync(IS_WINDOWS ? 'where' : 'which', ['java'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    for (const line of (res.stdout ?? '').split(/\r?\n/)) {
      const p = line.trim();
      if (p) found.push(p);
    }
  } catch {
    /* ignore */
  }
  return found;
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/** 扫描本机可能存在的 java，返回可执行文件路径列表 */
export function scanJavaCandidates() {
  const candidates = new Set();
  const exe = IS_WINDOWS ? 'java.exe' : 'java';

  if (process.env.JAVA_HOME) candidates.add(path.join(process.env.JAVA_HOME, 'bin', exe));
  for (const p of whereJava()) candidates.add(p);

  const roots = [];
  if (IS_WINDOWS) {
    roots.push(path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Java'));
    roots.push(path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Eclipse Adoptium'));
    roots.push(path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft'));
    roots.push(path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Zulu'));
    roots.push(path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Java'));
    roots.push(path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Eclipse Adoptium'));
  } else {
    roots.push('/usr/lib/jvm');
    roots.push('/Library/Java/JavaVirtualMachines');
  }

  for (const root of roots) {
    for (const dir of listDirs(root)) {
      candidates.add(path.join(dir, 'bin', exe));
      candidates.add(path.join(dir, 'Contents', 'Home', 'bin', exe));
    }
  }

  // 启动器自己下载的运行时
  for (const dir of listDirs(RUNTIME_DIR)) {
    candidates.add(path.join(dir, 'bin', exe));
    for (const inner of listDirs(dir)) candidates.add(path.join(inner, 'bin', exe));
  }

  return [...candidates].filter((p) => exists(p));
}

/** 找一个满足 major 的 Java；有 exact 优先 */
export function findJava(major) {
  const seen = [];
  let best = null;
  for (const exe of scanJavaCandidates()) {
    const v = readJavaVersion(exe);
    if (!v.major) continue;
    seen.push({ exe, major: v.major, raw: v.raw });
    if (v.major === major) return { exe, major: v.major, raw: v.raw, source: '系统已安装', all: seen };
    if (v.major > major && (!best || v.major < best.major)) best = { exe, major: v.major, raw: v.raw };
  }
  return best ? { ...best, source: '系统已安装（版本偏高）', all: seen } : { all: seen };
}

function adoptiumBinaryUrl(major) {
  const arch = ARCH === 'aarch64' ? 'aarch64' : ARCH === 'x86' ? 'x86' : 'x64';
  const os = IS_WINDOWS ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  return `${ADOPTIUM}/binary/latest/${major}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`;
}

/** 清华镜像目录里有最新的 JRE zip，国内下载快得多 */
async function tunaJreUrl(major) {
  const arch = ARCH === 'aarch64' ? 'aarch64' : 'x64';
  const os = IS_WINDOWS ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const dir = `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${major}/jre/${arch}/${os}/`;
  const html = (await fetchBuffer(dir, { timeout: 20_000 })).toString('utf8');
  const names = [...html.matchAll(/href="([^"]+\.zip)"/g)].map((m) => m[1]);
  if (names.length === 0) return null;
  const preferred = names.find((name) => name.includes(`_jre_${arch}_`)) ?? names[0];
  return dir + encodeURIComponent(preferred);
}

async function jreUrls(major) {
  const urls = [];
  try {
    const mirror = await tunaJreUrl(major);
    if (mirror) urls.push(mirror);
  } catch {
    /* 镜像不可用就跳过 */
  }
  urls.push(adoptiumBinaryUrl(major));
  return urls;
}

/** 下载并解压一个 JRE */
export async function downloadJava(major) {
  ensureDir(RUNTIME_DIR);
  const targetDir = path.join(RUNTIME_DIR, `jre-${major}`);
  const exe = path.join(targetDir, 'bin', IS_WINDOWS ? 'java.exe' : 'java');
  if (exists(exe)) return exe;

  step(`下载 Java ${major} 运行时`);
  const zipPath = path.join(RUNTIME_DIR, `jre-${major}.zip`);
  const urls = await jreUrls(major);

  let downloaded = false;
  let lastError;
  for (const url of urls) {
    const progress = new Progress(`JRE ${major}`, 0);
    try {
      info(`来源：${new URL(url).host}`);
      await download({
        url,
        dest: zipPath,
        retries: 1,
        onTotal: (total) => {
          if (total > 0) progress.setTotal(total);
        },
        onBytes: (n) => progress.add(n),
      });
      progress.finish(`JRE ${major} 下载完成（${(fileSize(zipPath) / 1024 / 1024).toFixed(1)} MB）`);
      downloaded = true;
      break;
    } catch (error) {
      progress.finish();
      warn(`下载失败：${error.message}`);
      lastError = error;
    }
  }
  if (!downloaded) throw lastError ?? new Error('JRE 下载失败');

  step('解压运行时');
  extractZip(zipPath, targetDir);
  fs.rmSync(zipPath, { force: true });

  if (exists(exe)) return exe;

  // 有些包结构是 jdk-xxx-jre/bin/java.exe
  for (const dir of listDirs(targetDir)) {
    const candidate = path.join(dir, 'bin', IS_WINDOWS ? 'java.exe' : 'java');
    if (exists(candidate)) return candidate;
  }
  throw new Error('JRE 解压后仍找不到 java 可执行文件');
}

/** 确保有可用的 Java；返回 { exe, major, version } */
export async function ensureJava(major, { autoDownload = true } = {}) {
  const found = findJava(major);
  if (found.exe) {
    ok(`使用 Java ${found.major}（${found.source}）：${found.exe}`);
    return found;
  }
  warn(`没找到 Java ${major}，${autoDownload ? '尝试自动下载' : '请先安装'}`);
  if (!autoDownload) throw new Error(`需要 Java ${major}，但没有找到`);
  const exe = await downloadJava(major);
  const v = readJavaVersion(exe);
  ok(`已准备好 Java ${v.major}：${exe}`);
  return { exe, major: v.major, raw: v.raw, source: '自动下载' };
}

/** 列出本机所有 Java（给 CLI 的 java 命令用） */
export function listJava() {
  return scanJavaCandidates()
    .map((exe) => ({ exe, ...readJavaVersion(exe) }))
    .filter((item) => item.major > 0);
}
