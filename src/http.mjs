import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ensureDir } from './paths.mjs';
import { sleep } from './log.mjs';

export const USER_AGENT = 'mc-launcher/0.1.0 (Node)';

const DEFAULT_TIMEOUT = 60_000;

function httpError(url, status) {
  const retriable = status === 408 || status === 429 || status >= 500;
  return Object.assign(new Error(`HTTP ${status} ${url}`), { retriable });
}

/** 带重试与超时的 GET，返回 Buffer（小的 json / 文本用） */
export async function fetchBuffer(url, { retries = 3, timeout = DEFAULT_TIMEOUT } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!res.ok) throw httpError(url, res.status);
      return Buffer.from(await res.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function fetchJson(url, options) {
  const buf = await fetchBuffer(url, options);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error(`返回内容不是合法 JSON：${url}`);
  }
}

export function sha1Hex(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

export function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

/** 已存在且校验通过就跳过 */
export async function verifyLocal(file, sha1, size) {
  if (!sha1) return false;
  if (fileSize(file) < 0) return false;
  if (size != null && fileSize(file) !== size) return false;
  return (await sha1File(file)) === sha1;
}

/** 流式下载到 .part，带进度回调；返回临时文件路径 */
async function streamToPart(url, dest, { onBytes, onTotal } = {}) {
  const controller = new AbortController();
  // 不是“总时长”超时，而是“多久没数据”超时：连接建立了却不动，90 秒就掐掉重试
  let timer = setTimeout(() => controller.abort(), 90_000);
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), 90_000);
  };
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw httpError(url, res.status);

    const total = Number(res.headers.get('content-length')) || 0;
    if (total > 0) onTotal?.(total);

    ensureDir(path.dirname(dest));
    const part = `${dest}.part`;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        touch();
        onBytes?.(chunk.length);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part));
    return part;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 下载到本地并校验 SHA1（流式，不占内存）。
 * @returns {'ok'|'skip'}
 */
export async function download({
  url,
  dest,
  sha1,
  size,
  retries = 3,
  force = false,
  onBytes,
  onTotal,
}) {
  if (!force && (await verifyLocal(dest, sha1, size))) {
    const existing = fileSize(dest);
    onTotal?.(existing > 0 ? existing : 0);
    onBytes?.(existing > 0 ? existing : 0);
    return 'skip';
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const part = await streamToPart(url, dest, { onBytes, onTotal });
      if (sha1) {
        const actual = await sha1File(part);
        if (actual !== sha1) {
          fs.rmSync(part, { force: true });
          throw new Error(`SHA1 不匹配：${url}`);
        }
      }
      fs.renameSync(part, dest);
      return 'ok';
    } catch (error) {
      lastError = error;
      if (lastError?.retriable === false) break;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
}

/** 固定并发跑一批任务 */
export async function runPool(items, worker, concurrency = 8) {
  const queue = items.slice();
  const results = new Array(queue.length);
  let cursor = 0;
  let failure = null;

  async function runner() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= queue.length || failure) return;
      try {
        results[index] = await worker(queue[index], index);
      } catch (error) {
        failure = failure || error;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, runner),
  );
  if (failure) throw failure;
  return results;
}
