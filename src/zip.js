"use strict";
// A small .zip writer for backing up saves: no tools to install, the same on Mac and Windows.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const util = require("util");
const zlib = require("zlib");

/** what's never a save: the app's own notes for other computers, and what Macs and Windows leave in folders. Other
    names starting with a dot are saves too (".hack//Infection.srm") */
const NOT_SAVES = name => /^(\.the-retro-shelf|\.in-play|\.DS_Store|\._.*|\.Spotlight-V100|\.Trashes|\.Trash(-\d+)?|\.fseventsd|\.TemporaryItems|\.dropbox.*|\.stversions|\.stfolder|\.stignore|\.sync|\.git|\..*\.icloud|desktop\.ini|Thumbs\.db)$/i.test(name);

/** every file under dir (not the ones above), as paths relative to it; a link to a file counts as that file */
function filesIn(dir, rel = "") {
  let out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (NOT_SAVES(e.name)) continue;
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) out = out.concat(filesIn(dir, r));
    else if (e.isFile()) out.push(r);
    else if (e.isSymbolicLink()) { try { if (fs.statSync(path.join(dir, r)).isFile()) out.push(r); } catch {} }
  }
  return out;
}

/** an entry's modification time from its "extended timestamp" extra field (0x5455), in seconds since 1970, or 0 */
function utcTime(extra) {
  for (let i = 0; i + 4 <= extra.length;) {
    const id = extra.readUInt16LE(i), len = extra.readUInt16LE(i + 2);
    if (id === 0x5455 && len >= 5 && i + 9 <= extra.length && (extra[i + 4] & 1)) return extra.readUInt32LE(i + 5);
    i += 4 + len;
  }
  return 0;
}

/** a file time in the MS-DOS form zip files use */
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    // the form has room for 1980 to 2107: a file dated outside it (a clock gone wrong) is put at the nearest end
    date: ((Math.min(2107, Math.max(1980, d.getFullYear())) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// a plain zip file counts sizes and places in 32 bits: a backup can't pass 4 GB, or hold more than 65,535 files
const MAX = 0xffffffff, TOO_BIG = "the saves add up to more than 4 GB, too much for one backup file";
const deflate = util.promisify(zlib.deflateRaw), inflate = util.promisify(zlib.inflateRaw);
// what a zip may claim, read before trusting it: an index past 64 MB, or one file past 512 MB, isn't saves or cheats
const MAX_INDEX = 64 * 1048576, MAX_ENTRY = 512 * 1048576;
/** an entry's contents, unpacked to no more than the size its index gives (a "zip bomb" stops there) */
const unpack = (method, body, size) => method === 8 ? inflate(body, { maxOutputLength: Math.max(1, size) }) : method === 0 ? Promise.resolve(body) : Promise.resolve(null);
// what old Windows zips use for names that aren't marked as UTF-8: code page 437's upper half
const CP437 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
function entryName(cd, at, nlen) {
  const raw = cd.subarray(at + 46, at + 46 + nlen);
  if (cd.readUInt16LE(at + 8) & 0x800 || !raw.some(b => b >= 0x80)) return raw.toString("utf8");
  const utf8 = raw.toString("utf8");
  return utf8.includes("\ufffd") ? [...raw].map(b => b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80]).join("") : utf8;
}
/** a zip's index: where it is and how long, checked against the file's size */
async function index(fh, read) {
  const size = (await fh.stat()).size, tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("that isn't a zip file");
  const len = tail.readUInt32LE(e + 12), start = tail.readUInt32LE(e + 16);
  if (len > MAX_INDEX || start + len > size) throw new Error("that zip file is damaged");
  return { count: tail.readUInt16LE(e + 10), cd: await read(start, len) };
}

/**
 * Zips the folder dir into the file out, with every entry under one top folder ("Saves/…" whatever the folder is
 * called, so a backup of saves kept in a cloud folder restores the same way), so unzipping puts the folder back.
 * Returns how many files went in. Works a file at a time without holding up the app.
 */
async function zipFolder(dir, out, top = "Saves") {
  // a zip or a half-written file among the saves isn't a save (and a backup kept there would hold the ones before)
  const files = filesIn(dir).filter(r => !/\.(zip|part|tmp)$/i.test(r));
  return zipFiles(files.map(rel => ({ name: top + "/" + rel, full: path.join(dir, ...rel.split("/")) })), out);
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
      // the time it was saved, exactly and the same in every time zone (the zip's own time is the clock on the wall):
      // the "extended timestamp" extra field, 0x5455, with its modification time
      const ext = Buffer.alloc(9); ext.writeUInt16LE(0x5455, 0); ext.writeUInt16LE(5, 2); ext.writeUInt8(1, 4);
      ext.writeUInt32LE(Math.max(0, Math.min(0xffffffff, Math.floor(st.mtimeMs / 1000))), 5);
      if (offset + 30 + name.length + ext.length + body.length > MAX) throw new Error(TOO_BIG);
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(stored ? 0 : 8, 8);
      head.writeUInt16LE(t.time, 10); head.writeUInt16LE(t.date, 12); head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(ext.length, 28);
      const at = offset;
      await write(head); await write(name); await write(ext); await write(body);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(stored ? 0 : 8, 10);
      c.writeUInt16LE(t.time, 12); c.writeUInt16LE(t.date, 14); c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt16LE(ext.length, 30); c.writeUInt32LE(at, 42);
      central.push(c, name, ext);
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
 * Puts a backup's files back into dir. A backup holds one top folder ("Saves/…" as zipFolder writes them, or the
 * folder's own name in backups from before); its contents land in dir, and a save already there that's newer than
 * the one in the backup is kept; an older one is handed to opts.aside (the Trash) before the backup's takes its place,
 * and kept if it can't be. A zip that isn't laid out like that isn't a backup, and nothing is restored from it.
 * Nothing is written outside dir. A save that can't be written (a game has it open, a name this computer doesn't
 * allow) is counted as failed and the rest still go back. Reads the backup a piece at a time. Returns counts.
 */
async function unzipInto(file, dir, opts = {}) {
  const fh = await fsp.open(file, "r");
  const read = async (pos, len) => { const b = Buffer.alloc(len); const { bytesRead } = await fh.read(b, 0, len, pos); return b.subarray(0, bytesRead); };
  const res = { restored: 0, kept: 0, skipped: 0, failed: 0 };
  try {
    const { count, cd } = await index(fh, read), list = [];
    let at = 0;
    for (let k = 0; k < count && at + 46 <= cd.length && cd.readUInt32LE(at) === 0x02014b50; k++) {
      const nlen = cd.readUInt16LE(at + 28), xlen = cd.readUInt16LE(at + 30);
      list.push({ method: cd.readUInt16LE(at + 10), time: cd.readUInt16LE(at + 12), date: cd.readUInt16LE(at + 14), crc: cd.readUInt32LE(at + 16),
        csize: cd.readUInt32LE(at + 20), usize: cd.readUInt32LE(at + 24), local: cd.readUInt32LE(at + 42), name: entryName(cd, at, nlen).replace(/\\/g, "/"),
        utc: utcTime(cd.subarray(at + 46 + nlen, at + 46 + nlen + xlen)) });
      at += 46 + nlen + cd.readUInt16LE(at + 30) + cd.readUInt16LE(at + 32);
    }
    // the backup's one top folder (Finder's __MACOSX extras aside)
    const files = list.filter(x => !x.name.endsWith("/") && !/^__MACOSX(\/|$)/.test(x.name));
    const tops = new Set(files.map(x => x.name.includes("/") ? x.name.split("/")[0] : ""));
    if (!files.length || tops.size !== 1 || tops.has("")) throw new Error("that isn't a backup of saves from The Retro Shelf");
    for (const { method, time, date, crc, csize, usize, local, name, utc } of files) {
      const parts = name.split("/").slice(1);
      // Finder's extra files, the app's own notes, and anything that would end up outside the Saves folder are left out
      if (/^__MACOSX/.test(name) || parts.some(p => !p || p === "." || p === ".." || NOT_SAVES(p) || /[:\\]/.test(p))) { res.skipped++; continue; }
      const to = path.join(dir, ...parts);
      if (path.relative(dir, to).startsWith("..")) { res.skipped++; continue; }
      // when it was saved: exactly, from a backup that says (made by this version or later), or by the wall clock
      const when = utc ? new Date(utc * 1000) : new Date(((date >> 9) & 127) + 1980, ((date >> 5) & 15) - 1, date & 31, (time >> 11) & 31, (time >> 5) & 63, (time & 31) * 2);
      try { if ((await fsp.stat(to)).mtimeMs > when.getTime() + 2000) { res.kept++; continue; } } catch {}
      if (csize > MAX_ENTRY || usize > MAX_ENTRY) { res.skipped++; continue; }
      let data;
      try {
        const lh = await read(local, 30);
        if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) { res.skipped++; continue; }
        data = await unpack(method, await read(local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28), csize), usize);
      } catch { data = null; }
      if (!data || zlib.crc32(data) !== crc) { res.skipped++; continue; }
      try {
        // one there already: the same one stays as it is; another goes to the Trash first, never written over
        let there = null;
        try { there = await fsp.readFile(to); } catch {}
        if (there && there.equals(data)) { res.restored++; continue; }
        if (there && opts.aside) { try { await opts.aside(to); } catch { res.kept++; continue; } }
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
    const { count, cd } = await index(fh, read), out = [];
    let at = 0;
    for (let k = 0; k < count && at + 46 <= cd.length && cd.readUInt32LE(at) === 0x02014b50; k++) {
      const nlen = cd.readUInt16LE(at + 28), name = entryName(cd, at, nlen);
      if (!name.endsWith("/")) out.push({ name, method: cd.readUInt16LE(at + 10), crc: cd.readUInt32LE(at + 16), csize: cd.readUInt32LE(at + 20), usize: cd.readUInt32LE(at + 24), local: cd.readUInt32LE(at + 42) });
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
    if (lh.readUInt32LE(0) !== 0x04034b50 || entry.csize > MAX_ENTRY || (entry.usize || 0) > MAX_ENTRY) throw new Error("damaged zip file");
    const body = Buffer.alloc(entry.csize); await fh.read(body, 0, entry.csize, entry.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28));
    const data = await unpack(entry.method, body, entry.usize ?? MAX_ENTRY);
    if (!data || zlib.crc32(data) !== entry.crc) throw new Error("damaged zip file");
    return data;
  } finally { await fh.close(); }
}

module.exports = { zipFolder, zipFiles, unzipInto, filesIn, entries, readEntry };
