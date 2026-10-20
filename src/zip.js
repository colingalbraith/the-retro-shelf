"use strict";
// A small .zip writer for backing up saves: no tools to install, the same on Mac and Windows.
const fs = require("fs");
const path = require("path");
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

/**
 * Zips the folder dir into the file out, with every entry under the folder's own name ("Saves/…"), so unzipping
 * puts the folder back. Returns how many files went in.
 */
function zipFolder(dir, out) {
  const top = path.basename(dir), files = filesIn(dir), central = [];
  const tmp = out + ".part", fd = fs.openSync(tmp, "w");
  let offset = 0;
  const write = b => { fs.writeSync(fd, b); offset += b.length; };
  try {
    for (const rel of files) {
      const full = path.join(dir, ...rel.split("/")), data = fs.readFileSync(full), st = fs.statSync(full);
      const packed = zlib.deflateRawSync(data), stored = packed.length >= data.length;
      const body = stored ? data : packed, name = Buffer.from(top + "/" + rel, "utf8"), crc = zlib.crc32(data), t = dosTime(st.mtime);
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(stored ? 0 : 8, 8);
      head.writeUInt16LE(t.time, 10); head.writeUInt16LE(t.date, 12); head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
      const at = offset;
      write(head); write(name); write(body);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(stored ? 0 : 8, 10);
      c.writeUInt16LE(t.time, 12); c.writeUInt16LE(t.date, 14); c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(at, 42);
      central.push(c, name);
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22), start = offset;
    write(cd);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(start, 16);
    write(end);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, out);
  return files.length;
}

/**
 * Puts a backup's files back into dir. Entries under "Saves/" (as zipFolder writes them) land in dir; a save already
 * there that's newer than the one in the backup is kept. Nothing is written outside dir. Returns counts.
 */
function unzipInto(file, dir) {
  const b = fs.readFileSync(file);
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("that isn't a zip file");
  const count = b.readUInt16LE(e + 10);
  let at = b.readUInt32LE(e + 16);
  const res = { restored: 0, kept: 0, skipped: 0 };
  for (let k = 0; k < count && b.readUInt32LE(at) === 0x02014b50; k++) {
    const method = b.readUInt16LE(at + 10), time = b.readUInt16LE(at + 12), date = b.readUInt16LE(at + 14), crc = b.readUInt32LE(at + 16);
    const csize = b.readUInt32LE(at + 20), nlen = b.readUInt16LE(at + 28), xlen = b.readUInt16LE(at + 30), clen = b.readUInt16LE(at + 32);
    const local = b.readUInt32LE(at + 42), name = b.toString("utf8", at + 46, at + 46 + nlen);
    at += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    const parts = name.replace(/^Saves\//, "").split("/");
    // Finder's extra files, hidden files, and anything that would end up outside the Saves folder are left out
    if (/^__MACOSX/.test(name) || parts.some(p => !p || p === "." || p === ".." || p.startsWith(".") || /[:\\]/.test(p))) { res.skipped++; continue; }
    const to = path.join(dir, ...parts);
    if (path.relative(dir, to).startsWith("..")) { res.skipped++; continue; }
    const when = new Date(((date >> 9) & 127) + 1980, ((date >> 5) & 15) - 1, date & 31, (time >> 11) & 31, (time >> 5) & 63, (time & 31) * 2);
    try { if (fs.statSync(to).mtimeMs > when.getTime() + 2000) { res.kept++; continue; } } catch {}
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28), body = b.subarray(start, start + csize);
    let data;
    try { data = method === 8 ? zlib.inflateRawSync(body) : method === 0 ? body : null; } catch { data = null; }
    if (!data || zlib.crc32(data) !== crc) { res.skipped++; continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to + ".part", data);
    fs.renameSync(to + ".part", to);
    try { fs.utimesSync(to, when, when); } catch {}
    res.restored++;
  }
  return res;
}

module.exports = { zipFolder, unzipInto };
