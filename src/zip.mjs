import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ensureDir, safeJoin } from './paths.mjs';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const EOCD64_SIG = 0x06064b50;
const LOC64_SIG = 0x07064b50;

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** 解析中央目录（内存里的一段 buffer） */
function parseCentralDirectory(buf, cdOffset, count, label) {
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`中央目录损坏：${label}`);
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
  return entries;
}

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const got = fs.readSync(fd, buf, 0, length, offset);
  return got === length ? buf : buf.subarray(0, got);
}

/**
 * 文件版 ZIP 读取器：只把「尾部 EOCD + 中央目录」读进内存，条目按需从磁盘读。
 * 1GB+ 的整合包不会再把整个文件读进 Node 内存。
 */
export function openZipFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size < 22) throw new Error(`不是有效的 zip：${file}`);
    const tailLen = Math.min(stat.size, 22 + 0xffff + 20 + 56);
    const tail = readAt(fd, stat.size - tailLen, tailLen);
    const eocdRel = findEOCD(tail);
    if (eocdRel < 0) throw new Error(`不是有效的 zip：${file}`);
    const eocd = stat.size - tailLen + eocdRel;

    let count = tail.readUInt16LE(eocdRel + 10);
    let cdOffset = tail.readUInt32LE(eocdRel + 16);
    let cdSize = tail.readUInt32LE(eocdRel + 12);

    if (count === 0xffff || cdOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0) throw new Error(`ZIP64 结构缺失：${file}`);
      const loc = readAt(fd, locator, 20);
      if (loc.readUInt32LE(0) !== LOC64_SIG) throw new Error(`ZIP64 结构缺失：${file}`);
      const eocd64 = Number(loc.readBigUInt64LE(8));
      const rec = readAt(fd, eocd64, 56);
      if (rec.readUInt32LE(0) !== EOCD64_SIG) throw new Error(`ZIP64 中央目录损坏：${file}`);
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }

    // 中央目录一般只有几百 KB，可以整段读；条目数据留给 read() 按需读
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = parseCentralDirectory(cd, 0, count, file);

    function read(entry) {
      const local = readAt(fd, entry.localOffset, 30);
      if (local.readUInt32LE(0) !== LOC_SIG) throw new Error(`本地头损坏：${entry.name}`);
      const nameLen = local.readUInt16LE(26);
      const extraLen = local.readUInt16LE(28);
      const start = entry.localOffset + 30 + nameLen + extraLen;
      const data = readAt(fd, start, entry.compSize);
      if (entry.method === 0) return data;
      if (entry.method === 8) return zlib.inflateRawSync(data);
      throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`);
    }

    return {
      file,
      entries,
      read,
      close() {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      },
    };
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    throw error;
  }
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
    if (locator < 0 || buf.readUInt32LE(locator) !== LOC64_SIG) {
      throw new Error(`ZIP64 结构缺失：${label}`);
    }
    const eocd64 = Number(buf.readBigUInt64LE(locator + 8));
    if (eocd64 < 0 || eocd64 + 56 > buf.length || buf.readUInt32LE(eocd64) !== EOCD64_SIG) {
      throw new Error(`ZIP64 中央目录损坏：${label}`);
    }
    count = Number(buf.readBigUInt64LE(eocd64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
  }

  const entries = parseCentralDirectory(buf, cdOffset, count, label);

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

  return {
    file: label,
    entries,
    read,
    close() {},
  };
}

export function readZipEntryText(file, entryName) {
  const zip = openZipFile(file);
  try {
    const entry = zip.entries.find((e) => e.name === entryName);
    if (!entry) return null;
    return zip.read(entry).toString('utf8');
  } finally {
    zip.close();
  }
}

/**
 * 解压到目录，保留相对路径。
 * @param {(name: string) => boolean} filter
 */
export function extractZip(file, outDir, filter = () => true) {
  const zip = openZipFile(file);
  try {
    let written = 0;
    for (const entry of zip.entries) {
      if (!filter(entry.name)) continue;
      // 和打包/其它解包路径共用 safeJoin：绝对路径、盘符、任何 .. 段都直接拒绝
      let resolved;
      try {
        resolved = safeJoin(outDir, entry.name);
      } catch {
        continue;
      }
      if (entry.isDir) {
        ensureDir(resolved);
        continue;
      }
      ensureDir(path.dirname(resolved));
      fs.writeFileSync(resolved, zip.read(entry));
      written += 1;
    }
    return written;
  } finally {
    zip.close();
  }
}

/** 列出 zip 内所有文件（不含目录） */
export function listZip(file) {
  const zip = openZipFile(file);
  try {
    return zip.entries.filter((e) => !e.isDir).map((e) => ({ name: e.name, size: e.size }));
  } finally {
    zip.close();
  }
}
