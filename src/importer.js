"use strict";
// Adding games by drag and drop: work out which system each file is for, then copy it (plus any
// track files it needs) into Games/<system folder>/. Only ambiguous files are left for the person to pick.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { biosDest } = require("./bios");

const IMG = [".png", ".jpg", ".jpeg", ".webp"];
const SHEETS = [".cue", ".gdi", ".m3u"];
const MAX_FILES = 20000;

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return b.subarray(0, n);
}
function withFile(p, fn) {
  let fd;
  try { fd = fs.openSync(p, "r"); return fn(fd, fs.fstatSync(fd).size); } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
const ascii = (b, a, n) => b.length >= a + n ? b.toString("latin1", a, a + n) : "";

/** File names inside a zip, from its central directory (no extraction). */
function zipEntries(p) {
  return withFile(p, (fd, size) => {
    const tailLen = Math.min(size, 65557), tail = readAt(fd, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) return null;
    const cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (cdOff === 0xffffffff || cdSize > 64 * 1048576) return null;
    const cd = readAt(fd, cdOff, cdSize), out = [];
    for (let i = 0; i + 46 <= cd.length && cd.readUInt32LE(i) === 0x02014b50 && out.length < 5000;) {
      const usize = cd.readUInt32LE(i + 24), nl = cd.readUInt16LE(i + 28), xl = cd.readUInt16LE(i + 30), cl = cd.readUInt16LE(i + 32);
      const name = cd.toString("utf8", i + 46, i + 46 + nl);
      if (!name.endsWith("/")) out.push({ name, size: usize });
      i += 46 + nl + xl + cl;
    }
    return out;
  });
}

/** ISO 9660 system identifier of a CD/DVD image (raw 2352-byte sectors or plain 2048), or null. */
function discSystemId(fd, size) {
  for (const [sector, off] of [[2048, 0], [2352, 16], [2352, 24]]) {
    const at = sector * 16 + off;
    if (at + 40 > size) continue;
    const b = readAt(fd, at, 40);
    if (ascii(b, 1, 5) === "CD001") return ascii(b, 8, 32).trim();
  }
  return null;
}

/** Parse a .cue/.gdi/.m3u and return the files it points to (absolute paths). */
function sheetFiles(p) {
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch { return []; }
  const dir = path.dirname(p), ext = path.extname(p).toLowerCase(), out = [];
  for (const line of text.split(/\r?\n/)) {
    let m;
    if (ext === ".cue") m = /^\s*FILE\s+(?:"([^"]+)"|(\S+))/i.exec(line);
    else if (ext === ".gdi") m = /^\s*\d+\s+\d+\s+\d+\s+\d+\s+(?:"([^"]+)"|(\S+))/.exec(line);
    else if (line.trim() && !line.trim().startsWith("#")) m = [null, line.trim()];
    if (m) out.push(path.resolve(dir, m[1] || m[2]));
  }
  return out;
}
function cueFirstTrackAudio(p) {
  try { return /^\s*TRACK\s+0*1\s+AUDIO/im.test(fs.readFileSync(p, "utf8")); } catch { return false; }
}

class Importer {
  /** systems: config "systems" object. Folder codes (nes, ps1, gc…) identify systems in the sniffers. */
  constructor(systems) {
    this.systems = systems;
    this.byFolder = {};
    this.byExt = {};
    for (const [name, s] of Object.entries(systems)) {
      this.byFolder[s.folder || name] = name;
      for (const e of s.exts || []) (this.byExt[e.toLowerCase()] = this.byExt[e.toLowerCase()] || []).push(name);
    }
  }
  sys(folder) { return this.byFolder[folder] || null; }

  /** Best guess of which system a file is for, from its contents. Returns {system, makeCue?} or null. */
  sniff(p, ext, cands) {
    const pick = folder => { const s = this.sys(folder); return s && cands.includes(s) ? s : null; };
    if (ext === ".zip") {
      const es = zipEntries(p);
      if (!es || !es.length) return null;
      const known = es.filter(e => { const x = path.extname(e.name).toLowerCase(); return this.byExt[x] && x !== ".zip" && x !== ".7z"; });
      // arcade romsets are zips of chip dumps with no console file extension
      if (!known.length || (es.length > 2 && known.length < es.length / 2)) return { system: pick("arcade") };
      const x = path.extname(known[0].name).toLowerCase();
      if (x === ".bin") return { system: pick(known[0].size > 65536 ? "genesis" : "atari2600") };
      const ss = this.byExt[x].filter(s => cands.includes(s));
      return ss.length === 1 ? { system: ss[0] } : null;
    }
    return withFile(p, (fd, size) => {
      const head = readAt(fd, 0, 0x200);
      if (ext === ".bin") {
        if (ascii(head, 0x100, 4) === "SEGA") return { system: pick("genesis") };
        if (size <= 65536) return { system: pick("atari2600") };
        const id = size > 4 * 1048576 ? discSystemId(fd, size) : null;
        if (id && /PLAYSTATION/.test(id) && this.sys("ps1")) return { system: this.sys("ps1"), makeCue: true };
        if (id !== null) return null;
        return size <= 8 * 1048576 ? { system: pick("genesis") } : null;
      }
      if (ext === ".iso" || ext === ".gcm") {
        if (head.length >= 0x20 && (head.readUInt32BE(0x18) === 0x5D1C9EA3 || head.readUInt32BE(0x1C) === 0xC2339F3D)) return { system: pick("gc") };
        const id = discSystemId(fd, size) || "";
        if (/PSP GAME/.test(id)) return { system: pick("psp") };
        if (/PLAYSTATION/.test(id)) return { system: pick("ps2") };
        return null;
      }
      if (ext === ".cso") return { system: pick("psp") };
      if (ext === ".pbp") {
        if (ascii(head, 1, 3) !== "PBP") return null;
        const psar = head.readUInt32LE(0x24), tag = ascii(readAt(fd, psar, 10), 0, 10);
        return { system: pick(/^PS(ISO|TITLE)IMG/.test(tag) ? "ps1" : "psp") };
      }
      if (ext === ".chd") {
        if (ascii(head, 0, 8) !== "MComprHD" || head.readUInt32BE(12) !== 5) return null;
        let at = Number(head.readBigUInt64BE(0x30));
        for (let i = 0; at && i < 32; i++) {
          const m = readAt(fd, at, 16);
          if (m.length < 16) break;
          const tag = ascii(m, 0, 4);
          if (tag === "CHGD") return { system: pick("dreamcast") };
          if (tag === "DVD ") return { system: pick("ps2") };
          at = Number(m.readBigUInt64BE(8));
        }
        return null;
      }
      if (ext === ".cue") {
        const files = sheetFiles(p);
        if (files[0]) {
          const id = withFile(files[0], discSystemId);
          if (id && /PLAYSTATION/.test(id)) return { system: pick("ps1") };
          if (id) return null;
        }
        return cueFirstTrackAudio(p) ? { system: pick("pce") } : null;
      }
      if (ext === ".m3u") {
        const first = sheetFiles(p)[0];
        if (!first) return null;
        const x = path.extname(first).toLowerCase(), c = (this.byExt[x] || []).filter(s => cands.includes(s));
        return c.length === 1 ? { system: c[0] } : this.sniff(first, x, cands);
      }
      return null;
    });
  }

  /** Walk dropped files/folders and classify everything that looks like a game. */
  inspect(paths) {
    const files = [], seen = new Set();
    const add = p => { if (!seen.has(p) && files.length < MAX_FILES) { seen.add(p); files.push(p); } };
    const walk = (p, depth) => {
      let st;
      try { st = fs.statSync(p); } catch { return; }
      if (st.isDirectory()) {
        if (depth > 6) return;
        let names = [];
        try { names = fs.readdirSync(p); } catch {}
        for (const n of names) if (!n.startsWith(".")) walk(path.join(p, n), depth + 1);
      } else if (st.isFile()) add(p);
    };
    for (const p of paths) if (typeof p === "string" && p) walk(path.resolve(p), 0);

    // files a .cue/.gdi/.m3u points at travel with it instead of showing up on their own
    const owned = new Map();
    for (const f of files) {
      if (!SHEETS.includes(path.extname(f).toLowerCase())) continue;
      for (const x of sheetFiles(f)) {
        if (!owned.has(x)) owned.set(x, f);
        if (path.extname(x).toLowerCase() === ".cue") for (const y of sheetFiles(x)) if (!owned.has(y)) owned.set(y, f);
      }
    }
    // an .m3u wins over the discs it lists
    for (const [x, owner] of [...owned]) if (path.extname(owner).toLowerCase() === ".cue" && owned.get(owner)) owned.set(x, owned.get(owner));

    const items = [], unknown = [], stems = new Map(), bios = [];
    for (const f of files) {
      const ext = path.extname(f).toLowerCase(), name = path.basename(f);
      if (owned.has(f) && owned.get(f) !== f) continue;
      if (IMG.includes(ext)) continue;
      // a BIOS file (scph5501.bin, neogeo.zip…) goes to the BIOS folder, not onto a shelf
      const dest = biosDest(name);
      if (dest) { bios.push({ src: f, name, dest }); continue; }
      const cands = this.byExt[ext];
      if (!cands) { if (!/^(readme|desktop\.ini|thumbs\.db)/i.test(name)) unknown.push(name); continue; }
      let size = 0;
      try { size = fs.statSync(f).size; } catch {}
      const it = { id: crypto.createHash("sha1").update(f).digest("hex").slice(0, 12), src: f, name, ext, size, system: null, choices: cands, extras: [], makeCue: false };
      if (cands.length === 1) it.system = cands[0];
      else {
        let r = null;
        try { r = this.sniff(f, ext, cands); } catch {}
        if (r && r.system) {
          it.system = r.system; it.makeCue = !!r.makeCue;
          // a bare PS1 .bin gets a .cue written for it, so PS1 is a valid choice even though .bin isn't a PS1 extension
          if (!it.choices.includes(r.system)) it.choices = [...it.choices, r.system];
        }
      }
      if (SHEETS.includes(ext)) {
        for (const [x, owner] of owned) if (owner === f && fs.existsSync(x)) { it.extras.push(x); try { it.size += fs.statSync(x).size; } catch {} }
      }
      items.push(it);
      stems.set(path.join(path.dirname(f), path.parse(f).name).toLowerCase(), it);
    }
    // cover art saved next to a game, with the same name, comes along too
    for (const f of files) {
      if (!IMG.includes(path.extname(f).toLowerCase())) continue;
      const it = stems.get(path.join(path.dirname(f), path.parse(f).name).toLowerCase());
      if (it) it.extras.push(f);
    }
    return { items, unknown, bios };
  }

  /** Where an item ends up inside the games folder. Multi-file games get their own subfolder. */
  plan(it, root) {
    const s = this.systems[it.system], dir = path.join(root, s.folder || it.system);
    const stem = path.parse(it.name).name, nested = it.makeCue || it.extras.some(x => !IMG.includes(path.extname(x).toLowerCase()));
    const base = nested ? path.join(dir, stem) : dir, srcDir = path.dirname(it.src);
    const copies = [[it.src, path.join(base, it.name)]];
    for (const x of it.extras) {
      let rel = path.relative(srcDir, x);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) rel = path.basename(x);
      copies.push([x, path.join(base, rel)]);
    }
    const cue = it.makeCue ? path.join(base, stem + ".cue") : null;
    return { copies, cue, main: cue || copies[0][1] };
  }

  /** Copy planned items. onProgress({done, total, current}) after each game. Returns counts. */
  async copy(items, root, onProgress) {
    let added = 0, already = 0, failed = 0;
    const errors = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      onProgress({ done: i, total: items.length, current: it.name });
      try {
        const { copies, cue } = this.plan(it, root);
        let fresh = false;
        for (const [src, dest] of copies) {
          if (path.resolve(src) === path.resolve(dest)) continue;
          try { if (fs.statSync(dest).size === fs.statSync(src).size) continue; } catch {}
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          // clone where the disk supports it (instant on APFS), copy otherwise
          await fs.promises.copyFile(src, dest + ".part", fs.constants.COPYFILE_FICLONE);
          await fs.promises.rename(dest + ".part", dest);
          fresh = true;
        }
        if (cue && !fs.existsSync(cue)) {
          fs.writeFileSync(cue, `FILE "${it.name}" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`);
          fresh = true;
        }
        fresh ? added++ : already++;
      } catch (e) {
        failed++;
        errors.push(`${it.name}: ${e.code === "ENOSPC" ? "the disk is full" : e.message}`);
      }
    }
    onProgress({ done: items.length, total: items.length, current: "" });
    return { added, already, failed, errors };
  }
}

module.exports = { Importer, zipEntries, sheetFiles };
