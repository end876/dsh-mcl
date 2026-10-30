import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { ensureDir } from './paths.mjs';
import { sleep } from './log.mjs';

export const USER_AGENT = 'mc-launcher/0.6.0 (Node)';

const DEFAULT_TIMEOUT = 60_000;
// Node 的 fetch（undici）连接超时写死 10 秒，慢网络下 Cloudflare 握手经常超过 10 秒，
// 结果就是频繁 UERR_CONNECT_TIMEOUT。这里改用 node:https，自己控制超时。
const CONNECT_TIMEOUT = 120_000;

function httpError(url, status) {
  const retriable = status === 408 || status === 429 || status >= 500;
  return Object.assign(new Error(`HTTP ${status} ${url}`), { retriable });
}

/**
 * GET（自动跟随重定向），返回未消费的 IncomingMessage。
 * timeout 是「多久没数据」，不是总时长；慢速大文件靠它保活。
 */
function requestStream(url, { headers = {}, timeout = DEFAULT_TIMEOUT, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const scheme = parsed.protocol === 'https:' ? https : http;
    const req = scheme.request(
      parsed,
      {
        method: 'GET',
        agent: false, // 每次新连接：避免复用被 Cloudflare 掐掉的 keep-alive 套接字
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0) {
          res.resume();
          try {
            const next = new URL(res.headers.location, url).toString();
            resolve(requestStream(next, { headers, timeout, redirects: redirects - 1 }));
          } catch (error) {
            reject(error);
          }
          return;
        }
        resolve(res);
      },
    );

    const connectTimer = setTimeout(() => {
      req.destroy(Object.assign(new Error(`连接超时：${url}`), { retriable: true }));
    }, CONNECT_TIMEOUT);
    req.on('socket', (socket) => {
      socket.once('connect', () => clearTimeout(connectTimer));
    });
    req.on('error', (error) => {
      clearTimeout(connectTimer);
      reject(error);
    });
    req.setTimeout(timeout, () => {
      req.destroy(Object.assign(new Error(`请求超时：${url}`), { retriable: true }));
    });
    req.end();
  });
}

/** 带重试与超时的 GET，返回 Buffer（小的 json / 文本用） */
export async function fetchBuffer(url, { retries = 3, timeout = DEFAULT_TIMEOUT } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await requestStream(url, { timeout });
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        throw httpError(url, status);
      }
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      return Buffer.concat(chunks);
    } catch (error) {
      lastError = error;
      if (lastError?.retriable === false) break; // 404/403 这类别重试了
      if (attempt === retries) break;
      await sleep(400 * (attempt + 1));
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

/**
 * 流式下载到 .part，带进度回调；返回临时文件路径。
 * 支持断点续传：网络很慢时 watchdog 会掐掉连接重试，续传能保住已下载的部分
 * （否则每次重试都从头下，几百 KB 的进度白费，慢网络下永远下不完）。
 */
async function streamToPart(url, dest, { onBytes, onTotal } = {}) {
  ensureDir(path.dirname(dest));
  const part = `${dest}.part`;
  let start = 0;
  try {
    start = fs.statSync(part).size;
  } catch {
    start = 0;
  }

  const headers = {};
  if (start > 0) headers.Range = `bytes=${start}-`;
  // 90 秒「多久没数据」超时：连接建立了却不动就掐掉重试（续传会接着之前的进度）
  const res = await requestStream(url, { headers, timeout: 90_000 });
  const status = res.statusCode ?? 0;
  if (status === 416) {
    // .part 已经比服务端文件还大（或对不上），丢掉重来
    res.resume();
    fs.rmSync(part, { force: true });
    throw Object.assign(new Error(`续传范围无效，重新下载：${url}`), { retriable: true });
  }
  if (status < 200 || status >= 300) {
    res.resume();
    throw httpError(url, status);
  }

  const resumed = start > 0 && status === 206;
  if (!resumed) start = 0; // 服务端不支持 Range：从头写
  const total = Number(res.headers['content-length']) || 0;
  if (total > 0) onTotal?.(total + start);
  if (onBytes) res.on('data', (chunk) => onBytes(chunk.length));

  await pipeline(res, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
  return part;
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
