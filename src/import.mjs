import fs from 'node:fs';
import path from 'node:path';
import { GAME_DIR, ensureDir, safeJoin } from './paths.mjs';
import { openZipFile } from './zip.mjs';
import { Progress, fmtBytes, info, ok, step, warn } from './log.mjs';

/**
 * 导入「解压即玩」整合包：把包里的 .minecraft/ 合并进本启动器的游戏目录。
 * 只导入 versions / libraries / assets / mods 等运行必需部分，
 * PCL 目录、Java 安装包、说明文本一律跳过。
 */
export async function importArchive(zipPath, { onProgress } = {}) {
  if (!fs.existsSync(zipPath)) throw new Error(`文件不存在：${zipPath}`);

  step(`读取压缩包 ${path.basename(zipPath)}`);
  const zip = openZipFile(zipPath);
  try {
  // 有的压缩工具（Windows 自带）把分隔符写成反斜杠，统一成正斜杠再匹配
  const entries = zip.entries
    .filter((entry) => !entry.isDir)
    .map((entry) => ({ entry, name: entry.name.replace(/\\/g, '/') }))
    .filter(({ name }) => name.startsWith('.minecraft/'));
  if (entries.length === 0) {
    throw new Error('不是「解压即玩」整合包（包内没有 .minecraft 目录）');
  }

  const totalBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  step(`开始解压（${entries.length} 个文件 / ${fmtBytes(totalBytes)}）`);
  const progress = new Progress('解压', totalBytes);

  const backupRoot = path.join(GAME_DIR, '.import-backup', String(Date.now()));
  let backedUp = 0;
  let written = 0;
  let rejected = 0;
  for (const { entry, name } of entries) {
    const rel = name.slice('.minecraft/'.length);
    if (!rel) continue;
    // 条目名来自不可信的整合包：绝对路径 / .. 一律拒绝，别写到游戏目录外面
    let dest;
    try {
      dest = safeJoin(GAME_DIR, rel);
    } catch {
      rejected += 1;
      continue;
    }
    ensureDir(path.dirname(dest));
    // 覆盖前先备份已有文件，避免把启动器原有的库/配置冲掉
    if (fs.existsSync(dest) && backedUp < 2000) {
      try {
        const backupPath = safeJoin(backupRoot, rel);
        ensureDir(path.dirname(backupPath));
        fs.copyFileSync(dest, backupPath);
        backedUp += 1;
      } catch {
        /* 备份失败不阻塞导入 */
      }
    }
    fs.writeFileSync(dest, zip.read(entry));
    written += 1;
    progress.add(entry.size ?? 0);
    onProgress?.({ written, total: entries.length });
  }
  progress.finish(`解压完成（${written} 个文件）`);
  if (backedUp > 0) info(`已备份被覆盖的文件 ${backedUp} 个 → .import-backup`);
  if (rejected > 0) warn(`跳过 ${rejected} 个越界条目（路径含 .. / 绝对路径）`);

  // 找出包里的版本目录，报告给用户（取 mod 最多的那个当作主版本）
  const versionsDir = path.join(GAME_DIR, 'versions');
  const versionIds = fs.existsSync(versionsDir)
    ? fs
        .readdirSync(versionsDir, { withFileTypes: true })
        .filter((dir) => dir.isDirectory())
        .map((dir) => dir.name)
    : [];

  let mainVersion = versionIds[0];
  let mainMods = -1;
  for (const id of versionIds) {
    try {
      const mods = fs.readdirSync(path.join(versionsDir, id, 'mods')).filter((f) => f.endsWith('.jar')).length;
      if (mods > mainMods) {
        mainMods = mods;
        mainVersion = id;
      }
    } catch {
      /* 没有 mods 目录 */
    }
  }

  ok(`导入完成，已登记版本：${versionIds.join('、') || '（未找到）'}`);
  if (versionIds.length === 0) {
    warn('没有在包里找到 versions 目录，可能不是完整的整合包');
  }
  return { versions: versionIds, files: written, main: mainVersion };
  } finally {
    zip.close();
  }
}
