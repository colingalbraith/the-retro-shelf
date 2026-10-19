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
  onMenu: fn => ipcRenderer.on("menu", (_, what) => fn(what)),
});
