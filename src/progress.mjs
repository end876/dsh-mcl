/**
 * 从 CLI 输出行里解析任务进度。
 *
 * 只有安装任务（下载 / 解压 / 复制）的输出里百分比才是进度；
 * 启动任务的输出会混进游戏日志，例如：
 *   [17:15:53] [Render thread/INFO]: 准备生成区域中: 31%
 * 这种百分数是游戏在加载区块，不能拿来做启动进度条。
 *
 * @param {'install'|'launch'} kind
 * @param {string} line
 * @returns {{percent:number,text:string}|null}
 */
export function parseJobProgress(kind, line) {
  if (kind !== 'install') return null;
  const match = String(line).match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const percent = Math.max(0, Math.min(100, Math.round(Number(match[1]))));
  if (!Number.isFinite(percent)) return null;
  const text = String(line)
    .replace(/[█░▓▒]/g, ' ')
    .replace(/^\s*\d+(?:\.\d+)?%\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return { percent, text };
}
