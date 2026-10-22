"use strict";
// Adding games by drag and drop: work out which system each file is for, then copy it (plus any
// track files it needs) into Games/<system folder>/. Only ambiguous files are left for the person to pick.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { biosDest, biosByContent } = require("./bios");

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
/** a path as the disk compares it: on a Mac or Windows "TRACK 01.BIN" is "Track 01.bin" (and é is é however it's
    written); on Linux names are exact */
const pathKey = p => process.platform === "linux" ? path.resolve(p) : path.resolve(p).normalize("NFC").toLowerCase();
/** the last part of a path from a .cue (which may use either kind of slash) */
const leaf = ref => String(ref).split(/[\\/]/).pop();

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
  const v = discVolume(fd, size);
  return v ? v.id : null;
}
function discVolume(fd, size) {
  for (const [sector, off] of [[2048, 0], [2352, 16], [2352, 24]]) {
    const at = sector * 16 + off;
    if (at + 2048 > size) continue;
    const b = readAt(fd, at, 2048);
    if (ascii(b, 1, 5) === "CD001") return { id: ascii(b, 8, 32).trim(), sector, off, root: b.readUInt32LE(156 + 2), rootLen: b.readUInt32LE(156 + 10) };
  }
  return null;
}
/**
 * PlayStation 1 or 2, by the disc's own SYSTEM.CNF: "BOOT2 =" is a PS2 game, "BOOT =" a PS1 one (both say
 * PLAYSTATION as their system). null when it can't be read.
 */
function psGeneration(fd, size) {
  const v = discVolume(fd, size);
  if (!v || !/PLAYSTATION/.test(v.id)) return null;
  const sectorData = (lba, n) => Buffer.concat(Array.from({ length: n }, (_, k) => readAt(fd, (lba + k) * v.sector + v.off, 2048)));
  const dir = sectorData(v.root, Math.min(4, Math.ceil(v.rootLen / 2048) || 1));
  for (let i = 0; i < dir.length;) {
    const len = dir[i];
    if (!len) { i = (Math.floor(i / 2048) + 1) * 2048; continue; }
    const name = ascii(dir, i + 33, dir[i + 32]).split(";")[0].toUpperCase();
    if (name === "SYSTEM.CNF") {
      const text = sectorData(dir.readUInt32LE(i + 2), 1).toString("latin1", 0, Math.min(2048, dir.readUInt32LE(i + 10)));
      return /^\s*BOOT2\s*=/m.test(text) ? "ps2" : /^\s*BOOT\s*=/m.test(text) ? "ps1" : null;
    }
    i += len;
  }
  return null;
}
/** the system identifier inside a compressed (CISO) PSP or PS2 image: block 16 unpacked */
function csoSystemId(fd) {
  const h = readAt(fd, 0, 0x18);
  if (ascii(h, 0, 4) !== "CISO") return null;
  const bs = h.readUInt32LE(0x10) || 2048, align = h[0x15], blk = Math.floor(32768 / bs), within = 32768 % bs;
  const idx = readAt(fd, 0x18 + blk * 4, 8);
  if (idx.length < 8) return null;
  const a = idx.readUInt32LE(0), b = idx.readUInt32LE(4), pos = (a & 0x7fffffff) * 2 ** align, end = (b & 0x7fffffff) * 2 ** align;
  let data = readAt(fd, pos, Math.max(0, Math.min(end - pos, bs + 64)));
  if (!(a & 0x80000000)) { try { data = zlib.inflateRawSync(data, { maxOutputLength: bs }); } catch { return null; } }
  return ascii(data, within + 1, 5) === "CD001" ? ascii(data, within + 8, 32).trim() : null;
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
    // Sega's and 3DO discs say so in their first sector: at the start of an .iso, 16 bytes in on a raw 2352-byte
    // sector. A 3DO disc starts with the Opera file system's record: 1, then five 0x5A, then 1
    const sega = fd => {
      const h = readAt(fd, 0, 0x30), at = o => ascii(h, o, 15);
      for (const o of [0, 16]) {
        if (at(o).startsWith("SEGADISCSYSTEM")) return "segacd";
        if (at(o) === "SEGA SEGASATURN") return "saturn";
        if (h.length >= o + 7 && h[o] === 1 && h[o + 6] === 1 && [1, 2, 3, 4, 5].every(k => h[o + k] === 0x5a)) return "3do";
      }
      return null;
    };
    if (ext === ".zip") {
      const all = zipEntries(p);
      if (!all || !all.length) return null;
      // readmes, info files and pictures that come along aren't the game
      const es = all.filter(e => !/\.(txt|nfo|diz|url|pdf|html?|jpe?g|png|gif|bmp|ini|xml|dat|sfv|md5|sha1)$/i.test(e.name));
      if (!es.length) return null;
      // a BIOS in a zip isn't a game, and a disc needs its track files beside it (unzipped): asked about, not guessed
      if (es.some(e => biosDest(path.posix.basename(e.name), this.systems))) return null;
      if (es.some(e => [...SHEETS, ".ccd"].includes(path.extname(e.name).toLowerCase()))) return null;
      const known = es.filter(e => { const x = path.extname(e.name).toLowerCase(); return this.byExt[x] && x !== ".zip" && x !== ".7z"; });
      // arcade romsets are zips of chip dumps: mostly not console files, or several .bin/.rom chips (a console game's zip
      // holds one ROM)
      const chips = known.length > 1 && known.every(e => [".bin", ".rom"].includes(path.extname(e.name).toLowerCase()));
      if (!known.length || chips || (es.length > 2 && known.length < es.length / 2)) return { system: pick("arcade") };
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
        if (id && /PLAYSTATION/.test(id)) {
          if (psGeneration(fd, size) === "ps2") return { system: pick("ps2") };
          if (this.sys("ps1")) return { system: this.sys("ps1"), makeCue: true };
        }
        if (id !== null) return null;
        return size <= 8 * 1048576 ? { system: pick("genesis") } : null;
      }
      if (ext === ".iso" || ext === ".gcm") {
        const sg = sega(fd);
        if (sg) return { system: pick(sg) };
        if (head.length >= 0x20 && (head.readUInt32BE(0x18) === 0x5D1C9EA3 || head.readUInt32BE(0x1C) === 0xC2339F3D)) return { system: pick("gc") };
        const id = discSystemId(fd, size) || "";
        if (/PSP GAME/.test(id)) return { system: pick("psp") };
        // a PS1 game as an .iso (rare, but it happens) isn't a PS2 one: the disc's SYSTEM.CNF says which
        if (/PLAYSTATION/.test(id)) { const gen = psGeneration(fd, size); return gen === "ps1" ? { system: pick("ps1") } : gen === "ps2" || gen === null ? { system: pick("ps2") } : null; }
        return null;
      }
      if (ext === ".cso") {
        const id = csoSystemId(fd) || "";
        return /PSP GAME/.test(id) ? { system: pick("psp") } : /PLAYSTATION/.test(id) ? { system: pick("ps2") } : null;
      }
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
          const sg = withFile(files[0], sega);
          if (sg) return { system: pick(sg) };
          const id = withFile(files[0], discSystemId);
          if (id && /PLAYSTATION/.test(id)) return { system: pick(withFile(files[0], psGeneration) === "ps2" ? "ps2" : "ps1") };
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
  /** hints: a file's console, already known (from an earlier look), so it isn't read again */
  inspect(paths, hints = null) {
    const files = [], seen = new Set(), dirs = new Set();
    const add = p => { const k = pathKey(p); if (!seen.has(k) && files.length < MAX_FILES) { seen.add(k); files.push(p); } };
    const walk = (p, depth) => {
      if (files.length >= MAX_FILES) return;
      let st;
      try { st = fs.statSync(p); } catch { return; }
      if (st.isDirectory()) {
        if (depth > 6 || (depth > 0 && path.basename(p).startsWith("."))) return;
        // a folder reached twice (a link back up, a Wine drive pointing at the whole disk) is walked once
        let real = p; try { real = fs.realpathSync(p); } catch {}
        if (dirs.has(real)) return;
        dirs.add(real);
        let names = [];
        try { names = fs.readdirSync(p); } catch {}
        // macOS's leftovers (._Game.iso, .DS_Store) aren't games; hidden folders are skipped below. A game whose name
        // starts with a dot (.hack//Infection) is still one
        for (const n of names) if (!n.startsWith("._") && n !== ".DS_Store") walk(path.join(p, n), depth + 1);
      } else if (st.isFile()) add(p);
    };
    for (const p of paths) if (typeof p === "string" && p) walk(path.resolve(p), 0);

    // files a .cue/.gdi/.m3u points at travel with it instead of showing up on their own
    // (keyed as the disk compares names: a .cue saying "TRACK 01.BIN" owns "Track 01.bin")
    const owned = new Map(), own = (x, f) => { const k = pathKey(x); if (!owned.has(k)) owned.set(k, { x, owner: f }); };
    for (const f of files) {
      if (!SHEETS.includes(path.extname(f).toLowerCase())) continue;
      for (const x of sheetFiles(f)) {
        own(x, f);
        if (path.extname(x).toLowerCase() === ".cue") for (const y of sheetFiles(x)) own(y, f);
      }
    }
    // an .m3u wins over the discs it lists
    for (const v of owned.values()) { const up = path.extname(v.owner).toLowerCase() === ".cue" && owned.get(pathKey(v.owner)); if (up) v.owner = up.owner; }

    const items = [], unknown = [], stems = new Map(), bios = [];
    for (const f of files) {
      const ext = path.extname(f).toLowerCase(), name = path.basename(f);
      if (owned.has(pathKey(f)) && owned.get(pathKey(f)).owner !== f) continue;
      if (IMG.includes(ext)) continue;
      // a BIOS file (scph5501.bin, neogeo.zip…) goes to the BIOS folder, not onto a shelf
      const dest = biosDest(name, this.systems);
      if (dest) { bios.push({ src: f, name, dest }); continue; }
      // a BIOS known by what's in it, whatever its name (a PS2's)
      { let sz = 0; try { sz = fs.statSync(f).size; } catch {}
        const by = sz > 4194303 && biosByContent(f, sz, this.systems);
        if (by) { bios.push({ src: f, name, dest: by }); continue; } }
      const cands = this.byExt[ext];
      if (!cands) { if (!/^(readme|desktop\.ini|thumbs\.db)/i.test(name)) unknown.push(name); continue; }
      let size = 0;
      try { size = fs.statSync(f).size; } catch {}
      // an empty file (a download that never finished) isn't a game
      if (!size) { unknown.push(name); continue; }
      // a disc whose track files aren't there wouldn't play: said so, not added
      if (SHEETS.includes(ext)) {
        const gone = sheetFiles(f).find(x => !fs.existsSync(x));
        if (gone) { unknown.push(`${name} (${leaf(gone)} is missing)`); continue; }
      }
      const it = { id: crypto.createHash("sha1").update(f).digest("hex").slice(0, 12), src: f, name, ext, size, system: null, choices: cands, extras: [], makeCue: false };
      if (cands.length === 1) it.system = cands[0];
      else if (hints && hints[f] && cands.includes(hints[f])) it.system = hints[f];
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
        for (const { x, owner } of owned.values()) if (owner === f && fs.existsSync(x)) { it.extras.push(x); try { it.size += fs.statSync(x).size; } catch {} }
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
    // the files the game needs first, the game itself last: a copy that fails halfway leaves no game that looks whole
    const copies = [], moved = [];
    for (const x of it.extras) {
      let rel = path.relative(srcDir, x);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) { rel = path.basename(x); moved.push(x); }
      copies.push([x, path.join(base, rel)]);
    }
    copies.push([it.src, path.join(base, it.name)]);
    const cue = it.makeCue ? path.join(base, stem + ".cue") : null;
    // a disc list naming tracks outside its own folder ("../Tracks/x.bin") is rewritten to where they now are
    return { copies, cue, main: cue || copies[copies.length - 1][1], rewrite: moved.length > 0 && SHEETS.includes(it.ext) };
  }

  /** Copy planned items. onProgress({done, total, current}) after each game. Returns counts. */
  async copy(items, root, onProgress) {
    let added = 0, already = 0, failed = 0;
    const errors = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      onProgress({ done: i, total: items.length, current: it.name });
      const made = [];
      try {
        const { copies, cue, rewrite } = this.plan(it, root);
        let fresh = false;
        for (const [src, dest] of copies) {
          if (path.resolve(src) === path.resolve(dest)) continue;
          try { if (fs.statSync(dest).size === fs.statSync(src).size) continue; } catch {}
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          // clone where the disk supports it (instant on APFS), copy otherwise
          await fs.promises.copyFile(src, dest + ".part", fs.constants.COPYFILE_FICLONE);
          await fs.promises.rename(dest + ".part", dest);
          made.push(dest);
          fresh = true;
        }
        if (rewrite) {
          const dest = copies[copies.length - 1][1], text = fs.readFileSync(dest, "utf8");
          const fixed = text.split(/\r?\n/).map(line => {
            if (/^\s*FILE\s/i.test(line)) return line.replace(/^(\s*FILE\s+)(?:"([^"]+)"|(\S+))/i, (m, a, q, b) => `${a}"${leaf(q || b)}"`);
            if (path.extname(dest).toLowerCase() === ".m3u" && line.trim() && !line.trim().startsWith("#")) return leaf(line.trim());
            return line;
          }).join("\n");
          if (fixed !== text) fs.writeFileSync(dest, fixed);
        }
        if (cue && !fs.existsSync(cue)) {
          fs.writeFileSync(cue, `FILE "${it.name}" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`);
          fresh = true;
        }
        fresh ? added++ : already++;
      } catch (e) {
        // what this try copied goes again (copies only: the files dropped are untouched), so adding it again works
        for (const f of made) { try { fs.rmSync(f, { force: true }); } catch {} }
        failed++;
        errors.push(`${it.name}: ${e.code === "ENOSPC" ? "the disk is full" : e.message}`);
      }
    }
    onProgress({ done: items.length, total: items.length, current: "" });
    return { added, already, failed, errors };
  }
}

module.exports = { Importer, zipEntries, sheetFiles };
