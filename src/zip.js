"use strict";
// A small .zip writer for backing up saves: no tools to install, the same on Mac and Windows.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const util = require("util");
const zlib = require("zlib");

/** every file under dir (not hidden ones), as paths relative to it */
function filesIn(dir, rel = "") {
  let out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) out = out.concat(filesIn(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** a file time in the MS-DOS form zip files use */
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// a plain zip file counts sizes and places in 32 bits: a backup can't pass 4 GB, or hold more than 65,535 files
const MAX = 0xffffffff, TOO_BIG = "the saves add up to more than 4 GB, too much for one backup file";
const deflate = util.promisify(zlib.deflateRaw), inflate = util.promisify(zlib.inflateRaw);

/**
 * Zips the folder dir into the file out, with every entry under the folder's own name ("Saves/…"), so unzipping
 * puts the folder back. Returns how many files went in. Works a file at a time without holding up the app.
 */
async function zipFolder(dir, out) {
  const top = path.basename(dir);
  return zipFiles(filesIn(dir).map(rel => ({ name: top + "/" + rel, full: path.join(dir, ...rel.split("/")) })), out);
}

/** Zips these files ({name in the zip, full path}) into the file out. Returns how many went in. */
async function zipFiles(list, out) {
  const central = [];
  if (list.length > 0xffff) throw new Error(TOO_BIG);
  const tmp = out + ".part", fh = await fsp.open(tmp, "w");
  let offset = 0;
  const write = async b => { await fh.write(b); offset += b.length; };
  try {
    for (const { name: entry, full } of list) {
      const data = await fsp.readFile(full), st = await fsp.stat(full);
      const packed = await deflate(data), stored = packed.length >= data.length;
      const body = stored ? data : packed, name = Buffer.from(entry, "utf8"), crc = zlib.crc32(data), t = dosTime(st.mtime);
      if (offset + 30 + name.length + body.length > MAX) throw new Error(TOO_BIG);
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(stored ? 0 : 8, 8);
      head.writeUInt16LE(t.time, 10); head.writeUInt16LE(t.date, 12); head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
      const at = offset;
      await write(head); await write(name); await write(body);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(stored ? 0 : 8, 10);
      c.writeUInt16LE(t.time, 12); c.writeUInt16LE(t.date, 14); c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(at, 42);
      central.push(c, name);
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22), start = offset;
    if (start + cd.length > MAX) throw new Error(TOO_BIG);
    await write(cd);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(list.length, 8); end.writeUInt16LE(list.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(start, 16);
    await write(end);
    await fh.close();
  } catch (e) {
    await fh.close().catch(() => {});
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  await fsp.rename(tmp, out);
  return list.length;
}

/**
 * Puts a backup's files back into dir. Entries under "Saves/" (as zipFolder writes them) land in dir; a save already
 * there that's newer than the one in the backup is kept. Nothing is written outside dir. A save that can't be
 * written (a game has it open, a name this computer doesn't allow) is counted as failed and the rest still go back.
 * Reads the backup a piece at a time, so its size doesn't matter. Returns counts.
 */
async function unzipInto(file, dir) {
  const fh = await fsp.open(file, "r");
  const read = async (pos, len) => { const b = Buffer.alloc(len); const { bytesRead } = await fh.read(b, 0, len, pos); return b.subarray(0, bytesRead); };
  const res = { restored: 0, kept: 0, skipped: 0, failed: 0 };
  try {
    const size = (await fh.stat()).size, tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error("that isn't a zip file");
    const count = tail.readUInt16LE(e + 10), cd = await read(tail.readUInt32LE(e + 16), tail.readUInt32LE(e + 12));
    let at = 0;
    for (let k = 0; k < count && at + 46 <= cd.length && cd.readUInt32LE(at) === 0x02014b50; k++) {
      const method = cd.readUInt16LE(at + 10), time = cd.readUInt16LE(at + 12), date = cd.readUInt16LE(at + 14), crc = cd.readUInt32LE(at + 16);
      const csize = cd.readUInt32LE(at + 20), nlen = cd.readUInt16LE(at + 28), xlen = cd.readUInt16LE(at + 30), clen = cd.readUInt16LE(at + 32);
      const local = cd.readUInt32LE(at + 42), name = cd.toString("utf8", at + 46, at + 46 + nlen);
      at += 46 + nlen + xlen + clen;
      if (name.endsWith("/")) continue;
      const parts = name.replace(/^Saves\//, "").split("/");
      // Finder's extra files, hidden files, and anything that would end up outside the Saves folder are left out
      if (/^__MACOSX/.test(name) || parts.some(p => !p || p === "." || p === ".." || p.startsWith(".") || /[:\\]/.test(p))) { res.skipped++; continue; }
      const to = path.join(dir, ...parts);
      if (path.relative(dir, to).startsWith("..")) { res.skipped++; continue; }
      const when = new Date(((date >> 9) & 127) + 1980, ((date >> 5) & 15) - 1, date & 31, (time >> 11) & 31, (time >> 5) & 63, (time & 31) * 2);
      try { if ((await fsp.stat(to)).mtimeMs > when.getTime() + 2000) { res.kept++; continue; } } catch {}
      const lh = await read(local, 30);
      if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) { res.skipped++; continue; }
      const body = await read(local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28), csize);
      let data;
      try { data = method === 8 ? await inflate(body) : method === 0 ? body : null; } catch { data = null; }
      if (!data || zlib.crc32(data) !== crc) { res.skipped++; continue; }
      try {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.writeFile(to + ".part", data);
        await fsp.rename(to + ".part", to);
      } catch {
        await fsp.rm(to + ".part", { force: true }).catch(() => {});
        res.failed++; continue;
      }
      try { await fsp.utimes(to, when, when); } catch {}
      res.restored++;
    }
  } finally {
    await fh.close();
  }
  return res;
}

/** a zip file's entries (not folders), read from its index: [{name, method, csize, crc, local}] */
async function entries(file) {
  const fh = await fsp.open(file, "r");
  const read = async (pos, len) => { const b = Buffer.alloc(len); const { bytesRead } = await fh.read(b, 0, len, pos); return b.subarray(0, bytesRead); };
  try {
    const size = (await fh.stat()).size, tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error("that isn't a zip file");
    const count = tail.readUInt16LE(e + 10), cd = await read(tail.readUInt32LE(e + 16), tail.readUInt32LE(e + 12)), out = [];
    let at = 0;
    for (let k = 0; k < count && at + 46 <= cd.length && cd.readUInt32LE(at) === 0x02014b50; k++) {
      const nlen = cd.readUInt16LE(at + 28), name = cd.toString("utf8", at + 46, at + 46 + nlen);
      if (!name.endsWith("/")) out.push({ name, method: cd.readUInt16LE(at + 10), crc: cd.readUInt32LE(at + 16), csize: cd.readUInt32LE(at + 20), local: cd.readUInt32LE(at + 42) });
      at += 46 + nlen + cd.readUInt16LE(at + 30) + cd.readUInt16LE(at + 32);
    }
    return out;
  } finally { await fh.close(); }
}

/** one entry's contents (from entries()), checked against its checksum */
async function readEntry(file, entry) {
  const fh = await fsp.open(file, "r");
  try {
    const lh = Buffer.alloc(30); await fh.read(lh, 0, 30, entry.local);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error("damaged zip file");
    const body = Buffer.alloc(entry.csize); await fh.read(body, 0, entry.csize, entry.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28));
    const data = entry.method === 8 ? await inflate(body) : entry.method === 0 ? body : null;
    if (!data || zlib.crc32(data) !== entry.crc) throw new Error("damaged zip file");
    return data;
  } finally { await fh.close(); }
}

module.exports = { zipFolder, zipFiles, unzipInto, filesIn, entries, readEntry };
