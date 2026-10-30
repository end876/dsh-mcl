const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  gray: wrap(90),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  bold: wrap(1),
  dim: wrap(2),
};

export const say = (s = '') => process.stdout.write(`${s}\n`);
export const step = (s) => say(`${c.cyan('›')} ${s}`);
export const info = (s) => say(`  ${s}`);
export const ok = (s) => say(`${c.green('✓')} ${s}`);
export const warn = (s) => process.stderr.write(`${c.yellow('!')} ${s}\n`);
export const fail = (s) => process.stderr.write(`${c.red('✗')} ${s}\n`);

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const CLEAR = tty ? '\r\x1b[2K' : '\n';

/** 单行进度条；非 TTY 时退化为按 5 秒打点 */
export class Progress {
  constructor(label = '', total = 0, { count = false } = {}) {
    this.label = label;
    this.total = total;
    this.done = 0;
    this.count = count;
    this.started = Date.now();
    this.lastRender = 0;
    this.rendered = false;
  }

  add(n = 0) {
    this.done += n;
    this.render();
  }

  setTotal(total) {
    this.total = total;
  }

  render(force = false) {
    const now = Date.now();
    if (!force) {
      if (!tty && now - this.lastRender < 5000) return;
      if (tty && now - this.lastRender < 100) return;
    }
    this.lastRender = now;
    const pct = this.total > 0 ? Math.min(100, (this.done / this.total) * 100) : 0;
    const width = 24;
    const filled = Math.round((pct / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const secs = ((now - this.started) / 1000).toFixed(0);
    const amount = this.count
      ? `${this.done} / ${this.total} 个`
      : `${fmtBytes(this.done)} / ${fmtBytes(this.total)}`;
    const line = `  ${bar} ${pct.toFixed(1).padStart(5)}%  ${amount}  ${secs}s  ${this.label}`;
    if (tty) process.stdout.write(CLEAR + line);
    else say(line);
    this.rendered = true;
  }

  finish(summary) {
    if (tty && this.rendered) process.stdout.write(CLEAR);
    if (summary) ok(summary);
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
