import fs from 'node:fs';
import path from 'node:path';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 极简 ZIP 写入器（store 模式，不压缩）。
 * 整合包里 mod 的 jar 本身已压缩，config/资源包再 deflate 收益有限但会吃 CPU；
 * 直接 store 写入最快，读端（我们的 zip.mjs / 系统解压）都支持。
 */
export function createZipWriter(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  const central = [];
  let offset = 0;
  let closed = false;

  function write(buf) {
    fs.writeSync(fd, buf);
    offset += buf.length;
  }

  /** 加一个文件；name 用正斜杠 */
  function add(name, buf) {
    if (closed) throw new Error('ZIP 已经关闭');
    const entryName = String(name).replace(/\\/g, '/');
    const nameBuf = Buffer.from(entryName, 'utf8');
    const size = buf.length;
    if (offset + 30 + nameBuf.length + size > 0xffffffff) {
      throw new Error('导出包超过 4GB，暂不支持 ZIP64 写入；可以先排除存档/资源包再导出');
    }
    const crc = crc32(buf);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    write(local);
    write(nameBuf);
    write(buf);
    central.push({ nameBuf, crc, size, offset: offset - size - nameBuf.length - 30 });
  }

  function close() {
    if (closed) return;
    const cdStart = offset;
    for (const entry of central) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(20, 6);
      head.writeUInt16LE(0x0800, 8);
      head.writeUInt16LE(0, 10);
      head.writeUInt16LE(0, 12);
      head.writeUInt16LE(0x21, 14);
      head.writeUInt32LE(entry.crc, 16);
      head.writeUInt32LE(entry.size, 20);
      head.writeUInt32LE(entry.size, 24);
      head.writeUInt16LE(entry.nameBuf.length, 28);
      head.writeUInt16LE(0, 30);
      head.writeUInt16LE(0, 32);
      head.writeUInt16LE(0, 34);
      head.writeUInt16LE(0, 36);
      head.writeUInt32LE(0, 38);
      head.writeUInt32LE(entry.offset, 42);
      write(head);
      write(entry.nameBuf);
    }
    const cdSize = offset - cdStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    write(eocd);
    fs.closeSync(fd);
    closed = true;
  }

  return { add, close };
}
