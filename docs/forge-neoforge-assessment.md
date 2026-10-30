# Forge / NeoForge 支持评估（0.5.0 前置调研）

结论先说：**能做，但不能照抄 Fabric 那条路。**

Fabric 的安装是「读 profile JSON → 下载它列出的库 → 写版本文件」，因为 Fabric 的库全在 maven 上、不需要改原版 jar。
Forge / NeoForge（1.13 以后）不是：installer 里带的是 `install_profile.json` + 10 个 **processor**，
它们要用 Java 跑一遍二进制补丁（binpatch / SpecialSource / jarsplitter），把原版 jar 加工成
`forge-<ver>-client.jar`，产物不在任何 maven 上。**不跑 processors 就没有可启动的 client jar。**

## 实测数据（本机，2026-10-30）

| 端点 | 结果 |
| --- | --- |
| `files.minecraftforge.net/.../promotions_slim.json` | 200，8.8s |
| `maven.minecraftforge.net/.../forge/maven-metadata.xml` | 200，20.0s（极慢） |
| `maven.neoforged.net/.../neoforge/maven-metadata.xml` | **000（不可达）** |
| `bmclapi2.bangbang93.com/maven/...`（Forge universal / installer） | 302 → 可下载，5.7MB 的 installer 很快拿下来 |
| `bmclapi2.bangbang93.com/maven/...neoforge...` | 首次 200（68KB，1s），之后抖动 404/超时 |
| `net/minecraftforge/forge/1.20.1-47.2.0/...-client.jar` | 404（证实 client jar 只能由 processor 生成） |

Forge 1.20.1-47.2.0 的 installer 内部：`install_profile.json`（46 个 libraries、**10 个 processors**）+ `version.json`。
本机已有可用的 `runtime/jre-17/.../bin/java.exe`，够跑 1.17–1.20 的 processors。

## 两条路线

**A. 直接跑官方 installer（`java -jar installer.jar --installClient`）**
- 代码量最小（100 行内），官方行为最准
- 但它自己去 maven.minecraftforge.net 拉几十个文件：本机单请求 20s，一次装完可能十几分钟；NeoForge 更是直接不可达
- 结论：只能当兜底，不能当主路径

**B. 自己实现 processors（推荐，HMCL/PCL 的做法）**
- 从 installer jar 里读 `version.json` + `install_profile.json`
- 按 `data` 表把 `{KEY}` 变量替换成真实路径（literal 或某个 library 的文件）
- 按顺序跑每个 processor：`java -cp <classpath> <mainClass> <args…>`，跳过 `sides` 不含 client 的
- 所有 maven 下载统一走 `bmclapi2/maven`（镜像重写），绕开官方慢源
- 产物写进 `libraries/` 和 `versions/<id>/`
- 大约 300–400 行，风险集中在 `data` 变量替换和 processor 参数顺序

## 改动清单（估算）

| 文件 | 改动 |
| --- | --- |
| `src/loader.mjs`（新增） | 版本列表（Forge promotions / NeoForge maven-metadata）、installer 下载、processors 执行、镜像重写 |
| `src/source.mjs` | `libraryUrl` 增加 forge/neoforged maven → bmclapi 重写 |
| `src/mcl.mjs` | `mcl forge <mc>` / `mcl neoforge <mc>`，`--loader-version` |
| `src/server.mjs` | `/api/loader/list`、`/api/loader/install`；`/api/state` 的 loader 字段已能从小写识别 |
| `src/modrinth.mjs` | mrpack 安装按 `deps.forge / deps.neoforge / deps['neoforge']` 分派，不再一律抛错 |
| `src/fabric.mjs` | 抽出 `ensureInstance` 的 loader 前缀（现在硬编码 `fabric-`） |
| `dsh-plugin/` | 设置页加载器下拉、安装进度文案；mod 安装带 `--loader` |
| `README.md` / 路线图 | 勾掉 Forge / NeoForge |

## 风险

1. **NeoForge 官方源被墙**，只能依赖 BMCLAPI；镜像抖动时安装会失败并需要重试（要有明确报错，不要静默）
2. **processor 的 `data` 变量**容易漏（`{MINECRAFT_JAR}`、`{BINPATCH}`、`{ROOT}` 等），跑错会得到一个能启动但一进游戏就崩的实例 → 必须真启动一次验证
3. **Java 版本**：1.20.5+ 要 Java 21，1.17–1.20.4 要 17，1.16.5 及以下要 8；`java.mjs` 目前只备了 17，需要补 8 / 21
4. **Fabric 实例前缀写死**（`fabric-`），加加载器时要把实例命名规则统一

## 验收

1. `mcl forge 1.20.1` 从零装出一个实例，`mcl info <id>` 能看到 main class = `cpw.mods.bootstraplauncher.BootstrapLauncher`
2. `mcl launch <id> --dry-run` 的 classpath 里出现 `forge-1.20.1-47.2.0-client.jar`
3. 真启动一次，日志里出现 `Loading 47.2.0` 且能进主菜单
4. mrpack：一个 Forge 整合包不再被 `modrinth.mjs` 拒绝，能装完并启动
5. 同一条链路跑一个 NeoForge 版本（网络允许时）

---

## 实现状态（2026-10-30 晚）

已按 B 方案落地：

- src/loader.mjs：installer 下载（BMCLAPI 镜像）→ 解 ersion.json / install_profile.json →
  下载两套 libraries → 解出 data/* 字面量 → 按 sides 过滤后顺序跑 processors →
  写版本文件；产物校验（Forge 的 `forge-<mc>-<ver>-client.jar`）
- src/launch.mjs：BootstrapLauncher 的实例不再把原版 client jar 塞进 classpath
  （否则 `Modules _1._20._1 and minecraft export package com.mojang.blaze3d.systems to module forge`）
- in/mcl.mjs：`mcl forge` / `mcl neoforge`，`--loader` / `--list-loaders`
- src/server.mjs：`GET /api/loader/list`、`POST /api/loader/install`，模组安装透传 `loader`
- src/modrinth.mjs：mrpack 按 `deps.fabric-loader / forge / neoforge` 分派；模组安装支持三种加载器

实测：`mcl forge 1.20.1` → 实例 `1.20.1-forge-47.4.28`，安装 94 个 classpath 条目，
启动后 ModLauncher / Mixin / EARLYDISPLAY 正常，渲染线程跑起来（能进游戏）。

未实测：NeoForge 全流程（源码同一条链路，但 neoforged 官方源不可达，只验证了版本列表 260 条经 BMCLAPI 可读）；
mrpack 的 Forge 分派（逻辑已接，缺一次真包验证）。