// Mac builds are made separately for Apple silicon and Intel. The bundled RetroArch and cores are universal (both
// kinds of code in each file); this keeps only the half each build runs, which roughly halves the download.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// electron-builder's Arch enum, as ditto names the architectures
const ARCH = { 1: "x86_64", 3: "arm64" };

exports.default = async ctx => {
  const arch = ARCH[ctx.arch];
  if (ctx.electronPlatformName !== "darwin" || !arch) return;
  const emu = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + ".app", "Contents", "Resources", "emulators");
  if (!fs.existsSync(emu)) return;
  const thin = emu + ".thin";
  fs.rmSync(thin, { recursive: true, force: true });
  execFileSync("ditto", ["--arch", arch, emu, thin]);
  fs.rmSync(emu, { recursive: true, force: true });
  fs.renameSync(thin, emu);
};
