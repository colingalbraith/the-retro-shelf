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

module.exports = { zipFolder };
