import fs from 'node:fs';
import path from 'node:path';
import { findVersionDir } from './install.mjs';

/**
 * 崩溃归因规则表。每条规则给出 title / 关键字 / 建议。
 * 这不是"真 AI"，是把最常见的崩溃特征结构化，供人看、也供 DSH 里的模型进一步分析。
 */
const RULES = [
  {
    id: 'java-version',
    pattern: /UnsupportedClassVersionError|class file version (\d+)|requires Java (\d+)/i,
    title: 'Java 版本不匹配',
    suggestion: '这个游戏版本需要的是清单里声明的 Java 版本（1.16.5 及以下 Java 8，1.17~1.20.4 Java 17，1.20.5+ Java 21）。',
  },
  {
    id: 'oom',
    pattern: /OutOfMemoryError|Java heap space|insufficient memory/i,
    title: '内存不足',
    suggestion: '在启动面板把内存调大（340 mod 的整合包建议 6~8G），但不要超过「可用内存 - 1G」。',
  },
  {
    id: 'duplicate-mod',
    pattern: /duplicate mods|multiple versions of.*found|DuplicateModsFoundException/i,
    title: '存在重复模组',
    suggestion: '运行 `mcl check <实例名>` 找出同名不同版本的 mod，删掉旧版本。',
  },
  {
    id: 'missing-dep',
    pattern: /Missing or unsupported mandatory dependencies|requires .* which is missing|Incompatible mod set/i,
    title: '缺少前置模组',
    suggestion: 'Modrinth 详情页里能看到前置依赖，批量安装时会自动补齐；如果是手动放的包，需要补装。',
  },
  {
    id: 'mixin',
    pattern: /Mixin apply failed|mixin.*failed to apply|MixinTransformerError/i,
    title: '模组 Mixin 冲突',
    suggestion: '通常是两个模组改同一个类。用二分法停用一半模组缩小范围，或检查有没有重复功能的模组（如两个优化 mod）。',
  },
  {
    id: 'gl-error',
    pattern: /GLFW error|Failed to create window|OpenGL.*(error|unsupported)|Pixel format not accelerated/i,
    title: '显卡 / OpenGL 初始化失败',
    suggestion: '检查显卡驱动；集成显卡/远程桌面环境可能无法创建 OpenGL 上下文。',
  },
  {
    id: 'access-denied',
    pattern: /AccessDeniedException|拒绝访问|Permission denied/i,
    title: '文件权限问题',
    suggestion: '杀毒软件或系统权限拦截了写入。把启动器目录加入白名单，或换个非系统盘路径。',
  },
  {
    id: 'loader-mismatch',
    pattern: /Incompatible mods found|mod .* requires fabric.* but/i,
    title: '加载器版本不匹配',
    suggestion: '模组要求的 Fabric/Forge 版本比当前实例高，需要升级加载器版本。',
  },
];

function newestFile(dir) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.txt') || name.endsWith('.log'))
      .map((name) => ({ name, stat: fs.statSync(path.join(dir, name)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (files.length === 0) return null;
    return path.join(dir, files[0].name);
  } catch {
    return null;
  }
}

/** 分析某个实例最近一次崩溃 */
export function diagnose(instanceId) {
  const dir = findVersionDir(instanceId);
  const candidates = [
    path.join(dir, 'crash-reports'),
    path.join(dir, 'logs'),
  ];

  let source = null;
  for (const candidate of candidates) {
    const file = newestFile(candidate);
    if (file) {
      source = file;
      break;
    }
  }
  if (!source) {
    return { instance: instanceId, source: null, findings: [], excerpt: '', message: '没有找到崩溃日志（游戏可能还没运行过）' };
  }

  const text = fs.readFileSync(source, 'utf8').slice(0, 200_000);
  const findings = [];
  for (const rule of RULES) {
    const match = text.match(rule.pattern);
    if (match) {
      findings.push({
        id: rule.id,
        title: rule.title,
        evidence: match[0].slice(0, 120),
        suggestion: rule.suggestion,
      });
    }
  }

  const errorLines = text
    .split(/\r?\n/)
    .filter((line) => /ERROR|Exception|Caused by|FATAL/.test(line))
    .slice(0, 12);

  return {
    instance: instanceId,
    source,
    size: fs.statSync(source).size,
    findings,
    excerpt: errorLines.join('\n'),
    message: findings.length > 0 ? null : '没命中已知规则，把下面的报错片段交给 AI 进一步分析',
  };
}

/** 供 DSH / 外部 agent 使用的紧凑摘要 */
export function diagnoseSummary(instanceId) {
  const result = diagnose(instanceId);
  const lines = [`实例：${instanceId}`];
  if (result.source) lines.push(`日志：${result.source}`);
  if (result.message) lines.push(`结论：${result.message}`);
  for (const finding of result.findings) {
    lines.push(`- [${finding.id}] ${finding.title}｜证据：${finding.evidence}｜建议：${finding.suggestion}`);
  }
  if (result.excerpt) lines.push(`\n报错片段：\n${result.excerpt}`);
  return { ...result, summary: lines.join('\n') };
}
