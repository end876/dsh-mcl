# TODO

记录已知问题与后续计划。✅ 表示已修复，⬜ 表示待办。

## ✅ 已修复

- [x] Fabric 安装收尾卡死（下载无数据看门狗，90s 无数据重试）
- [x] 实例 id 与目录不一致导致模组装进游戏读不到的目录（`ensureFabricInstance` / `ensureInstance`）
- [x] 按配置隔离实例（`fabric-<mc>-<label>`）
- [x] JVM 参数按 Java 版本分档（`SoftMaxHeapSize` 仅 JDK 12+，G1 细调仅 9+）
- [x] 版本目录名 ≠ json id 时无法启动（`findVersionDir` 扫描）
- [x] 版本列表不显示目录名异常的实例（`installedVersions` 兼容）
- [x] 光影搜索误带 loader 筛选
- [x] 版本推断把模组版本号当 MC 版本（minor 限定 7~30）
- [x] Java 探测缓存 60s（`/api/state` 102ms → 6ms）
- [x] CORS 白名单 + 非白名单 403
- [x] ZIP64 支持
- [x] 批量下载并发 5
- [x] 导入覆盖前备份（上限 2000 文件 → `.import-backup/`）
- [x] 内存滑条 + 安全上限（可用内存 - 1G）+ 确定按钮
- [x] **Java 17+ 起不来的致命 bug**：`G1NewSizePercent` / `G1MaxNewSizePercent` 是实验参数，
      不加 `-XX:+UnlockExperimentalVMOptions` 时 JVM 直接 "Could not create the Java Virtual Machine"
- [x] 版本列表的 Java 版本按继承链解析（Fabric 的 json 不写 `javaVersion`，之前一律显示 8）
- [x] `/api/logs`：日志尾巴接口（读文件末尾 128KB、清洗控制字符与超长行）
- [x] 运行时快照 `.mcl-runtime.json`（真实 java pid / 内存上限 / 启动时间 / 退出码）
- [x] 状态接口带 `runtime`（存活、常驻内存、运行时长、退出码），`/api/stop` 也能收掉命令行启动的 java
- [x] **DSH 桌面版页面来源 `dsh-app://app` 被 CORS 白名单挡成 403**：浮窗一直显示"离线"、拿不到版本列表
- [x] **浮窗位置算到屏幕外**：`position: fixed` 的原点是宿主容器（可能带 transform），
      改成用「真实 rect − 写入的 left/top」反推容器偏移，一律按屏幕坐标摆放；外加每 2 秒保险丝
- [x] **浮窗太透明**：面板底 `bg-overlay` → `bg-layer-1`，日志区 `bg-base`，字号 10.5 → 11
- [x] **内置浮窗独立开关**（`mcl.embedded`）：设置页按钮单独控制；点「打开独立窗口」自动收起内置浮窗
- [x] **独立窗口"开了但最小化"**：从隐藏窗口（DSH 宿主 / 启动.bat）直接 spawn 浏览器会继承隐藏状态，
      改用 `cmd /c start`（ShellExecute）起窗口，显示状态由系统给
- [x] 头部拖拽会吞掉按钮点击（`preventDefault` 把 click 也吃了）：按钮区域不参与拖拽

### 插件代码审查修复（2026-10-30）

- [x] 设置页 + 浮窗各开一个 `/api/state` 轮询器 → 合并成共享 store（单定时器、内容不变不重渲染、后台降频）
- [x] 日志轮询固定 2.6s → 按状态降频（运行 2.5s / 空闲 10s / 后台 8s），内容没变不更新
- [x] 复制按钮在 `dsh-app://` 非安全上下文可能不可用 → `execCommand` 兜底
- [x] 登录过期仍带 `--auth` 启动（游戏卡在登录）→ 标记过期、退回离线、可重新登录
- [x] 选中实例被删后下拉空白 → 自动回退第一个可用实例
- [x] 浮窗隐藏时仍在跑保险丝/轮询 → 全部停掉
- [x] 拖动 `pointermove` 每次写位置 → 按帧合并（rAF）
- [x] Host 半边竞态：探测中被卸载仍会拉起服务；端口被别的服务占用被误判为就绪 → disposed 标记 + `GET /api/state` 验证
- [x] 服务端：版本摘要缓存 20s（任务结束失效）；`/api/logs` 不再起 `tasklist`；内存缓存 5s → 10s

### 0.3.0（2026-10-30）

- [x] **浮窗 / 设置页显示安装·启动进度**：接 `/api/events`，显示「安装 1.20.1 · 进度 87% …」实时行
- [x] **动态端口 + 本地发现**：51730 被占自动往后找（最多 20 个），实际端口写 `~/.mcl/server.json`；
      插件 Host 半边与界面都会自动发现并重连（含 SSE），端口被占也能自愈
- [x] 修 `/api/events` 缺 CORS 头：跨源页面（`dsh-app://app`）订阅 SSE 会被浏览器拦掉
- [x] `server.json` 增加 `process.on('exit')` 清理（被强杀时残留无害，客户端以 HTTP 校验为准）
- [x] 登录结果改 SSE 即时反馈（轮询保留作兜底）

### 0.4.0（2026-10-30）

- [x] **DSH 插件加模组库**：Modrinth 搜索（模组/整合包/光影）、冲突预检、批量安装、进度走 SSE
- [x] **前置依赖递归展开**：`installModsBatch` 原来只补一层，改成按层展开（最多 4 层、防环）
- [x] **本地 jar 前置识别**：`inspectArchive` 解析 fabric.mod.json / quilt.mod.json / mods.toml 的依赖，
      新增 `/api/mods/resolve` 把 mod id 反查成项目；界面可一键装缺失前置
- [x] `/api/state` 的版本摘要加 `mc`（实例真实 MC 版本；PCL 包按 mod 名投票推断）
- [x] 搜索结果加 `categoriesZh`（中文分类，顺带过滤 loader 名噪音）
- [x] CLI 帮助补上 `mcl mods`（批量装模组）

### 1.0.2（2026-10-31）

- [x] 修 PID 复用导致的假「运行中」（stopped 优先 + Windows 进程身份校验）
- [x] `/api/stop` 不再误杀被复用的 PID；返回真实 ok
- [x] 界面显示「上一局已退出（退出码）」

### 1.0.1（2026-10-31）

- [x] 本地整合包装成实例，实例名 = zip 文件名
- [x] 大文件（>8MB）识别走流式上传
- [ ] CurseForge 清单型包的模组自动下载（需要 API key）

### 1.0.0（2026-10-31）

- [x] 界面正式版：三栏分页（启动/版本/模组库/外观）+ 三套主题 + 自定义背景
- [x] 正版登录显示修复（浏览器版）
- [x] 插件健壮性/性能收尾
- [x] 文档：`docs/custom-background.md`
- [ ] （可选）免装 Node 的分发包：仅当非 DSH 用户有需求再做（插件走 DSH 自带 Node，不受影响）

### 0.7.0（2026-10-31）

- [x] 插件健壮性/性能：api 15s 超时、端口并行探测 + 并发去重、轮询变化才通知、SSE 日志 rAF 合并
- [x] 插件搜索竞态：切页签时旧请求结果丢弃（插件与浏览器版都修）
- [x] 插件大文件识别拦截（>24MB 提示改用路径识别）
- [x] Host 半边：重启额度稳定 60s 后重置、端口并行探测

- [x] 修浏览器版「正版登录后界面不显示账号」：refreshAuth 未被调用 + SSE 缺 auth 分支
- [x] 浏览器版加「退出登录」；启动提示区分正版/离线；已登录按钮绿色态

- [x] 新版界面：三栏布局（侧栏 / 主区 / 日志栏）
- [x] 三套主题 A 深海玻璃 / B 像素方块 / C 极简白（默认 C）
- [x] 自定义背景：本地上传 + 4 套预设 + 模糊/压暗/玻璃/位置滑杆
- [x] 外观配置与背景图存 `~/.mcl/ui/`（浏览器版与 DSH 插件共用）
- [ ] DSH 插件（设置页 + 浮窗）套用同一套主题

### 0.6.2（2026-10-31）

- [x] 浏览器版模组库无限下拉：滚动监听挂错容器（.drawer → #drawer-list）已修
- [x] 首屏未撑满时自动续拉；翻页按当前分类过滤

### 0.6.1（2026-10-31）

- [x] 模组库无限下拉（IntersectionObserver，滚到底自动加载；每页 20、按 id 去重）
- [x] 切页签/换实例自动重置并搜第一页；总数对不上时不再空转

### 0.6.0（2026-10-30）

- [x] **Quilt 支持**：`src/quilt.mjs`（maven 元数据挑稳定版 → 并发探测 profile json → 下载依赖）
      - 列表走 maven 元数据 + profile 探测，避开官方 ~900KB 的 per-MC 列表；结果缓存 3 天
      - 实例 `quilt-loader-<ver>-<mc>`；CLI `mcl quilt`；`/api/loader/list|install` 支持 quilt
      - 模组/整合包：`--loader quilt`、mrpack `deps["quilt-loader"]`、插件下拉与模组库
      - 注意：`maven.quiltmc.org` 没有国内镜像，首次安装可能很慢（文件走直连）

### 0.5.2（2026-10-30）

外部评测（v0.4.0 代码审查报告）修复项：

- [x] **高危**：`/api/logs`、`/api/diagnose` 的 `instance` 路径穿越 → 白名单 + `versions/` 包含校验
- [x] **高危**：畸形请求行使进程退出 → URL 解析进 try、handler `.catch`、`clientError`、`sendJson` 防 headersSent
- [x] **高危**：整合包解压路径穿越 → `safeJoin()`（import + mrpack files/overrides）
- [x] 版本描述 json 最后写（tmp+rename）；损坏 json 不再让 `/api/state` 500；版本扫描排除 `.mcl-runtime.json`
- [x] Fabric 依赖 sha1/size 字段修正（`lib.sha1` / `lib.size`）
- [x] 诊断取 crash-reports/logs 全局最新；`latest.log` 读末尾 256KB
- [x] 登录：按 `expires_in` 轮询、设备码申请失败立刻报错、并发互斥；新增 refresh_token 自动续期
- [x] `MCL_CLIENT_ID` 环境变量 + 插件提示；Host 半边 `.catch` / stderr / 退避重启 / 自身路径兜底
- [x] 插件 peerDependencies + engines；隐藏浮窗整块卸载；auth SSE 事件带时间戳
- [x] `mcl --help`；fetchBuffer 不重试 4xx；mods.toml 依赖类型过滤；inspect-path 不再回显目录

剩余（未做）：

- [ ] 凭据仍是 `~/.mcl/auth.json` 明文（0600）；要不要加密/系统凭据库另议
- [ ] 评测里的低危项：版本目录解析收口、安装状态可恢复、长任务取消等（见 P1/P2）

### 0.5.1（2026-10-30）

- [x] **模组库装错实例**：`/api/mods/install-batch` 把请求里的 `loader` 丢了，选了 Forge/NeoForge 实例
      也会按 Fabric 装到别的实例；现在 `loader` + `instance` 都透传，选哪个实例就装哪个
- [x] 修「安装这 N 个前置」按钮报错（`SettingsSection` 里误用了不存在的 `loader` 变量，应为 `targetLoader`）
- [x] 修启动器版本号残留 0.4.0（`LAUNCHER_VERSION` 与 package.json 不同步，`--dry-run` 可见）
- [x] 修 `loaderOfVersion()` 把 NeoForge 判成 Forge（两者 mainClass 都是 BootstrapLauncher）
- [x] CLI `mcl mod` / `mcl mods` 新增 `--instance <实例>`

### 调试开关

- `MCL_LOG_HTTP=1 node bin/mcl.mjs gui` → 每个请求记一行到 `tmp/http-requests.log`（状态码 / 来源 / 耗时）
- 浮窗每次挂载往 `tmp/client-mounts.log` 打一条信标（位置、尺寸、实例、有没有拿到状态）

## ⬜ 待办（按优先级）

### P0
- [ ] **zip 流式读取**：`zip.mjs` 目前整文件读入内存（1.4GB 包峰值 1.4GB）。
      改为 fd + `readSync` 按需读：先读中央目录，再按偏移读条目；API 变异步，
      调用方（install / import / mods / mrpack）跟改。

### P1
- [ ] **版本目录解析收口**：`findVersionDir` / `readLocalVersionJson` / `installedVersions`
      三处逻辑统一成一个 `resolveVersionDir(id)`，避免再次出现"修一处漏一处"。
- [ ] **已知 MC 版本集合**：版本推断只从 Piston Meta 拉取（或内置）的合法版本集合里投票；
      票数 < 阈值（如 3）时提示"无法自动识别，请手动选择"，不硬猜。
- [x] **动态端口 + 本地发现**：启动时选空闲端口，写入 pid/端口文件；
      DSH 插件读文件发现服务地址，端口被占也能自愈。（0.3.0 完成：`~/.mcl/server.json` + 端口扫描）

### P2
- [ ] 启动前完整性校验：版本 json / natives / libraries 缺失时先补再启动。
- [ ] JVM 参数表化：用「Java 版本 → 参数集」映射替代 if 链；
      可选加 `java -XX:+PrintFlagsFinal -version` 探测并缓存（每 java 路径一次）。
      ⚠️ `--add-opens` 不是通用需求，做成可选开关而非默认。
- [ ] Modrinth 限流：元数据请求单独限流（并发上限），退避改为指数退避。
- [ ] 抽屉渲染：后续页已改追加，但 `analyzeInBackground` 仍会整体重渲染，可改按行更新。
- [ ] 批量下载进度合并显示（目前每个文件一行 `step`）。
- [ ] `dist/` 是旧快照（比 src 少了浮窗/日志/认证改动），发版前要重新生成。
      桌面存档只放压缩包，命名 `MCL启动器-v<主>.<次>.zip`：v0.1 / v0.2 / v0.3 / v0.4 都是完整包
      （`mc-launcher\` 启动器源码 + `dsh-plugin\` 插件 + 使用说明/操作文档/启动.bat）。
- [ ] 浏览器版 UI 也接上 `/api/logs` 状态面板（现在只有 DSH 浮窗有）。

### P3
- [ ] Forge / NeoForge 支持（当前仅 Fabric）。
- [ ] 发行打包（免装 Node 的单文件/安装器）。
- [x] DSH 插件：接上模组库、光影，端口改为动态发现。（0.4.0 全部完成）
- [ ] 模组库可以再补：图标显示、按下载/更新排序、已装标记（现在只按相关度、不显示已装）
- [ ] 详情页翻译请求可取消；翻译接口限流处理。
- [ ] 重复模组检测目前是文件名级，存在误报。
- [ ] `--detach` 模式仍会创建 `launcher-console.log` 流但不写入。
- [ ] 光影安装的目标实例选择（现在插件里装光影会进当前选中实例）。

## 设计备注

- 源抽象层：`mojang` / `bmclapi`，`auto` 并行探测取先应答者，另一个作回退。
- BMCLAPI 会 403 浏览器 UA，必须带启动器 UA。
- `maven.fabricmc.net` 国内常超时，Fabric 依赖走 BMCLAPI maven 镜像。
- PCL 合并后的版本 json 没有 `inheritsFrom`，MC 版本靠 mod 文件名投票推断。
- 「解压即玩」包是完整 `.minecraft`，导入采用合并 + 备份，不是隔离目录。
