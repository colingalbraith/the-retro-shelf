"use strict";
// The few things the shelf page needs from the app that a web page can't do on its own.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("arcade", {
  platform: process.platform,
  pathFor: file => { try { return webUtils.getPathForFile(file); } catch { return ""; } },
  pickGames: () => ipcRenderer.invoke("pick-games"),
  openFolder: which => ipcRenderer.invoke("open-folder", which),
  licenses: () => ipcRenderer.invoke("licenses"),
  openUrl: url => ipcRenderer.invoke("open-url", url),
  revealGame: id => ipcRenderer.invoke("reveal-game", id),
  gameMenu: id => ipcRenderer.invoke("game-menu", id),
  update: what => ipcRenderer.invoke("update", what),
  backupSaves: quick => ipcRenderer.invoke("backup-saves", !!quick),
  watchFolder: () => ipcRenderer.invoke("watch-folder"),
  exportSaves: (id, quick) => ipcRenderer.invoke("export-saves", id, !!quick),
  exportList: quick => ipcRenderer.invoke("export-list", !!quick),
  loginItem: on => ipcRenderer.invoke("login-item", on),
  backupFolder: () => ipcRenderer.invoke("backup-folder"),
  moveSaves: home => ipcRenderer.invoke("move-saves", !!home),
  moveLibrary: () => ipcRenderer.invoke("move-library"),
  restoreSaves: () => ipcRenderer.invoke("restore-saves"),
  copyReport: () => ipcRenderer.invoke("copy-report"),
  savePicture: (rect, name, quick) => ipcRenderer.invoke("save-picture", rect, String(name || ""), !!quick),
  tvMode: (on, size) => ipcRenderer.invoke("tv-mode", !!on, Number(size) || 100),
  setLang: code => ipcRenderer.invoke("lang", String(code || "auto")),
  textSize: (tv, size) => ipcRenderer.invoke("text-size", !!tv, Number(size) || 100),
  onMenu: fn => ipcRenderer.on("menu", (_, what) => fn(what)),
});
