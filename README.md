# MCL 启动器（1.1.1 · 测试版）

一个**零依赖**的 Node 版 Minecraft 启动器，也是 DeepSeek Harness 的插件：装原版 / Fabric / Quilt /
Forge / NeoForge、搜装模组与整合包、离线或正版启动，带崩溃诊断和一整套 HTTP 接口。
1.0 的界面重新做了一版：左侧分页、三套主题、可以换自己的背景图 —— 好看，但不牺牲可读性。

> **背景**：它最初是为了给 DSH（DeepSeek Harness）做一个「在对话里启动 Minecraft」的插件而写的启动器核心。
> 在 DSH 里，AI 要能装版本、装模组、启动游戏、读日志、诊断崩溃 —— 这些必须是可调用的步骤，
> 而不是只能手点的界面。
>
> 所以 **CLI 和 HTTP 接口是它的主界面**：DSH 插件是它最常用的客户端，浏览器窗口只是顺手给的。

> **项目状态**：**1.1.1 测试版**。1.1.0 的崩溃修复、实例管理、进度条、大文件、登录直达，加上 1.1.1 的解包路径收口；接口基本稳定，文档里的命令和接口都经过实测；
> 遇到问题欢迎提 issue。玩之前建议先备份存档。

## 特性（1.1.1）

- ✅ 从 Mojang 官方 / BMCLAPI 镜像自动下载安装**原版**任意版本（auto 选源，失败回退）
- ✅ 自动补齐 Java 运行时（Adoptium JRE，按版本需求自动选 8 / 17 / 21，走清华镜像）
- ✅ 离线登录（标准 `OfflinePlayer:<name>` UUID，兼容存档）+ **微软设备码登录**
- ✅ 版本隔离目录（和主流启动器一致：`versions/<版本名>/` 作为独立游戏目录）
- ✅ 下载 SHA1 校验、断点跳过、失败重试、并发下载（并发 5）
- ✅ **Fabric / Quilt** 实例安装（按配置隔离 `fabric-<mc>-<label>`；Quilt 走官方 meta 的 profile json）
- ✅ **Forge / NeoForge** 实例安装：从 installer 里取 `install_profile.json`，自己跑 processors  
  （binpatch / jarsplitter / AutoRenamingTool），不调用官方 installer 本体；依赖走 BMCLAPI maven 镜像
- ✅ **Quilt** 实例安装：maven 元数据挑稳定版 + profile json，`quilt-loader-<ver>-<mc>` 实例直连可启动
- ✅ **Modrinth** 搜索 / 分类 / 排序、冲突检测、前置依赖、批量安装
- ✅ `.mrpack` 安装、**解压即玩**包导入（合并 + 覆盖前备份）
- ✅ 光影下载（自动检查 Iris）
- ✅ 内存滑条 + 安全上限（可用内存 − 1G）+ 按 Java 版本分档的 JVM 参数
- ✅ **崩溃诊断**：8 条规则归因，命令行和接口都能用
- ✅ 日志尾巴接口 `/api/logs` + 运行时快照（真实 java pid / 内存 / 退出码）
- ✅ **动态端口**：51730 被占用自动往后找，实际端口写 `~/.mcl/server.json`，客户端自动发现
- ✅ SSE 事件流（安装/启动进度、登录结果），带跨源 CORS
- ✅ **模组库（DSH 插件里）**：Modrinth 搜索、冲突预检、批量安装、前置递归补齐、本地 jar 前置识别
- ✅ **界面**：左侧五个分页（启动 / 版本 / 模组库 / 日志 / 外观）+ 底部运行日志栏（滑入、可收起）
- ✅ **三套主题**：A 深海玻璃 / B 像素方块 / C 极简白（默认）
- ✅ **自定义背景**：本地上传、四套预设、模糊 / 压暗 / 玻璃 / 焦点四个滑杆（见 [自定义背景](docs/custom-background.md)）
- ✅ **插件跟随主题**：设置页和右下浮窗跟着启动器一起换 A / B / C 主题
- ✅ **本地整合包安装**：CurseForge 结构的 zip 直接装成独立实例，**实例名取压缩包文件名**
  （`mcl importpack <zip>`，界面里也有「安装为实例」按钮）

## 快速开始

需要 Node.js ≥ 20，无需 `npm install`（零第三方依赖）。

```bash
node bin/mcl.mjs doctor                    # 环境与下载源自检
node bin/mcl.mjs install 1.20.1            # 下载安装原版 1.20.1（约 700MB 资源）
node bin/mcl.mjs fabric 1.20.1             # 装一个 Fabric 实例
node bin/mcl.mjs quilt 1.20.1              # 装一个 Quilt 实例（官方 meta 较慢，第一次可能要几分钟）
node bin/mcl.mjs launch 1.20.1 --user 你的名字 --memory 4G
```

也可以装成命令：`npm link` 之后直接用 `mcl`。

每次改动后实际跑过的验证记录在 [`docs/verification.md`](docs/verification.md)。

## 图形界面

```bash
mcl gui                 # 或直接 mcl
```

启动一个本地服务（默认 `http://127.0.0.1:51730`），Windows 上会优先用 Edge / Chrome 的  
`--app` 模式开一个没有地址栏的独立窗口，找不到浏览器就退回默认浏览器。

界面能力：

- 已安装版本列表（版本号 / 加载器 / Java 要求 / mod 数量），点击选中，一键启动
- 安装原版：下拉选远程版本（60 个 release），实时看下载进度
- 启动参数：玩家名、内存、窗口尺寸（存 localStorage）
- Modrinth 搜索：模组 / 整合包 / 光影，分类、排序、无限滚动、批量下载
- **实时日志**：安装与游戏 stdout/stderr 通过 SSE 推送到页面，带颜色区分步骤/成功/报错
- 微软登录：设备码流程（复制码 → 浏览器授权 → 自动完成）
- 崩溃诊断按钮：直接出结论
- 停止按钮：一键杀掉游戏进程（Windows 下 taskkill /T）

服务端零依赖（Node 内置 `http` + SSE），只把 CLI 当子进程调用，所以界面和命令行行为完全一致。

## 命令

| 命令                             | 说明                                                        |
| ------------------------------ | --------------------------------------------------------- |
| `mcl gui`                      | 打开图形界面                                                    |
| `mcl install <版本>`             | 安装原版；版本支持 `latest` / `1.20.1` / `1.21`                    |
| `mcl fabric <mc版本>`            | 安装 Fabric 实例                                              |
| `mcl forge <mc版本>`             | 安装 Forge 实例；`--loader 47.2.0` 指定版本，`--list-loaders` 看可用版本 |
| `mcl neoforge <mc版本>`          | 安装 NeoForge 实例（同上参数）                                      |
| `mcl quilt <mc版本>`             | 安装 Quilt 实例（`--loader 0.30.1` 指定版本，`--list-loaders` 看列表）   |
| `mcl mod <项目ID> --mc 1.20.1`   | 装一个 Modrinth 模组（含前置依赖）                                    |
| `mcl pack <项目ID> --mc 1.20.1`  | 装一个 Modrinth 整合包                                          |
| `mcl import "<zip路径>"`         | 导入解压即玩包（合并 + 备份）                                          |
| `mcl check`                    | 检查重复模组                                                    |
| `mcl diagnose <实例>`            | 崩溃诊断                                                      |
| `mcl login`                    | 微软设备码登录                                                   |
| `mcl list`                     | 列出已安装版本                                                   |
| `mcl list --remote --limit 30` | 列出远程可用版本                                                  |
| `mcl launch <版本>`              | 启动（加 `--auth` 用正版身份）                                      |
| `mcl info <版本>`                | 版本详情（主类、Java 要求、classpath）                                |
| `mcl java`                     | 列出本机 Java                                                 |
| `mcl doctor`                   | 自检（Node / 系统 / 下载源 / Java）                                |

启动参数：`--user`、`--memory`、`--width`、`--height`、`--dry-run`、`--detach`、`--auth`。
通用参数：`--source auto|mojang|bmclapi`（默认 `auto`）、`--force`。

装模组 / 整合包时可以带 `--loader fabric|forge|neoforge`（默认 fabric）和 `--instance <实例名>`
（不指定实例时按加载器自动准备一个）。

## 在 DSH 里用（插件）

仓库里的 `dsh-plugin/` 是配套的 DSH 插件：右下角浮窗（安装 / 启动进度、日志、内存、登录、崩溃诊断），
设置页里管版本与模组库。插件不需要额外配置，装上就能用本机的启动器。

1. 把仓库放在插件能找到的位置（插件默认找 `~/mc-launcher`，或用环境变量指定：

```bash
git clone https://github.com/end876/dsh-mcl ~/mc-launcher
set MCL_HOME=D:\path\to\mc-launcher     # 放别处时用这个
```

2. 把 `dsh-plugin/` 放进 DSH profile 的 `node_modules/`（包名 `@local/dsh-mc-launcher`），在 profile 的
   `cordis.patch.yml` 里挂一条：

```yaml
- insert:
    - id: mc-launcher
      name: '@local/dsh-mc-launcher'
```

插件会自己拉起 `bin/mcl.mjs`；启动器已经在跑就复用 `~/.mcl/server.json` 里记录的端口（动态端口 51730~51749）。
插件自己的说明见 [`dsh-plugin/README.md`](dsh-plugin/README.md)。

## 目录布局（与主流启动器兼容）

```
mc-launcher/
├── .minecraft/
│   ├── assets/           # 资源（各版本共享）
│   ├── libraries/        # 依赖库（各版本共享）
│   └── versions/
│       └── 1.20.1/
│           ├── 1.20.1.json
│           ├── 1.20.1.jar
│           ├── natives/           # 解压后的本地库
│           ├── saves/             # 存档（版本隔离）
│           ├── logs/              # latest.log（诊断读这里）
│           ├── .mcl-runtime.json  # 运行时快照（pid / 内存 / 退出码）
│           └── launcher-console.log
└── runtime/jre-17/       # 自动下载的 Java
```

默认游戏目录可用环境变量 `MCL_GAME_DIR` 指到已有的 `.minecraft`。

## 设计要点

1. **不托管任何游戏文件**。版本清单来自 Mojang，资源与库走官方或 BMCLAPI 镜像，Java 来自 Adoptium。
2. **源抽象层**：`src/source.mjs` 里每个源实现同样几个方法，换源只换一个对象。  
   BMCLAPI 对浏览器 UA 返回 403，所以请求统一用启动器 UA。
3. **不走 cmd/bat**。直接 `spawn(java, args[])`，避免 Windows 命令行长度（cmd 上限 8191）和引号地狱。
4. **零依赖 ZIP 读取器**（`src/zip.mjs`），用来解压 natives 和 JDK 包，不依赖外部二进制。
5. **离线 UUID 用标准算法**，保证换启动器后存档还能认出同一个玩家。
6. **JVM 参数按 Java 版本分档**：`SoftMaxHeapSize` 仅 12+，G1 细调要配  
   `-XX:+UnlockExperimentalVMOptions`，否则 Java 17 上 JVM 直接拒绝启动。
7. **诊断先规则化再交给模型**：`src/diagnose.mjs` 把常见崩溃特征结构化，接口同时给出  
   结论和报错片段，Agent 不必自己读整份日志。

## 免责声明

- 本项目**不包含**任何 Minecraft 游戏文件，也不提供账号或令牌分发；下载由使用者发起，资源来自  
  Mojang 官方与 BMCLAPI 的公开接口，**是否允许在当前地区/场景使用，请自行判断并遵守当地法律法规**。
- 离线与微软正版登录都支持；请支持正版：<https://www.minecraft.net/>。
- 本项目为 MIT，不打包也不执行任何第三方项目的代码或二进制；如果你在别处看到类似实现，
  建议先确认它的许可与来源是否写清楚。

## 路线图

- [x] 原版安装 + 离线启动
- [x] 图形界面（本地 Web，独立窗口）
- [x] Fabric 安装
- [x] Modrinth 模组 / 整合包 / 光影
- [x] 整合包导入与依赖检查
- [x] 崩溃日志归因
- [x] 微软正版登录
- [x] DSH 插件（浮窗 + 设置页）
- [x] Forge / NeoForge（Forge 1.20.1 已实测：装完进得了游戏）
- [x] Quilt
- [x] 界面重做（三套主题 + 自定义背景）
- [x] 浏览器版正版登录状态显示
- [x] 插件性能与稳定性收尾
- [ ] （可选）免装 Node 的分发包：仅当非 DSH 用户有需求再做（插件走 DSH 自带 Node，不受影响）

## 更新日志

### 1.1.1 · 测试版（2026-11-01）

- **解包路径收口**：`extractZip` 改用 `safeJoin`，绝对路径 / 盘符 / 任何 `..` 段条目直接跳过；
  越界 zip 测试（`../evil`、`..\evil2`、`C:/abs`、`a/../../x`）全部拒绝，正常条目不受影响
- 移除 `bin/mcl.mjs` 里恒返回 `'--'` 的 `sysFlagPrefix()` 死代码
- TODO 文档清理：ZIP 文件版读取标记完成、删掉 `dist/` 旧快照、Forge/NeoForge 标记 0.4.1 完成

### 1.1.0 · 测试版（2026-11-01）

- **崩溃修复助手**：崩溃后自动读取 crash-report / latest.log / launcher-console.log / 运行时快照 / mods 元数据，
  生成「结论 + 原因（带证据行）+ 可执行修复动作」的结构化报告，并落盘 Markdown
  - 覆盖 14 类原因（内存不足、Mixin 冲突、重复模组、缺前置、Java 版本、加载器版本、显卡、文件损坏等）
  - 动作：调内存、禁用 / 恢复 / 移除模组（移除有备份）、自动安装 Java、跳模组库装前置、打开报告、重新启动
- **实例管理**：版本页每个实例支持「启动 / 导出 / 删除」——导出成 CurseForge 结构整合包
  （`manifest.json` + `overrides/`，默认不含存档，可勾选包含；导出完自动下载），删除需确认且运行中会拒绝
- **下载进度条**：安装 / 下载任务从 CLI 输出解析百分比（阶段、已下载 / 总量、百分数），
  浏览器主区顶部和 DSH 浮窗 / 设置页都会显示进度条；启动游戏没有百分比时显示不定进度
- **大文件 / 超大整合包**：拖入或选择文件后流式上传到 `~/.mcl/uploads/`（12 小时过期），
  识别后可一键安装 / 导入；ZIP 读取改成文件版（只读尾部 EOCD + 中央目录，条目按需读盘），
  1.2GB 逻辑内容识别 4ms、内存不涨；上传上限 4GB
- **正版登录直达**：点「微软登录」自动打开微软登录页并复制设备码（被拦截时可用「打开登录页」按钮）；
  DSH 插件通过 `/api/open-url` 打开（只允许微软域名）
- **修「整合包无法下载 / 装不上」**：抽屉按页签分派（整合包 → `/api/pack/install`、光影 → `/api/shader/install`、
  模组 → 批量安装）；服务端 `/api/mod/install`、`/api/mods/install-batch` 先查项目类型，
  整合包 / 光影直接 400；模块内再加 `.mrpack` 兜底拦截
- **插件稳定性 / 性能**：进度事件 150ms 合并通知；刷新 / 重开浮窗从 `lastCrash` 恢复崩溃卡片；
  「自动安装 Java」改成后台任务（进度走 SSE）；api 默认 30s、崩溃修复 600s 超时
- **自动触发**：启动任务异常结束（退出码非 0 / 有新崩溃报告）→ 服务端自动诊断并通过 SSE 推送
  `{type:'crash', report}`；浏览器界面和 DSH 插件浮窗自动弹出修复建议，正常退出则清空
- 新增接口：`/api/crashfix`、`/api/crashfix/apply`、`/api/crash/last`、`/api/mods/toggle`、`/api/reveal`、
  `/api/instance/export`、`/api/exports/<file>`、`/api/instance/delete`、`/api/open-url`
- CLI：`mcl diagnose <实例> [--write]`、`mcl export <实例> [--include-saves]`、`mcl importpack <zip>`、`mcl java-install <版本>`
- 文档：[崩溃修复助手](docs/crash-fix.md)、[自定义背景](docs/custom-background.md)

### 1.0.2（2026-10-31）

- **修 BUG-001：游戏退出后界面仍显示「运行中」**（PID 被系统复用给别的进程）
  - 运行时快照里的 `stopped: true` 优先，不再拿陈旧 pid 判活
  - Windows 上用 `tasklist` 校验这个 PID 还是不是 java 进程，被复用一律视为已退出
  - `/api/state` 的 `runtime` 增加显式 `state`（`running` / `exited` / `unknown`）
- **修同源高危问题：`/api/stop` 可能误杀无关进程**
  - 停止前先做同样的 stopped + 身份校验，被复用的 PID 一律不动，返回 `{ ok: false }`
- 界面：已退出的实例提示「上一局已退出（退出码 X）」；没有进程时点停止会提示「当前没有正在运行的游戏」

### 1.0.1（2026-10-31）

- **本地整合包安装**：CurseForge 结构的 zip（manifest.json + overrides/）直接装成独立实例，
  实例名取压缩包文件名；overrides 里的 mod / 配置 / 资源包 / 光影按原样铺进实例目录
  （`mcl importpack <zip>`，界面识别结果里有「安装为实例」按钮，装完自动选中）
- 清单型整合包（mod 不在 overrides 里、需要从 CurseForge 下载）会提示缺多少个，
  并把清单写到实例目录的 `curseforge-required-files.txt`
- **大文件识别**：>8MB 的整合包走原始字节流上传（新增 `/api/mod/inspect-file`），
  浏览器版和插件都不再受 base64 / 96MB 限制；实测 626MB 的包 12.7 秒识别完成
- 修识别结果排版（字段挤成一串）和底部日志栏在背景图下的白底白字

### 1.0.0（2026-10-31）

- **界面重做**：左侧导航 + 主区 + 右侧常驻日志的三栏布局，版本/启动/模组库/日志一屏排开

- **三套主题**（默认 C）：
  - A · 深海玻璃：深蓝渐变 + 青色玻璃
  - B · 像素方块：MC 原生粗边框 + 草绿
  - C · 极简白：浅色、细线、留白

- **自定义背景**：本地上传图片（浏览器里自动压到 ≤2560px 再传，存 `~/.mcl/ui/`），四套样式预设：
  - 亮雾 / 深海 / 渐变 / 暗玻璃，配「模糊 / 压暗 / 玻璃不透明度 / 焦点位置」四个滑杆
  - 像素风遇到背景自动强制实底，避免边框叠照片
- 设置入口：左侧「外观」（`/api/ui/appearance`、`/api/ui/background`）
- **修浏览器版登录后不显示账号**（从 v0.4 遗留的接线遗漏）：`refreshAuth()` 定义了但从未调用，
  SSE 也没处理 `auth` 事件；现在启动即刷新账号、登录成功自动更新按钮/关弹窗/弹提示
- 新增「退出登录」按钮；启动提示按登录状态显示「正版账号 X / 离线玩家 X」；已登录按钮给绿色态
- **界面分页化**：左侧按钮切独立页面（启动 / 版本 / 模组库 / 日志 / 外观）
- **运行日志移到底部**：横跨主区底部、滑入进场、点标题收起；左侧「日志」进入独立全屏日志页（复制 / 清空）
- **插件稳定性与性能**：api 15 秒超时、端口并行探测、状态轮询变化才通知、SSE 日志合并通知、
  搜索竞态修复、大文件识别拦截、Host 半边重启自愈
- DSH 插件（设置页 + 右下浮窗）跟随启动器外观里的 A / B / C 主题
- 新增 [自定义背景文档](docs/custom-background.md)
### 0.6.2（2026-10-31）

- **浏览器版模组库的无限下拉修好了**：滚动监听原来挂在 `.drawer` 上（不滚动），
  实际滚动容器是 `#drawer-list` 自己，所以滚到底永远不触发；现在挂对了，滚到底就会接着加载
- 第一页没把容器撑满（没有滚动条）时自动继续拉，避免“没得滚”
- 追加下一页时按当前分类筛选，不会混进不匹配的行
### 0.6.1（2026-10-31）

- **模组库改成无限下拉**（DSH 插件设置页）：滚到列表底部自动加载下一页，不用再点「加载更多」；
  每页 20 个、按 id 去重，到底显示「没有更多了（共 N 个）」
- 切「模组 / 整合包 / 光影」页签或换实例时自动搜第一页并清空旧列表（原来是残留上一页的内容）
- 顺手修了「加载更多」在总数对不上时会空转的问题（去重后没新内容就停止）
### 0.6.0（2026-10-30）

- **新增 Quilt 支持**：`src/quilt.mjs` 走 Quilt 官方 meta 的 profile json（和 Fabric 一条思路，没有 installer/processors）
  - 加载器列表：不拉官方那份 ~900KB 的 `versions/loader/<mc>`，改用 maven 元数据里的稳定版候选 + 并发探测 profile（每个 ~1.5KB），结果缓存 3 天
  - 依赖下载：`maven.fabricmc.net` 的库走 BMCLAPI 镜像，`maven.quiltmc.org` 只能直连（BMCLAPI 没有镜像，国内会慢）
  - 实例名沿用 Quilt 官方 id：`quilt-loader-<版本>-<mc>`；主类 `org.quiltmc.loader.impl.launch.knot.KnotClient`
- CLI：`mcl quilt <mc>`（`--loader` 指定版本、`--list-loaders` 看可用版本）
- HTTP：`/api/loader/list|install` 支持 `quilt`；`/api/state` 的实例列表显示 Quilt
- 模组：`mcl mod/mods --loader quilt`、插件模组库选 Quilt 实例直接装；mrpack 按 `deps["quilt-loader"]` 分派
- 插件：安装游戏的加载器下拉加 Quilt
- 下载器支持**断点续传**（HTTP Range）：慢网络下 watchdog 掐断连接后从 .part 继续，不再从头下（对这次 Quilt 的慢源尤其关键）
- 下载层从 `fetch` 换成 `node:https`：Node 内置 fetch 的连接超时写死 10 秒，慢网络下 Cloudflare/镜像握手超过 10 秒就直接失败；现在连接超时 120s、空闲超时 90s，重定向自己跟

### 0.5.2（2026-10-30）

外部技术评测（v0.4.0 代码审查）里的高危/中危项修复：

- **安全：/api/logs 与 /api/diagnose 的路径穿越**：`instance` 参数现在走 `installedVersions()` 白名单，
  且目录必须落在 `versions/` 里；实测 `..\..\..\..\Downloads\x` 返回 404，读不到游戏目录外的日志
- **安全：一条畸形请求行会让进程退出**：URL 解析移进 try、整个 handler 包 `.catch`、
  `sendJson` 兼容已发头的情况、补 `clientError` 处理；实测畸形目标不会崩（绝对形式会被归一成
  路径照常处理，真正畸形的目标返回 400），服务继续存活
- **安全：整合包解压路径穿越**：新增 `safeJoin()`（拒绝绝对路径 / 盘符 / UNC / 任何 `..` 段），
  `import.mjs` 与 mrpack（files + overrides）全部改用它；越界条目跳过并记一条警告
- **安装中断不再留半成品**：版本描述 json 改为全部下载完成后才写（tmp + rename），
  `readLocalVersionJson` 遇到截断/损坏的 json 跳过（不再让 `/api/state` 500），
  扫描版本目录时排除 `.mcl-runtime.json` 这类隐藏文件
- Fabric 依赖补上 sha1/size 校验（`lib.sha1` / `lib.size` 顶层字段，之前只读 `downloads.artifact`）
- 崩溃诊断：在 crash-reports 与 logs 里取**全局最新**的文件；`latest.log` 改为读末尾 256KB
  （堆栈在末尾，读开头会漏）
- 登录链路：设备码轮询时长按微软返回的 `expires_in`（约 15 分钟）走，不再 5 分钟就放弃；
  同一时间只允许一个设备码流程；设备码申请失败会立刻返回错误而不是把请求挂住；
  **新增 refresh_token 自动续期**（`ensureFreshAuth`，快过期时用 refresh_token 换新令牌，失败则退回离线）
- 支持 `MCL_CLIENT_ID` 环境变量换成自己的 Azure 应用（插件登录面板有提示）
- 插件 Host 半边：异步初始化补 `.catch`（未捕获拒绝会让 DSH fail-loud 退出）、
  收集子进程 stderr 尾部并写宿主日志、意外退出时有限次退避重启、插件被搬走也能按自身路径找回源码
- 插件补 `peerDependencies`（cordis / dsh / dsh-client-ui-slots / react）与 `engines`
- 插件隐藏浮窗时**整个卸载面板**（订阅和定时器一起停，不再后台轮询）
- 登录的 SSE 事件带时间戳，只认本次登录之后的事件（避免上一次的结果把新面板顶掉）
- `mcl --help` / `mcl -h` 现在打印帮助（之前 positional 为空会回落成 `gui`）
- 查询接口遇到 404/403 不再重试；mods.toml 依赖按 NeoForge `type="required"` / Forge `mandatory` 过滤
- `/api/mod/inspect-path` 文件不存在时不再回显同目录文件名（避免被当目录枚举接口）

### 0.5.1（2026-10-30）

- **修模组库装错实例**：`/api/mods/install-batch` 之前把请求里的 `loader` 丢了，选 Forge/NeoForge 实例
  也会按 Fabric 装进另一个实例。现在 `loader`、`instance` 都会透传，装了哪个实例就装哪个；
  没指定实例时才按加载器自动准备（Fabric 建 `fabric-<mc>-mods`，Forge/NeoForge 复用/新建对应实例）
- 修「安装这 N 个前置」按钮点了报错：`SettingsSection` 里误用了不存在的 `loader` 变量
- 修启动器版本号残留 0.4.0（`--dry-run` 里可见），改为 0.5.1
- 修 `loaderOfVersion()` 把 NeoForge 判成 Forge（两者 mainClass 都是 BootstrapLauncher）
- CLI：`mcl mod` / `mcl mods` 新增 `--instance <实例>`，可指定装进哪个实例
- 加载器判定统一到 `src/loader.mjs`（CLI / HTTP / 插件共用）：看 `--fml.neoForgeVersion`、`--fml.forgeVersion`
  参数和库名，`mcl list` 也会显示 Forge / NeoForge 标签了
- 验证：全新 clone 直接能跑；原版与 Fabric 启动无回归；`mcl mod --loader forge` 正确装到 Forge 实例

### 0.5.0（2026-10-30）

- 插件设置页「安装游戏」收尾：加载器下拉（原版 / Fabric / Forge / NeoForge），选了加载器会按 MC 版本  
  自动拉可用加载器版本（防抖 500ms），可以指定具体版本，默认用推荐版
- 修 `/api/state` 的加载器识别：Forge / NeoForge 1.17+ 的 mainClass 都是 BootstrapLauncher，  
  改从 `--fml.neoForgeVersion` / `--fml.forgeVersion` 参数判断，实例列表不再把 Forge 显示成「原版」
- 模组库标题的加载器标签不再写死 Fabric，跟着当前实例走

### 0.4.1（2026-10-30）

- **Forge / NeoForge 支持**：读 installer 里的 `install_profile.json` 自己跑 processors  
  （binpatch / jarsplitter / AutoRenamingTool），依赖与 installer 都走 BMCLAPI maven 镜像
- 修 BootstrapLauncher 实例的 classpath：不再塞原版 client jar；继承链里重复的库（如 gson）去重，  
  否则 NeoForge 的 UnionFileSystem 会抛 `Duplicate key`
- mrpack 整合包按 `deps.fabric-loader / forge / neoforge` 分派，不再拒绝 Forge 包  
  |  |  |  
  | --- | --- |
- `mcl mod` / `mcl mods` 支持 `--loader forge|neoforge`，会复用同版本的加载器实例
- 新增 `/api/loader/list`、`/api/loader/install`；插件设置页的安装卡片加了加载器下拉
- 实测：Forge 1.20.1（进游戏）、NeoForge 21.1.1（进游戏）、Forge mrpack「Optimized fps」（22 个模组加载）
- processor 输出默认静默，只在失败时回显最后 15 行

### 0.4.0（2026-10-30）

- 模组库搬进 DSH 插件：Modrinth 搜索（模组/整合包/光影）、冲突预检、批量安装、进度走 SSE
- 前置依赖从「只补一层」改成递归展开（最多 4 层、防环）
- 本地 jar 解析出它依赖哪些 mod（fabric/quilt/forge 三种元数据），新增 `/api/mods/resolve`  
  把 mod id 反查成 Modrinth 项目，可一键装缺失前置
- `/api/state` 每个版本多一个 `mc` 字段（实例真实 MC 版本，整合包按 mod 名投票推断）
- 搜索结果附带中文分类 `categoriesZh`

### 0.3.0（2026-10-30）

- **动态端口**：51730 被占用时自动往后找（最多 20 个），实际端口写进 `~/.mcl/server.json`；  
  插件和浏览器界面都能发现并自动重连（含 SSE），不用再抢端口
- 修复 `/api/events` 缺 CORS 头：跨源页面（DSH 的 `dsh-app://app`）订阅 SSE 会被浏览器拦掉
- `server.json` 增加正常退出时的清理（被强杀时残留无害，客户端以 HTTP 校验为准）

### 0.2.0（2026-10-30）

- DSH 浮窗重写：拖动 / 收起、日志尾巴、内存条、登录、崩溃诊断
- `/api/logs`、`/api/state` 的 `runtime` 与 `auth`、`.mcl-runtime.json`
- 支持正版身份启动（`--auth`），`/api/stop` 也能收掉命令行启动的游戏
- 修复 Java 17+ 因 G1 实验参数起不来（缺 `UnlockExperimentalVMOptions`）
- 修复 DSH 页面来源 `dsh-app://app` 被 CORS 403、浮窗位置算到屏幕外、面板不透明化
- 独立窗口改为 `cmd /c start` 启动（避免继承隐藏状态开成最小化）

### 0.1.0

- 原版安装、离线启动、图形界面、模组识别
