# 崩溃修复助手（Crash Fix Assistant）

游戏异常退出后，启动器不再只给一句「退出码 1」，而是：

1. 自动收集 `crash-reports/`、`logs/latest.log`、`launcher-console.log`、`.mcl-runtime.json`、实例 `mods/`（含 jar 元数据）和本机 Java/内存信息；
2. 用规则引擎产出**结构化报告**：结论 + 命中原因（带证据行、置信度、人话解释）+ **可执行修复动作**；
3. 浏览器界面和 DSH 插件浮窗**自动弹出**报告，一键执行修复；
4. 报告同时落盘成 Markdown（`<实例>/crash-reports/mcl-fix-*.md`），可直接复制给 AI 继续分析。

## 覆盖的崩溃类型

| 原因 | 典型特征 | 给出的动作 |
| --- | --- | --- |
| 内存不足 | `OutOfMemoryError` / `Java heap space` | 把内存调到建议值（不超「可用内存 - 1G」）、关后台程序、确认 64 位 Java |
| 模组 Mixin 冲突 | `Mixin apply failed` / `InvalidMixinException` | 禁用最近添加的 mod、二分法排查 |
| 重复模组 | `DuplicateModsFoundException` / 同名多版本 | 禁用旧版本 jar（保留最新） |
| 缺前置 | `requires any version of ...` / `Missing dependencies` | 跳模组库搜索并安装前置 |
| Java 版本不匹配 | `UnsupportedClassVersionError` / `class file version` | 自动下载对应 Java、提示版本要求 |
| 加载器不匹配 | `Incompatible mods found` / 加载器版本约束 | 提示升级 Fabric/Quilt/Forge/NeoForge |
| 显卡 / OpenGL | `GLFW error` / `Pixel format not accelerated` | 更新驱动、降画质、关光影 |
| 模组文件损坏 | `InvalidModFileException` / `zip END header not found` | 禁用可疑 jar、重新下载 |
| 文件权限 | `AccessDeniedException` / 文件被占用 | 打开实例目录、加杀软白名单 |
| JVM 参数不兼容 | `Unrecognized VM option` | 清自定义 JVM 参数 |
| 原生崩溃 | 退出码 `0xC0000005` / `0xC00000FD` 等 | 按退出码给驱动/内存/运行库建议 |

## 自动触发

- **浏览器界面**：启动任务结束时若退出码非 0 / 有新崩溃报告，服务端自动分析并通过 SSE 推送
  `{type:'crash', report}`，界面自动弹出面板；正常退出推送 `{type:'crash', report:null}` 清空。
- **DSH 插件**：订阅同一条 SSE；浮窗出现红色「游戏崩溃」卡片，点开显示原因与修复按钮；
  设置页的「崩溃诊断」按钮也改为渲染结构化报告。
- **CLI**：`mcl launch` 崩溃时退出码非 0；`mcl diagnose <实例> [--write]` 输出结论 + 修复建议，
  加 `--write` 落盘 Markdown。

## 接口

| 接口 | 说明 |
| --- | --- |
| `POST /api/crashfix` `{instance}` | 生成报告 `{report}`（无崩溃也会返回合法报告） |
| `POST /api/crashfix/apply` `{instance, kind, payload}` | 执行修复：`disable-mod` / `enable-mod` / `remove-mod` / `open-report` / `open-log` / `install-java`；其余动作返回 `needsClient:true` 由界面处理 |
| `GET /api/crash/last` | 最近一次报告（自动或手动） |
| `POST /api/mods/toggle` `{instance, jar, enable}` | 启用 / 禁用单个模组 |
| `POST /api/reveal` `{path}` | 在资源管理器打开（限定在游戏目录/`~/.mcl` 内） |

`/api/state` 增加 `lastCrash` 摘要；SSE 增加 `crash` 事件。

## 报告结构与动作

```json
{
  "instance": "fabric-1.20.1-mods",
  "mc": "1.20.1", "loader": "Fabric",
  "crashed": true, "exitCode": 1,
  "summary": "内存不足（Java 堆耗尽）", "confidence": "high",
  "memory": { "xmx": "2G", "totalGb": 23.3, "freeGb": 11.2, "suggestion": "6G" },
  "java": { "required": 17, "major": 17, "available": [...] },
  "causes": [
    { "id": "oom", "title": "内存不足（Java 堆耗尽）", "severity": "fatal", "confidence": 0.95,
      "explanation": "…", "evidence": ["java.lang.OutOfMemoryError: Java heap space"],
      "fixes": [{ "kind": "set-memory", "label": "把内存调到 6G 后重启", "payload": { "memory": "6G" } }] }
  ],
  "fixes": [ /* 跨原因去重后的动作 */ ],
  "reportPath": "…/crash-reports/mcl-fix-20261031-173000.md",
  "text": "# MCL 崩溃修复报告\n…"
}
```

动作种类：`set-memory` `disable-mod` `enable-mod` `remove-mod` `open-report` `open-log`
`install-java` `install-mod` `retry-launch` `update-loader` `open-settings` `advisory`。

## 安全

- 所有文件动作限定在该实例目录内（mods/、crash-reports/），拒绝路径穿越；
- `remove-mod` 不硬删，移动到 `mods-backup-<时间>/`，可恢复；
- 打开外部路径前校验必须在游戏目录或 `~/.mcl` 内。

## 测试

```bash
node test-fixtures/run-crashfix-tests.mjs   # 规则/报告/文件动作离线单测（12 项）
node test-fixtures/run-ui-e2e.mjs           # 真服务 + 无头 Edge：手动面板、SSE 自动弹窗、一键修复
```
