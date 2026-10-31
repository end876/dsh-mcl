# 验证记录

本文件记录每次改动后实际跑过的验证，方便发版前对表。日期为本地时间（Asia/Shanghai）。

## 0.5.1（2026-10-30）

环境：Windows 11 / Node v24.21.0（Electron 自带运行时）/ Java 17 + 21（自动补齐）

| # | 项目 | 做法 | 结果 |
| --- | --- | --- | --- |
| 1 | Forge 安装 + 启动 | `mcl forge 1.20.1` → `launch` | ✅ 实例 `1.20.1-forge-47.4.28`，ModLauncher + texture atlas 正常 |
| 2 | NeoForge 安装 + 启动 | `mcl neoforge 1.21.1 --loader 21.1.265` → `launch` | ✅ Java 21 自动就位，NeoForge mod loading + OpenAL 正常 |
| 3 | Forge 整合包 | `mcl pack optimized-fps --mc 1.20.1` → `launch` | ✅ 实例 `forge-1.20.1-optimized-fp`，25 个 jar、mixin 正常 |
| 4 | 原版 / Fabric 启动回归 | `1.20.1`、`fabric-loader-0.20.1-1.20.1` | ✅ 均到 `Sound engine started` |
| 5 | `mcl list` 加载器标签 | 8 个实例 | ✅ 原版 / Fabric / Forge / NeoForge 全部正确 |
| 6 | `mcl info` | Forge 实例 + 1.21.1 | ✅ Java 17 / 21、客户端 jar 指回原版本 |
| 7 | `mcl doctor` | 本地跑 | ✅ bmclapi / mojang 源均可达（bmclapi 约 60s） |
| 8 | `mcl mod --loader forge` | `architectury-api` | ✅ 落到 Forge 实例，下载 forge 变体 |
| 9 | `mcl mod --instance` | 指定 `forge-1.20.1-optimized-fp` | ✅ 落到指定实例 |
| 10 | `/api/loader/list` | forge 1.20.1 / neoforge 1.21.1 | ✅ 47.4.28 / 21.1.265… 共 260 条 |
| 11 | `/api/loader/install` 校验 | 非法 loader、缺 MC 版本 | ✅ 均 400 |
| 12 | `/api/mods/install-batch`（loader + instance） | 装 `jei` 到整合包实例 | ✅ `jei-1.20.1-forge-15.74.0.233.jar` 落盘 |
| 13 | 全新 clone 冒烟 | `git clone` → `mcl list` / `help` | ✅ 发布出去的代码能直接跑 |

## 已知未覆盖

- NeoForge 整合包（.mrpack）没有真包验证，只验证了加载器安装与 Forge 包分派
- Quilt 未支持
- 微软正版登录只验证了设备码流程能拿到 token，没有真启动过一次在线游戏

## 0.5.2 安全项抽查（2026-10-30）

服务跑在 127.0.0.1，用 curl / 裸 TCP 打：

| # | 探测 | 结果 |
| --- | --- | --- |
| 1 | `/api/logs?instance=..%5C..%5C..%5C..%5CWindows%5Cwin.ini` | ✅ 404，读不到游戏目录外的文件 |
| 2 | `/api/logs?instance=1.20.1` | ✅ 200 正常 |
| 3 | 绝对形式请求目标（`GET http://evil.example/`） | ✅ 归一成路径处理（200），进程不崩 |
| 4 | 畸形 URL 编码（`%E0%A4%A`） | ✅ 404，进程不崩 |
| 5 | `/api/mod/inspect-path` 指向不存在文件 | ✅ 400，不回显同目录文件名 |
| 6 | 上述折腾后 `/api/state` | ✅ 200，服务存活 |

## 1.1.0 移植验证（2026-10-31）

把朋友基于 1.0.0 的 v1.1.0（崩溃修复助手）三路合并进我们的 1.0.2，逐项回归我们的修复仍然在。

| # | 项目 | 做法 | 结果 |
| --- | --- | --- | --- |
| 1 | 崩溃分析 | 假实例 + OOM crash-report + latest.log → `buildFixReport` | ✅ `summary=内存不足（Java 堆耗尽）`，给出 `set-memory`，报告落盘 `crash-reports/mcl-fix-latest.md` |
| 2 | `/api/crashfix` | 沙箱服务 POST | ✅ 返回结构化 report（causes=oom） |
| 3 | `/api/crash/last` | 沙箱服务 GET | ✅ 返回最近一次报告 |
| 4 | `/api/mods/toggle` | `sodium.jar` 禁用 | ✅ 改名为 `sodium.jar.disabled` |
| 5 | `/api/reveal` 越界 | 传 `C:\Windows\System32` | ✅ 400 拒绝 |
| 6 | 崩溃弹窗 UI | CDP 注入 report 调 `showCrash()` | ✅ 弹窗显示摘要/原因/证据/修复按钮，0 JS 错误 |
| 7 | 插件冒烟 | `tmp/plugin-smoke.mjs` | ✅ settings.section / shell.overlay 正常渲染 |
| 8 | 1.0.2 修复仍在 | 沙箱快照 `stopped:true` + 复用 PID | ✅ `running:false`、`state:exited`、`/api/stop` 返回 `ok:false` |
| 9 | 1.0.1 修复仍在 | `mcl help` / 路由 / CLI | ✅ `importpack`、`/api/mod/inspect-file`、`/api/pack/import-local` 均在 |

## 1.0.2 PID 复用回归（2026-10-31）

| # | 用例 | 结果 |
| --- | --- | --- |
| 1 | 快照 `stopped:true` + pid 指向存活非 java 进程 | `running:false` / `alive:false` / `state:exited` / `uptime:null` |
| 2 | 同上点 `/api/stop` | 返回 `{ok:false}`，目标进程未被杀 |
| 3 | 快照无 stopped + pid 被非 java 复用 | `alive:false` / `state:unknown`，不杀进程 |
| 4 | `/api/logs` | `running` 与 `/api/state` 一致 |

## 1.0.1 大文件与本地整合包（2026-10-31）

| # | 用例 | 结果 |
| --- | --- | --- |
| 1 | 626MB「元素觉醒1.4.6」`POST /api/mod/inspect-file` | ✅ 12.7s 返回 CurseForge / Forge 1.20.1 / 252 个文件 |
| 2 | 浏览器拖入 >8MB 文件 | ✅ 走流式上传并渲染识别结果 |
| 3 | 合成 CurseForge 小包点「安装为实例」 | ✅ 实例名 = zip 名，overrides 落地，自动选中 |
## 1.1.0 崩溃修复助手（2026-10-31）

环境：Windows 11 / Node v24.21.0（DSH 内置）/ Java 17（启动器自带 JRE）

| # | 项目 | 做法 | 结果 |
| --- | --- | --- | --- |
| 1 | 规则引擎离线单测 | `node test-fixtures/run-crashfix-tests.mjs`（6 类崩溃 + 正常退出 + 追加日志回归 + 文件动作 + 穿越防护） | ✅ 13/13 |
| 2 | 浏览器面板 E2E | `node test-fixtures/run-ui-e2e.mjs`（真服务 + 无头 Edge + 真崩溃实例） | ✅ 13/13：入口/弹窗/cause/证据/修复按钮/调内存、SSE 自动弹窗、/api/state.lastCrash |
| 3 | 自动触发 E2E | 假实例（mainClass 不存在）+ 真 Java → CLI 退出码 1 → SSE `crash` 事件 | ✅ 报告命中 `missing-class`，证据来自 launcher-console.log，落盘带时间戳 md |
| 4 | HTTP API | `/api/crashfix`、`/api/crashfix/apply`、`/api/crash/last`、`/api/mods/toggle`、`/api/reveal` | ✅ 正常路径 + 404/400 + `needsClient` 透传；禁用/启用 mod 真改文件名 |
| 5 | CLI | `mcl diagnose test-oom --write`、`mcl launch`（崩溃时退出码） | ✅ 输出结论/证据/修复建议并落盘；`--write` 生效 |
| 6 | DSH 插件半静态验证 | `node --check` + 迷你 React 渲染器离线冒烟（假 SSE/fetch） | ✅ 46 项断言全过（浮窗红卡/设置页/回退/兜底） |
| 7 | 真实实例误报回归 | 正常退出的 `1.20.1`（追加日志里有历史报错） | ✅ 修复后 `crashed:false`，不再误报 JVM 参数 |
| 8 | 已安装副本部署 | 原地更新至 1.1.0，daemon 重启 | ✅ `/api/state` 带 `lastCrash`；`/api/crashfix` 对正常实例返回“没有发现崩溃痕迹” |

**已知未覆盖**：没有用真实整合包/真实 mod 冲突制造一次崩溃（用假实例 + 真实 Java 失败路径代替）；
DSH 插件 UI 需要重启 DSH 后才能在真实浮窗里人工确认。