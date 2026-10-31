# dsh-mc-launcher · 插件说明

在 DSH 里操作 Minecraft：设置页管版本、安装、**模组库**（搜索/冲突预检/批量安装），右下角浮窗看状态（拖动 / 进度 / 日志 / 内存 / 登录 / 崩溃诊断）。

- 包名：`@local/dsh-mc-launcher`
- 版本：**1.0.0**（2026-10-31）
- 配套启动器：`mc-launcher` 1.0.0（需要它的 HTTP 服务；端口默认 51730，被占用会自动往后找）
- Host 半边：激活时先在 `~/.mcl/server.json` 和 51730~51749 里找已在跑的启动器，没有就用内置 Node 拉起
- 客户端：同样按发现文件/端口范围找服务，端口变了自动重新连（含 SSE）

---

## 安全与兼容

- 只监听 `127.0.0.1`；`/api/logs`、`/api/diagnose` 的实例名走已安装版本白名单，不接受任意路径
- 整合包/覆盖文件解压走 `safeJoin()`：绝对路径、盘符、UNC、`..` 段一律拒绝
- 登录用设备码，插件不接触账号密码；凭证存 `~/.mcl/auth.json`（0600，明文 token）
- 默认 client id 来自 Prism Launcher；可设 `MCL_CLIENT_ID` 换成自己的 Azure 应用后重启 DSH
- `peerDependencies` 声明了 cordis / dsh / dsh-client-ui-slots / react；DSH 大版本升级时留意兼容性

---
## 一、文件构成（干净插件，共 8 个文件）

| 文件 | 作用 |
|---|---|
| `package.json` | 包信息、`dsh.bundle` / `dsh.client` 声明 |
| `cordis.patch.yml` | 往 profile 插入 `mc-launcher` 这个 Loader 条目 |
| `index.js` | Host 半边：只负责“保证启动器服务在跑”，进程生命周期 |
| `client.js` | Client 半边：设置页区块 + 可拖动浮窗（全部界面在这里；配色跟随启动器「外观」的 A/B/C 主题） |
| `locale/zh.json` `locale/en.json` | 插件列表里的名称与描述 |
| `icon.svg` | 插件图标 |

没有任何构建步骤、没有依赖、没有运行时产物（日志/缓存都写在启动器自己的目录里）。

---

## 二、安装

1. 把整个目录放到任意固定位置，例如 `C:\Users\<你>\Documents\mc-launcher-bundle`。
2. 编辑 DSH profile 的 `package.json`（`~/.dsh/profiles/<profile>/package.json`），加两处：

```json
{
  "dependencies": {
    "@local/dsh-mc-launcher": "link:C:/path/to/mc-launcher-bundle"
  },
  "dsh": {
    "profile": {
      "bundles": [ "...", "@local/dsh-mc-launcher" ]
    }
  }
}
```

3. 让 DSH 重新安装 profile 依赖并**重启 DSH**（Host 半边在启动时加载）。
4. 设置 → Minecraft 出现区块即装好。

卸载：删掉上面两处 + 重启 DSH；启动器服务进程会随之退出。

---

## 三、界面

### 设置页（设置 → Minecraft）

- **窗口**：内置浮窗 `显示浮窗 / 隐藏浮窗` 独立开关；`打开独立窗口`（打开后自动收起内置浮窗）
- **启动游戏**：实例下拉、玩家名、内存（1~12G）、启动 / 停止
- **安装原版**：输入 `1.20.1` / `latest` 等
- **模组库**：
  - 模组 / 整合包 / 光影三个页签，搜 Modrinth（按当前实例的 MC 版本 + Fabric 过滤）
  - 勾选模组 → `冲突检查并安装`：先跑分析（没适配版本、与已选模组不兼容都会拦下并给理由，
    再点一次「仍然安装」才会继续），确认后作为后台任务批量下载，进度在页面顶部
  - 依赖自动补齐（递归展开前置的前置，最多 4 层）
  - 整合包：一键安装，会自己建实例；光影：下载到当前实例的 `shaderpacks`
  - 装的去向写在卡片里：模组 → `fabric-<mc>-mods`，整合包 → 新实例，光影 → 当前实例
- **模组识别**：选 `.jar` / `.zip` / `.mrpack`，判断加载器与 MC 约束；**并读出它依赖哪些前置 mod**，
  去 Modrinth 反查后可以一键装缺失前置（查不到的会标出来）

### 浮窗（内置模式）

- 拖动：抓住头部拖；拖动位置记在浏览器本地（换分辨率会自动拉回屏幕内）
- 头部：状态点 + 状态（运行中 / 待机 / 离线）、收起（▴，双击头部也能收）
- 主体：实例下拉、启动 / 停止、`窗口`（打开独立窗口并收起自己）
- **进度条**：安装 / 启动任务进行时，显示「安装 1.20.1 · 进度 87% 下载资源索引」这样的实时行（走 SSE `/api/events`）
- 内存条：游戏常驻内存 / 上限（`-Xmx`）+ 系统空闲 + 已运行时长
- 登录：未登录时给「微软登录」，出设备码 + 复制，授权完自动变成「正版 · 名字」
- 日志：实例的 `logs/latest.log` 尾巴（14 行，ERROR/WARN 着色，可复制）
- `崩溃诊断`：直接出结论（命中规则给标题 + 建议）

---

## 四、本地偏好（localStorage，按 DSH 页面域保存）

| 键 | 值 | 说明 |
|---|---|---|
| `mcl.embedded` | `1` / `0` | 是否显示内置浮窗（独立开关） |
| `mcl.collapsed` | `1` / `0` | 浮窗是否收起成小条 |
| `mcl.pos` | `{x,y}` | 浮窗位置（容器坐标） |
| `mcl.player` | 字符串 | 离线玩家名 |
| `mcl.memory` | `2G` 等 | 默认内存 |
| `mcl.debug` | `1` | 打开调试（浮窗挂载会往服务器打信标，默认关） |

旧键 `mcl.mode` 仅用于迁移（以前选「独立窗口」等于不显示浮窗）。

---

## 五、Agent 接口（启动器 HTTP，`127.0.0.1:51730`）

Agent 不读 UI，统一走这套契约。写接口都是 JSON POST。

### 状态

```
GET /api/state
{
  gameDir, versions: [{ id, type, loader, java, mods, lastPlayed }],
  instance, memory: { totalGb, freeGb },
  auth: { loggedIn, name?, uuid?, expiresAt?, expired? },
  java: [{ major, raw, exe }],
  runtime: { instance, pid, memory, username, online, startedAt, uptimeSec,
             alive, rssMb, stopped, exitCode } | null,
  running, installing, installTarget
}
```

`running` 同时考虑 `jobs.launch` 和 `runtime.alive`（命令行启动的游戏也算）。

### 启动 / 停止

```
POST /api/launch  { version, username?, memory?, width?, height?, auth?: true }
POST /api/stop    // 也会按 .mcl-runtime.json 里的 pid 收掉命令行启动的游戏
```

### 日志尾巴

```
GET /api/logs?instance=<实例>&lines=40
{ instance, dir, source, lines: [...], size, mtime, truncated, running, updatedAt }
```

只读文件末尾 128KB（大日志不占内存），去掉控制字符、超长行截断到 400 字符。

### 诊断（Agent 最常用）

```
POST /api/diagnose  { instance }
{
  instance, source, size,
  findings: [{ id, title, evidence, suggestion }],
  excerpt: "…报错片段…",
  summary: "可直接喂给模型的多行摘要"
}
```

### 认证

```
GET  /api/auth/status                  { loggedIn, name?, uuid?, updatedAt? }
POST /api/auth/start                   { userCode, verificationUri, expiresIn, clientId }
POST /api/auth/logout
```

### 模组 / 整合包

```
POST /api/search             { query, type: "mod"|"modpack"|"shader", mcVersion?, index?, limit?, offset?, loader? }
POST /api/mods/analyze       { projectIds: [..], mcVersion, loader }
POST /api/mods/install-batch { projectIds: [..], mcVersion }   // 后台任务：自动补前置（递归）、并发 5
POST /api/mods/resolve       { ids: ["fabric-api", ...], loader?, mcVersion? }   // 本地 jar 前置 id → 项目
POST /api/mod/install        { projectId, mcVersion }
POST /api/pack/install       { projectId, mcVersion }          // 后台任务：自己建实例
POST /api/shader/install     { projectId, mcVersion, instance? }
POST /api/mod/inspect-path   { path }
POST /api/mod/inspect        { name, data }   // base64，小文件用；返回里带 depends（它依赖哪些 mod）
POST /api/mod/import         { path }
POST /api/pick-file
POST /api/install            { version, source? }
POST /api/open-window
```

### 事件流

```
GET /api/events   // SSE：{type:"hello"|"line"|"job"|"refresh"|"auth"}
```

浮窗用它做两件事：安装/启动进度（`job` 的 running + `line` 最新一行）、登录结果即时反馈。
跨源订阅靠 CORS 头（响应里带 `Access-Control-Allow-Origin: dsh-app://app`）。

### 端口发现

```
~/.mcl/server.json      { port, pid, url, startedAt }   // 启动器起来后写的
```

启动器默认从 51730 开始找空闲端口（最多往后 20 个），关掉时删掉这个文件。
客户端（插件界面）和 Host 半边都靠它 + 端口扫描找到服务，所以 51730 被占也不会失联。

### 调试

```
POST /api/client/mount?...   // 浮窗挂载信标，写入 tmp/client-mounts.log（客户端 mcl.debug=1 才发）
启动器环境变量 MCL_LOG_HTTP=1  → 每个请求记一行到 tmp/http-requests.log
```

---

## 六、约束与已知边界

- 只绑定 `127.0.0.1`；CORS 只放行 `http://127.0.0.1:*`、`http://localhost:*`、`dsh-app://app`，其他来源 403
- 端口默认 51730，被占用会自动往后找（51730~51749），实际端口写在 `~/.mcl/server.json`
- 离线与微软正版都支持；Fabric / Quilt / Forge / NeoForge 实例都支持
- 长任务（安装 / 导入 / 下载）异步执行，进度看 SSE
- 顺序提示：浮窗里点「打开独立窗口」会收起浮窗，想回来去设置页点「显示浮窗」

---

## 七、更新日志

### v0.4.0（2026-10-30）

- **模组库**：设置页新增 模组 / 整合包 / 光影 三个页签，搜 Modrinth → 勾选 → 冲突预检 → 批量安装
  - 装前分析：没适配版本、与已选模组 `incompatible` 都会列出来并拦一次，确认后才继续
  - 安装是后台任务，进度走 SSE（页面顶部进度行）
  - 模组装到 `fabric-<mc>-mods`，整合包自动建实例，光影进当前实例的 `shaderpacks`
- **前置依赖递归展开**：`installModsBatch` 原来只补一层前置，现在按层展开（最多 4 层、防环）
- **本地 jar 前置识别**：`inspectArchive` 现在解析 `fabric.mod.json` / `quilt.mod.json` / `mods.toml`
  里的依赖，返回 `depends`；新增 `/api/mods/resolve` 把 mod id 反查成 Modrinth 项目，
  界面可以一键装缺失前置（找不到的会标明）
- `/api/state` 的每个版本多一个 `mc` 字段（实例的真实 Minecraft 版本，PCL 包按 mod 名投票推断）
- 搜索结果的分类改成中文（`categoriesZh`，过滤掉 loader 名这类噪音）
- CLI 帮助补上 `mcl mods`（批量装模组）

### v0.3.0（2026-10-30）

- **浮窗与设置页显示任务进度**：接 `/api/events`，安装/启动时显示「安装 1.20.1 · 进度 87% …」实时行
- **动态端口**：启动器被占自动往后找端口并写 `~/.mcl/server.json`；Host 半边和界面都会自动发现并重连（含 SSE）
- 登录结果改为 SSE 即时反馈（轮询保留作兜底）
- 修复：`/api/events` 没带 CORS 头，跨源（`dsh-app://app`）订阅 SSE 会被浏览器拦掉
- 修复：`server.json` 只靠 `close` 清理，进程正常退出时残留 → 加 `process.on('exit')` 清理
  （被强杀时残留无害，客户端会用 HTTP 校验）

### v0.2.0（2026-10-30）

- **浮窗重写**：可拖动 / 收起、日志尾巴、内存条、登录状态 + 设备码、崩溃诊断、复制日志
- 新增 `GET /api/logs`（读末尾、清洗日志行）；`/api/state` 增加 `runtime` 与 `auth`
- 运行时快照 `.mcl-runtime.json`（真实 java pid / 内存上限 / 启动时间 / 退出码）
- `/api/stop` 也能收掉命令行启动的游戏；`/api/launch` 支持 `auth: true` 走正版身份
- 内置浮窗改成独立开关（`mcl.embedded`）；打开独立窗口自动收起浮窗
- 修复：DSH 桌面版页面来源 `dsh-app://app` 被 CORS 挡成 403（浮窗一直「离线」）
- 修复：浮窗坐标按宿主容器换算并做视口夹取（之前可能算到屏幕外）
- 修复：面板不透明化（`bg-layer-1`），日志区 `bg-base`，字号提到 11
- 修复：独立窗口从隐藏进程启动时会继承“最小化”，改用 `cmd /c start`
- 修复：头部拖拽的 `preventDefault` 会吞掉按钮点击
- **审查修复（同版本内）**：见下

#### 代码审查修复（同版本内）

- 设置页和浮窗原来各开一个轮询器（同一份 `/api/state` 拉两遍）→ 合并成共享 store，只留一个定时器；
  内容没变不触发重渲染；窗口在后台时自动降频到 14 秒
- 日志轮询从固定 2.6 秒改为按状态降频：运行中 2.5s、空闲 10s、后台 8s；内容没变不更新状态
- 复制按钮在非安全上下文（`dsh-app://`）里 `navigator.clipboard` 可能不可用 → 加 `execCommand` 兜底
- 登录过期仍会带 `--auth` 启动导致游戏卡在登录 → 现在标记「登录已过期」，退回离线并可重新登录
- 选中的实例被删掉后下拉框空白且启动报错 → 自动回退到第一个可用实例
- 浮窗隐藏（`mcl.embedded=0`）时仍然在跑保险丝定时器和轮询 → 现在全部停掉
- 拖动时 `pointermove` 每个事件都写一次位置 → 改成按帧合并（rAF）
- Host 半边：探测期间插件被卸载仍可能拉起服务（竞态）→ 加 disposed 标记；
  端口被别的服务占用时误判为「已就绪」→ 改成用 `GET /api/state` 验证身份
- 服务端：版本摘要缓存 20 秒（原来每次 `/api/state` 都重读每个版本 json + mods 目录），
  任务结束后自动失效；`/api/logs` 不再为算 `running` 起 `tasklist`；内存查询缓存 5s → 10s

### v0.1.0

- 首版：设置页启动 / 停止、版本安装、模组识别、简易浮窗
