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
