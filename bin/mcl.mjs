#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { GAME_DIR, LIBRARIES_DIR, ASSETS_DIR, IS_WINDOWS, OS_NAME, exists, versionDir } from '../src/paths.mjs';
import { pickSource, createSource } from '../src/source.mjs';
import { installedVersions, installVersion, readLocalVersionJson } from '../src/install.mjs';
import { buildCommand, launch, printCommand } from '../src/launch.mjs';
import { listJava, findJava, ensureJava } from '../src/java.mjs';
import { startGui } from '../src/server.mjs';
import { installFabric } from '../src/fabric.mjs';
import { installLoader, listLoaderVersions, detectLoader as detectLoaderId, loaderLabelFor } from '../src/loader.mjs';
import { installMod, installModpack, installModsBatch } from '../src/modrinth.mjs';
import { scanAll, scanInstance } from '../src/dupes.mjs';
import { importArchive } from '../src/import.mjs';
import { importModpackZip } from '../src/importpack.mjs';
import { exportInstance } from '../src/exportpack.mjs';
import { buildFixReport } from '../src/crashfix.mjs';
import { ensureFreshAuth, loadAuth, loginWithDeviceCode } from '../src/auth.mjs';
import { Progress, fmtBytes, c, info, ok, fail, say, step, warn } from '../src/log.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[i + 1];
        i += 1;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}


function sourceNameFrom(flags) {
  return flags.source ?? process.env.MCL_SOURCE ?? 'auto';
}

function resolveInstalled(target) {
  const installed = installedVersions();
  if (!target) return installed[0];
  if (installed.includes(target)) return target;
  const matches = installed.filter((id) => id.startsWith(target));
  return matches.length === 1 ? matches[0] : target;
}

async function cmdInstall(positional, flags) {
  const target = positional[1] ?? 'latest';
  const sourceName = sourceNameFrom(flags);
  const result = await installVersion(target, { sourceName, force: Boolean(flags.force) });
  say();
  ok(`安装完成：${result.id}`);
  info(`目录：${result.dir}`);
  info(`库文件：${result.libraries.length} 个，资源：${ASSETS_DIR}`);
}

async function cmdList(positional, flags) {
  const installed = installedVersions();
  if (flags.remote) {
    step('获取远程版本清单');
    const { manifest, sources } = await pickSource(sourceNameFrom(flags));
    info(`源：${sources[0].label}`);
    const limit = Number(flags.limit ?? 20);
    const list = flags.all ? manifest.versions : manifest.versions.filter((v) => v.type === 'release');
    for (const v of list.slice(0, limit)) {
      const mark = installed.includes(v.id) ? c.green('已安装') : c.dim('      ');
      say(`  ${v.id.padEnd(16)} ${v.type.padEnd(10)} ${v.releaseTime.slice(0, 10)}  ${mark}`);
    }
    if (list.length > limit) info(`…… 共 ${list.length} 个，用 --limit 调整`);
    return;
  }
  if (installed.length === 0) {
    warn('还没有安装任何版本，试试 mcl install latest');
    return;
  }
  say();
  for (const id of installed) {
    const json = readLocalVersionJson(id);
    const loader = detectLoader(json);
    say(`  ${c.bold(id)}${loader ? c.magenta(` [${loader}]`) : ''}  ${c.dim(json.type ?? '')}`);
  }
  say();
}

function detectLoader(json) {
  return loaderLabelFor(detectLoaderId(json));
}

async function cmdLaunch(positional, flags) {
  const versionId = resolveInstalled(positional[1] ?? (installedVersions()[0] ?? ''));
  if (!versionId) {
    fail('没有可启动的版本，先安装一个：mcl install latest');
    process.exitCode = 1;
    return;
  }
  const options = {
    username: flags.user ?? flags.username ?? 'Player',
    memory: flags.memory ?? '2G',
    width: flags.width ? Number(flags.width) : undefined,
    height: flags.height ? Number(flags.height) : undefined,
    detach: Boolean(flags.detach),
    autoDownloadJava: flags['no-download-java'] ? false : true,
    // 快过期就先刷新；刷新失败就退回离线，别拿过期 token 启动
    auth: flags.auth ? await ensureFreshAuth() : null,
  };
  if (options.auth && !flags.user) options.username = options.auth.name;
  if (flags['dry-run']) {
    const command = buildCommand(versionId, options);
    const java = flags.java ?? (findJava(command.javaMajor).exe ?? 'java');
    printCommand(command, java);
    say();
    info(`java：${java}`);
    info(`javaMajor 要求：${command.javaMajor}`);
    info(`classpath 条目：${command.classpath.length}`);
    return;
  }
  const child = await launch(versionId, options);
  // 游戏崩了要让命令行能感知：退出码非 0，并提示生成修复建议
  const exitCode = typeof child?.exitCode === 'number' ? child.exitCode : null;
  if (exitCode !== null && exitCode !== 0) {
    process.exitCode = 1;
    say();
    warn(`游戏异常退出（退出码 ${exitCode}）`);
    info(`运行 mcl diagnose ${versionId} 查看原因与修复建议`);
  }
}

async function cmdJava() {
  const list = listJava();
  if (list.length === 0) {
    warn('本机没有找到 Java。启动时会自动下载 Adoptium JRE。');
    return;
  }
  say();
  for (const item of list) {
    say(`  Java ${String(item.major).padEnd(3)} ${item.raw.padEnd(12)} ${c.dim(item.exe)}`);
  }
  say();
}

async function cmdJavaInstall(positional) {
  const major = Number(positional[1] ?? 17);
  if (!Number.isFinite(major) || major < 8 || major > 25) throw new Error('用法：mcl java-install <大版本，如 17>');
  step(`准备 Java ${major}`);
  const java = await ensureJava(major, { autoDownload: true });
  say();
  ok(`Java ${java.major} 已就绪：${java.exe}`);
}

async function cmdInfo(positional) {
  const id = resolveInstalled(positional[1]);
  if (!id || !readLocalVersionJson(id)) {
    fail(`未安装：${positional[1] ?? '(空)'}`);
    process.exitCode = 1;
    return;
  }
  const json = readLocalVersionJson(id);
  const command = buildCommand(id, {});
  // Java 版本和客户端 jar 都要沿继承链找：Forge / NeoForge / Fabric 的 json 自己往往不写
  let javaMajor = 8;
  let rootId = id;
  let cursor = json;
  for (let guard = 0; cursor && guard < 10; guard += 1) {
    if (cursor.javaVersion?.majorVersion) {
      javaMajor = cursor.javaVersion.majorVersion;
      break;
    }
    if (!cursor.inheritsFrom) break;
    rootId = cursor.inheritsFrom;
    cursor = readLocalVersionJson(cursor.inheritsFrom);
  }
  const clientJar = path.join(versionDir(rootId), `${rootId}.jar`);
  say();
  say(`  ${c.bold(json.id)}  ${json.type}`);
  info(`主类：${json.mainClass}`);
  info(`继承：${json.inheritsFrom ?? '(无)'}`);
  info(`要求 Java：${javaMajor}`);
  info(`资源索引：${json.assets ?? command.resolved?.assets ?? '?'}`);
  info(`库文件：${json.libraries?.length ?? 0} 个（当前平台生效 ${command.classpath.length} 个）`);
  info(`客户端 jar：${exists(clientJar) ? clientJar : `${clientJar}（缺失）`}`);
  info(`游戏目录：${command.gameDir}`);
  say();
}

async function cmdDoctor(positional, flags) {
  say();
  say(c.bold('  环境检查'));
  info(`Node：${process.version}`);
  info(`系统：${OS_NAME} / ${process.arch}（${os.release()}）`);
  info(`游戏目录：${GAME_DIR}`);
  info(`依赖库目录：${LIBRARIES_DIR}`);
  info(`资源目录：${ASSETS_DIR}`);
  say();

  step('下载源连通性');
  for (const name of ['bmclapi', 'mojang']) {
    const started = Date.now();
    try {
      const manifest = await createSource(name).manifest();
      ok(`${name.padEnd(8)} OK    ${String(Date.now() - started).padStart(5)} ms   最新版本 ${manifest.latest.release}`);
    } catch (error) {
      fail(`${name.padEnd(8)} 失败  ${error.message}`);
    }
  }
  say();
  await cmdJava();
}

function cmdHelp() {
  say();
  say(c.bold('  mcl —— 一个零依赖的 Minecraft 启动器'));
  say();
  say('  用法：');
  say('    mcl gui                     打开图形界面（默认）');
  say('    mcl install <版本>          下载安装（版本可写 latest / 1.20.1 / 1.21）');
  say('    mcl fabric <mc版本>         安装 Fabric 实例');
  say('    mcl forge <mc版本>          安装 Forge 实例（--loader 指定版本 / --list-loaders 看列表）');
  say('    mcl neoforge <mc版本>       安装 NeoForge 实例');
  say('    mcl quilt <mc版本>          安装 Quilt 实例');
  say('    mcl mod <项目ID> --mc 1.20.1  安装一个 Modrinth 模组');
  say('    mcl mods <项目ID...> --mc 1.20.1  批量安装模组（自动补前置、并发下载）');
  say('    mcl pack <项目ID> --mc 1.20.1 安装一个 Modrinth 整合包');
  say('    mcl import "<zip路径>"      导入「解压即玩」整合包（合并 + 备份）');
  say('    mcl importpack "<zip路径>"  把 CurseForge 整合包装成独立实例（实例名=zip 文件名）');
  say('    mcl export <实例>           把本地实例导出为整合包（--include-saves 连存档一起）');
  say('    mcl check                   检查重复模组');
  say('    mcl diagnose <实例> [--write] 崩溃诊断 + 修复建议（--write 导出 Markdown 报告）');
  say('    mcl login                   微软设备码登录');
  say('    mcl list                    列出已安装版本');
  say('    mcl list --remote --limit 30  列出远程版本');
  say('    mcl launch <版本>           离线启动（加 --auth 用正版身份）');
  say('    mcl info <版本>             查看版本信息');
  say('    mcl java                    列出本机 Java');
  say('    mcl java-install <大版本>   下载/准备指定大版本的 Java（崩溃修复后台用）');
  say('    mcl doctor                  环境与下载源自检');
  say();
  say('  启动参数：');
  say('    --user <名字>      离线玩家名（默认 Player）');
  say('    --memory <大小>    内存上限（默认 2G，例如 4G）');
  say('    --width/--height   窗口尺寸');
  say('    --dry-run          只打印命令不启动');
  say('    --detach           启动后立即返回');
  say();
  say('  通用参数：');
  say('    --source auto|mojang|bmclapi   下载源（默认 auto：谁快用谁，失败自动切换）');
  say('    --force                        强制重新下载');
  say();
}

async function cmdFabric(positional, flags) {
  const mc = positional[1];
  if (!mc) throw new Error('用法：mcl fabric <mc版本> [--loader 版本]');
  const result = await installFabric(mc, {
    loaderVersion: typeof flags.loader === 'string' ? flags.loader : undefined,
    sourceName: sourceNameFrom(flags),
  });
  say();
  ok(`Fabric 实例就绪：${c.bold(result.id)}`);
  info(`加载器 ${result.loader} · Minecraft ${result.mcVersion}`);
}

async function cmdLoader(positional, flags, loader) {
  const mc = positional[1];
  const label = loader === 'forge' ? 'Forge' : loader === 'quilt' ? 'Quilt' : 'NeoForge';
  if (!mc) throw new Error(`用法：mcl ${loader} <mc版本> [--loader 版本]`);
  if (flags['list-loaders']) {
    const list = await listLoaderVersions(loader, mc);
    say(`${label} 可用版本（MC ${mc}）：${list.slice(0, 20).join('、') || '（无）'}`);
    return;
  }
  const result = await installLoader(loader, mc, {
    loaderVersion: typeof flags.loader === 'string' ? flags.loader : undefined,
    sourceName: sourceNameFrom(flags),
  });
  say();
  ok(`${label} 实例就绪：${c.bold(result.id)}`);
  info(`加载器 ${result.loaderVersion} · Minecraft ${result.mcVersion}`);
}

async function cmdMod(positional, flags) {
  const projectId = positional[1];
  const mc = flags.mc;
  if (!projectId || !mc) throw new Error('用法：mcl mod <Modrinth项目ID> --mc 1.20.1 [--loader forge] [--instance <实例>]');
  const result = await installMod(projectId, {
    mcVersion: String(mc),
    loader: typeof flags.loader === 'string' ? flags.loader : 'fabric',
    instance: typeof flags.instance === 'string' ? flags.instance : undefined,
    sourceName: sourceNameFrom(flags),
  });
  say();
  ok(`已安装 ${result.title}`);
  info(`位置：${result.instance}/mods/${result.file}`);
}

async function cmdMods(positional, flags) {
  const ids = positional.slice(1).filter(Boolean);
  const mc = flags.mc;
  if (ids.length === 0 || !mc) throw new Error('用法：mcl mods <项目ID...> --mc 1.20.1 [--loader forge] [--instance <实例>]');
  const result = await installModsBatch(ids, {
    mcVersion: String(mc),
    loader: typeof flags.loader === 'string' ? flags.loader : 'fabric',
    instance: typeof flags.instance === 'string' ? flags.instance : undefined,
    sourceName: sourceNameFrom(flags),
  });
  say();
  ok(`已安装 ${result.count} 个文件到 ${result.instance}/mods`);
}

async function cmdPack(positional, flags) {
  const projectId = positional[1];
  const mc = flags.mc;
  if (!projectId) throw new Error('用法：mcl pack <Modrinth项目ID> [--mc 1.20.1]');
  const result = await installModpack(projectId, {
    mcVersion: mc ? String(mc) : undefined,
    sourceName: sourceNameFrom(flags),
  });
  say();
  ok(`整合包已安装：${result.name} → ${result.instance}`);
  info(`文件 ${result.files} 个`);
}

async function cmdCheck(positional) {
  const target = positional[1];
  const results = target ? [scanInstance(target)] : scanAll();
  let dupCount = 0;
  for (const result of results) {
    if (result.groups.length === 0) continue;
    dupCount += result.groups.length;
    say();
    say(`  ${c.bold(result.instance)}  ${c.dim(`${result.jars} 个 jar`)}`);
    for (const group of result.groups) {
      warn(`${group.key}：${group.files.join('  /  ')}`);
    }
  }
  if (dupCount === 0) ok('没有发现重复模组');
  else warn(`共 ${dupCount} 组疑似重复，删掉旧版本再启动`);
}

async function cmdLogin(positional, flags) {
  const clientId = flags['client-id'] ?? process.env.MCL_CLIENT_ID;
  if (!clientId) throw new Error('用法：mcl login --client-id <Azure 应用的应用程序ID>');
  const account = await loginWithDeviceCode({
    clientId,
    onDeviceCode: ({ userCode, verificationUri, expiresIn }) => {
      say();
      say(c.bold(`  1. 打开 ${verificationUri}`));
      say(c.bold(`  2. 输入代码：${userCode}`));
      info(`有效期约 ${Math.round(expiresIn / 60)} 分钟`);
      step('等待在网页上完成登录…');
    },
  });
  say();
  ok(`登录成功：${account.name}  ${account.uuid}`);
  info('凭证已保存到 ~/.mcl/auth.json（仅 token，不含密码）');
}

async function cmdDiagnose(positional, flags = {}) {
  const installed = installedVersions();
  const target = resolveInstalled(positional[1] ?? installed[0]);
  if (!target) throw new Error('还没有安装任何版本');
  const report = buildFixReport(target, { write: Boolean(flags.write) });
  say();
  say(`  ${c.bold(report.instance)}  ${report.loader ?? '原版'}  Minecraft ${report.mc ?? '?'}`);
  if (report.crashed) warn(`游戏异常退出${report.exitCode !== null ? `（退出码 ${report.exitCode}）` : ''}`);
  else warn('没有发现崩溃痕迹');
  say();
  say(`  结论：${report.summary}`);
  for (const cause of report.causes) {
    say(`  · ${c.bold(cause.title)}（置信度 ${Math.round(cause.confidence * 100)}%）`);
    if (cause.explanation) say(`      ${c.dim(cause.explanation)}`);
    for (const line of cause.evidence.slice(0, 2)) say(`      证据：${c.dim(line)}`);
    for (const fix of cause.fixes ?? []) say(`      修复：${fix.label}${fix.description ? `（${fix.description}）` : ''}`);
  }
  if (report.causes.length === 0) {
    say('  没有命中已知规则，可用 --write 生成完整报告后交给 AI 分析。');
  }
  say();
  if (report.reportPath) info(`报告已保存：${report.reportPath}`);
  else info('加 --write 可把完整 Markdown 报告保存到实例的 crash-reports/ 目录。');
  say();
}

async function cmdImportPack(positional, flags) {
  const target = positional[1] ?? positional[2];
  if (!target) throw new Error('用法：mcl importpack <整合包zip路径> [--name 实例名]');
  const cleaned = String(target).replace(/^["'“”「」]+|["'“”「」]+$/g, '');
  const result = await importModpackZip(cleaned, {
    name: typeof flags.name === 'string' && flags.name ? flags.name : undefined,
  });
  say();
  info(`实例：${result.instance}（Minecraft ${result.mcVersion} / ${result.loader}）`);
  info(`现在可以启动：mcl launch "${result.instance}"`);
}

async function cmdExport(positional, flags = {}) {
  const instance = positional[1] ?? positional[2];
  if (!instance) throw new Error('用法：mcl export <实例名> [--include-saves]');
  const includeSaves = flags['include-saves'] === true || flags['include-saves'] === 'true';
  let progress = null;
  const result = await exportInstance(String(instance).replace(/^["'“”「」]+|["'“”「」]+$/g, ''), {
    includeSaves,
    onPlan: (plan) => {
      step(`导出 ${plan.files} 个文件（${fmtBytes(plan.totalBytes)}）`);
      progress = new Progress('导出', plan.totalBytes);
    },
    onProgress: (size) => progress?.add(size),
  });
  progress?.finish(`已写入 ${result.files} 个文件`);
  say();
  ok(`导出完成：${result.file}`);
  info(`文件：${result.path}`);
  if (result.loader) info(`加载器：${result.loader} ${result.loaderVersion ?? ''} / Minecraft ${result.mcVersion}`);
  console.log(`EXPORT:${result.file}`);
}

async function cmdImport(positional) {
  const target = positional[1] ?? positional[2];
  if (!target) throw new Error('用法：mcl import <整合包zip路径>');
  const result = await importArchive(String(target).replace(/^["'“”「」]+|["'“”「」]+$/g, ''));
  say();
  if (result.main) {
    info(`主版本：${result.main}`);
    info(`现在可以启动：mcl launch "${result.main}"`);
  }
}

async function cmdGui(positional, flags) {
  const port = Number(flags.port ?? 51730);
  step('启动本地界面服务');
  const { url } = await startGui({
    port,
    open: !flags['no-open'],
    openWindow: !flags['no-window'],
  });
  say();
  ok(`启动器界面已就绪：${c.bold(url)}`);
  info('保持这个窗口开着，关闭即退出（Ctrl+C）');
  say();
}

async function main() {
  const raw = process.argv.slice(2);
  // --help / -h 要打印帮助，不能因为 positional 为空就回落成 gui
  if (raw.includes('--help') || raw.includes('-h') || raw.includes('-?')) {
    cmdHelp();
    return;
  }
  const { positional, flags } = parseArgs(raw);
  const command = positional[0] ?? 'gui';
  switch (command) {
    case 'gui':
    case 'ui':
      await cmdGui(positional, flags);
      break;
    case 'fabric':
    case 'loader':
      await cmdFabric(positional, flags);
      break;
    case 'forge':
      await cmdLoader(positional, flags, 'forge');
      break;
    case 'neoforge':
      await cmdLoader(positional, flags, 'neoforge');
      break;
    case 'quilt':
      await cmdLoader(positional, flags, 'quilt');
      break;
    case 'mod':
      await cmdMod(positional, flags);
      break;
    case 'mods':
      await cmdMods(positional, flags);
      break;
    case 'check':
      await cmdCheck(positional);
      break;
    case 'import':
      await cmdImport(positional);
      break;
    case 'importpack':
    case 'packinstall':
      await cmdImportPack(positional, flags);
      break;
    case 'export':
    case 'exportpack':
      await cmdExport(positional, flags);
      break;
    case 'diagnose':
    case 'why':
      await cmdDiagnose(positional, flags);
      break;
    case 'login':
      await cmdLogin(positional, flags);
      break;
    case 'pack':
      await cmdPack(positional, flags);
      break;
    case 'install':
    case 'i':
      await cmdInstall(positional, flags);
      break;
    case 'list':
    case 'ls':
    case 'versions':
      await cmdList(positional, flags);
      break;
    case 'launch':
    case 'run':
      await cmdLaunch(positional, flags);
      break;
    case 'java':
      await cmdJava();
      break;
    case 'java-install':
    case 'javainstall':
      await cmdJavaInstall(positional);
      break;
    case 'info':
      await cmdInfo(positional);
      break;
    case 'doctor':
      await cmdDoctor(positional, flags);
      break;
    case 'help':
    case '--help':
    case '-h':
      cmdHelp();
      break;
    default:
      fail(`未知命令：${command}`);
      cmdHelp();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  say();
  fail(error?.message ?? String(error));
  if (process.env.MCL_DEBUG) console.error(error);
  process.exitCode = 1;
});
