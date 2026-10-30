# mc-launcher（0.4.0）

一个**零依赖**的 Node 版 Minecraft 启动器：装原版 / Fabric、搜装模组与整合包、离线或正版启动，
带崩溃诊断和一整套 HTTP 接口，可以直接被脚本和 AI 驱动。

> 目标不是复刻 PCL 的界面，而是做一个**可被脚本和 AI 驱动**的启动器核心：
> 安装、启动、日志诊断都是可调用的步骤。
> DSH 用户可以直接用配套插件 `@local/dsh-mc-launcher`（右下角浮窗 + 设置页）。

## 特性（0.4.0）

- ✅ 从 Mojang 官方 / BMCLAPI 镜像自动下载安装**原版**任意版本（auto 选源，失败回退）
- ✅ 自动补齐 Java 运行时（Adoptium JRE，按版本需求自动选 8 / 17 / 21，走清华镜像）
- ✅ 离线登录（标准 `OfflinePlayer:<name>` UUID，兼容存档）+ **微软设备码登录**
- ✅ 版本隔离目录（和 PCL 一致：`versions/<版本名>/` 作为独立游戏目录）
- ✅ 下载 SHA1 校验、断点跳过、失败重试、并发下载（并发 5）
- ✅ **Fabric** 实例安装（按配置隔离 `fabric-<mc>-<label>`）
- ✅ **Modrinth** 搜索 / 分类 / 排序、冲突检测、前置依赖、批量安装
- ✅ `.mrpack` 安装、**解压即玩**包导入（合并 + 覆盖前备份）
- ✅ 光影下载（自动检查 Iris）
- ✅ 内存滑条 + 安全上限（可用内存 − 1G）+ 按 Java 版本分档的 JVM 参数
- ✅ **崩溃诊断**：8 条规则归因，命令行和接口都能用
- ✅ 日志尾巴接口 `/api/logs` + 运行时快照（真实 java pid / 内存 / 退出码）
- ✅ **动态端口**：51730 被占用自动往后找，实际端口写 `~/.mcl/server.json`，客户端自动发现
- ✅ SSE 事件流（安装/启动进度、登录结果），带跨源 CORS
- ✅ **模组库（DSH 插件里）**：Modrinth 搜索、冲突预检、批量安装、前置递归补齐、本地 jar 前置识别
- ⬜ Forge / NeoForge（暂只支持 Fabric）

## 快速开始

需要 Node.js ≥ 20，无需 `npm install`（零第三方依赖）。

```bash
node bin/mcl.mjs doctor                    # 环境与下载源自检
node bin/mcl.mjs install 1.20.1            # 下载安装原版 1.20.1（约 700MB 资源）
node bin/mcl.mjs fabric 1.20.1             # 装一个 Fabric 实例
node bin/mcl.mjs launch 1.20.1 --user 你的名字 --memory 4G
```

也可以装成命令：`npm link` 之后直接用 `mcl`。

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

## 在 DSH 里用（插件）

仓库里的 `dsh-plugin/` 就是这个启动器的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件：右下角可拖动的浮窗（安装/启动进度、日志、内存、登录、崩溃诊断），设置页管版本与安装，Modrinth 模组库也在插件里。

1. 把仓库放在插件能找到的位置（插件默认找 `~/mc-launcher`，或用环境变量指定）：

```bash
git clone https://github.com/<你>/dsh-mcl ~/mc-launcher
set MCL_HOME=D:\path\to\mc-launcher    # 放别处时用这个
```

2. 把 `dsh-plugin/` 放进 DSH profile 的 `node_modules/`（包名 `@local/dsh-mc-launcher`），在 profile 的 `cordis.patch.yml` 里挂一条：

```yaml
- insert:
    - id: mc-launcher
      name: '@local/dsh-mc-launcher'
```

插件会自己拉起 `bin/mcl.mjs`；启动器已经在跑就复用 `~/.mcl/server.json` 里记录的端口（动态端口 51730~51749）。

插件自己的说明见 [`dsh-plugin/README.md`](dsh-plugin/README.md)，安装细节见 [`操作文档.md`](操作文档.md)。

## 命令

| 命令 | 说明 |
|---|---|
| `mcl gui` | 打开图形界面 |
| `mcl install <版本>` | 安装原版；版本支持 `latest` / `1.20.1` / `1.21` |
| `mcl fabric <mc版本>` | 安装 Fabric 实例 |
| `mcl mod <项目ID> --mc 1.20.1` | 装一个 Modrinth 模组（含前置依赖） |
| `mcl pack <项目ID> --mc 1.20.1` | 装一个 Modrinth 整合包 |
| `mcl import "<zip路径>"` | 导入解压即玩包（合并 + 备份） |
| `mcl check` | 检查重复模组 |
| `mcl diagnose <实例>` | 崩溃诊断 |
| `mcl login` | 微软设备码登录 |
| `mcl list` | 列出已安装版本 |
| `mcl list --remote --limit 30` | 列出远程可用版本 |
| `mcl launch <版本>` | 启动（加 `--auth` 用正版身份） |
| `mcl info <版本>` | 版本详情（主类、Java 要求、classpath） |
| `mcl java` | 列出本机 Java |
| `mcl doctor` | 自检（Node / 系统 / 下载源 / Java） |

启动参数：`--user`、`--memory`、`--width`、`--height`、`--dry-run`、`--detach`、`--auth`。
通用参数：`--source auto|mojang|bmclapi`（默认 `auto`）、`--force`。

## 目录布局（与 PCL / HMCL 兼容）

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

- 本项目**不包含**任何 Minecraft 游戏文件，也不提供账号或令牌分发。
- 离线与微软正版登录都支持；请支持正版：<https://www.minecraft.net/>。

## 路线图

- [x] 原版安装 + 离线启动
- [x] 图形界面（本地 Web，独立窗口）
- [x] Fabric 安装
- [x] Modrinth 模组 / 整合包 / 光影
- [x] 整合包导入与依赖检查
- [x] 崩溃日志归因
- [x] 微软正版登录
- [x] DSH 插件（浮窗 + 设置页）
- [ ] Forge / NeoForge
- [ ] 发行打包（免装 Node）

## 更新日志

### 0.4.0（2026-10-30）

- 模组库搬进 DSH 插件：Modrinth 搜索（模组/整合包/光影）、冲突预检、批量安装、进度走 SSE
- 前置依赖从「只补一层」改成递归展开（最多 4 层、防环）
- 本地 jar 解析出它依赖哪些 mod（fabric/quilt/forge 三种元数据），新增 `/api/mods/resolve`
  把 mod id 反查成 Modrinth 项目，可一键装缺失前置
- `/api/state` 每个版本多一个 `mc` 字段（实例真实 MC 版本，PCL 包按 mod 名投票推断）
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
