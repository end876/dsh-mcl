import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ensureDir } from './paths.mjs';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 极简 ZIP 读取器：只支持 stored / deflate，够读 jar、jre zip、整合包。
 * 零依赖，避免引入 unzip 二进制。
 */
export function openZip(file) {
  return openZipBuffer(fs.readFileSync(file), file);
}

/** 从内存里的 zip 数据打开 */
export function openZipBuffer(buf, label = 'memory.zip') {
  let eocd = findEOCD(buf);
  if (eocd < 0) throw new Error(`不是有效的 zip：${label}`);

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64：EOCD 里的字段是 0xFFFF/0xFFFFFFFF 时，去前面的 EOCD64 定位器里取真值
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== 0x07064b50) {
      throw new Error(`ZIP64 结构缺失：${label}`);
    }
    const eocd64 = Number(buf.readBigUInt64LE(locator + 8));
    if (eocd64 < 0 || eocd64 + 56 > buf.length || buf.readUInt32LE(eocd64) !== 0x06064b50) {
      throw new Error(`ZIP64 中央目录损坏：${label}`);
    }
    count = Number(buf.readBigUInt64LE(eocd64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`中央目录损坏：${label}`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const external = buf.readUInt32LE(p + 38);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const unixMode = (external >>> 16) & 0xffff;
    const isDir =
      name.endsWith('/') || (unixMode & 0xf000) === 0x4000 || (external & 0x10) !== 0;
    entries.push({ name, method, compSize, size, localOffset, isDir });
    p += 46 + nameLen + extraLen + commentLen;
  }

  function read(entry) {
    const local = entry.localOffset;
    if (buf.readUInt32LE(local) !== LOC_SIG) throw new Error(`本地头损坏：${entry.name}`);
    const nameLen = buf.readUInt16LE(local + 26);
    const extraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + entry.compSize);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`);
  }

  return { file: label, entries, read };
}

export function readZipEntryText(file, entryName) {
  const zip = openZip(file);
  const entry = zip.entries.find((e) => e.name === entryName);
  if (!entry) return null;
  return zip.read(entry).toString('utf8');
}

/**
 * 解压到目录，保留相对路径。
 * @param {(name: string) => boolean} filter
 */
export function extractZip(file, outDir, filter = () => true) {
  const zip = openZip(file);
  let written = 0;
  for (const entry of zip.entries) {
    if (!filter(entry.name)) continue;
    const target = path.join(outDir, entry.name);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(outDir))) continue; // 防目录穿越
    if (entry.isDir) {
      ensureDir(resolved);
      continue;
    }
    ensureDir(path.dirname(resolved));
    fs.writeFileSync(resolved, zip.read(entry));
    written += 1;
  }
  return written;
}

/** 列出 zip 内所有文件（不含目录） */
export function listZip(file) {
  return openZip(file)
    .entries.filter((e) => !e.isDir)
    .map((e) => ({ name: e.name, size: e.size }));
}
