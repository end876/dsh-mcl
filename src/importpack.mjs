import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, safeJoin, versionDir } from './paths.mjs';
import { openZipFile } from './zip.mjs';
import { installedVersions, installVersion } from './install.mjs';
import { installLoader } from './loader.mjs';
import { installFabric } from './fabric.mjs';
import { Progress, fmtBytes, info, ok, step, warn } from './log.mjs';

/** 压缩包名 → 实例名（去掉扩展名和 Windows 不允许的字符） */
export function sanitizeInstanceName(raw) {
  const base = String(raw ?? '')
    .replace(/\.(zip|mrpack|jar)$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60);
  return base || '整合包';
}

/** 从 CurseForge 的 modLoaders[].id 里拆出加载器和版本 */
function parseLoaderId(id) {
  const match = String(id ?? '').match(/^(fabric|forge|neoforge|quilt)-(.+)$/i);
  if (!match) return { loader: null, loaderVersion: null };
  return { loader: match[1].toLowerCase(), loaderVersion: match[2] };
}

/**
 * 把本地整合包 zip 装成一个独立实例。
 * 实例名默认取压缩包文件名（用户要求的「游戏用压缩包名字」）。
 * 支持 CurseForge 结构：manifest.json + overrides/。
 */
export async function importModpackZip(zipPath, { name } = {}) {
  if (!fs.existsSync(zipPath)) throw new Error(`文件不存在：${zipPath}`);
  const zip = openZipFile(zipPath);
  try {
  const manifestEntry = zip.entries.find((entry) => !entry.isDir && entry.name === 'manifest.json');
  if (!manifestEntry) {
    throw new Error('不支持的整合包格式：需要 CurseForge 的 manifest.json（解压即玩包请用「导入」）');
  }

  let manifest;
  try {
    manifest = JSON.parse(zip.read(manifestEntry).toString('utf8'));
  } catch (error) {
    throw new Error(`manifest.json 不是合法 JSON：${error.message}`);
  }

  const mcVersion = String(manifest?.minecraft?.version ?? '').trim();
  if (!mcVersion) throw new Error('manifest.json 里没有 Minecraft 版本');
  const loaders = manifest?.minecraft?.modLoaders ?? [];
  const primary = loaders.find((item) => item.primary) ?? loaders[0];
  const { loader, loaderVersion } = parseLoaderId(primary?.id);

  const instanceName = sanitizeInstanceName(name ?? path.basename(zipPath));
  const targetDir = versionDir(instanceName);
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    throw new Error(`实例已存在：${instanceName}（换个名字，或先在版本页删掉它）`);
  }

  step(
    `整合包「${manifest.name ?? instanceName}」：Minecraft ${mcVersion}` +
      (loader ? ` / ${loader} ${loaderVersion ?? ''}` : ' / 原版'),
  );

  if (!loader) {
    if (!installedVersions().includes(mcVersion)) await installVersion(mcVersion);
    throw new Error('原版整合包暂不支持一键安装，请先在版本页装好原版再手动拷贝');
  }

  let installed;
  if (loader === 'fabric') {
    installed = await installFabric(mcVersion, { loaderVersion, instanceId: instanceName });
  } else {
    installed = await installLoader(loader, mcVersion, { loaderVersion, instanceId: instanceName });
  }
  const instanceId = installed?.id ?? instanceName;
  if (instanceId !== instanceName) warn(`加载器返回的实例名是 ${instanceId}，以它为准`);
  const instanceDir = versionDir(instanceId);

  // 把 overrides/ 里的东西按原样铺进实例目录（mods / config / resourcepacks / shaderpacks …）
  const prefix = `${String(manifest.overrides ?? 'overrides').replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  // 有的压缩工具（Windows 自带）把分隔符写成反斜杠，这里统一成正斜杠再匹配
  const normalized = zip.entries
    .filter((entry) => !entry.isDir)
    .map((entry) => ({ entry, name: entry.name.replace(/\\/g, '/') }));
  const entries = normalized.filter(
    ({ name }) => name.startsWith(prefix) && !/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(name),
  );
  const totalBytes = entries.reduce((sum, item) => sum + (item.entry.size ?? 0), 0);
  step(`复制整合包内容（${entries.length} 个文件 / ${fmtBytes(totalBytes)}）`);
  const progress = new Progress('复制', totalBytes);
  let written = 0;
  let rejected = 0;
  for (const { entry, name } of entries) {
    const rel = name.slice(prefix.length);
    if (!rel) continue;
    let dest;
    try {
      dest = safeJoin(instanceDir, rel); // 条目名不可信：绝对路径 / .. 直接拒绝
    } catch {
      rejected += 1;
      continue;
    }
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, zip.read(entry));
    written += 1;
    progress.add(entry.size ?? 0);
  }
  progress.finish(`已写入 ${written} 个文件`);
  if (rejected > 0) warn(`跳过 ${rejected} 个越界条目`);

  const mods = (() => {
    try {
      return fs.readdirSync(path.join(instanceDir, 'mods')).filter((file) => file.endsWith('.jar')).length;
    } catch {
      return 0;
    }
  })();

  // CurseForge 的「清单型」整合包：overrides 里只有配置/资源包，mod 要靠清单去 CF 下载
  const required = (manifest.files ?? []).filter((file) => file.required !== false).length;
  const missing = Math.max(0, required - mods);
  if (missing > 0) {
    warn(`这个包是「清单型」：overrides 只带了 ${mods} 个 mod，还缺 ${missing} 个需要从 CurseForge 下载`);
    info('补齐方式：用 CurseForge 客户端装一遍（把 mods 文件夹拷过来），或给启动器配 CurseForge API key 让它自动下载');
    try {
      const list = (manifest.files ?? [])
        .filter((file) => file.required !== false)
        .map((file) => `${file.projectID}:${file.fileID}`)
        .join('\n');
      fs.writeFileSync(path.join(instanceDir, 'curseforge-required-files.txt'), `${list}\n`, 'utf8');
      info(`缺少的模组清单已写到 instance 目录的 curseforge-required-files.txt`);
    } catch {
      /* ignore */
    }
  }

  ok(`实例已就绪：${instanceId}（${mods} 个 mod）`);
  return { instance: instanceId, mcVersion, loader, loaderVersion, files: written, mods, missing };
  } finally {
    zip.close();
  }
}
