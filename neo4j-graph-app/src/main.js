const { app, BrowserWindow, Menu, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const dataPath = path.join(__dirname, "..", "data", "graph-data.json");
const overlayPath = path.join(__dirname, "..", "data", "overlay.json");
// Mirrors ../../graph-overlay.js's applyOverlay() — duplicated inline
// rather than required, because electron-packager only bundles
// neo4j-graph-app/ itself into the .app; graph-overlay.js lives one level up
// (a sibling shared with graph-mcp-server, which is never packaged and can
// require it directly). A cross-boundary require() here throws
// "Cannot find module" in the packaged app specifically — it worked in dev
// only because dev mode runs from the real, unpackaged source tree where
// that file actually exists at the expected relative path. Keep this in
// sync with graph-overlay.js's applyOverlay() and web-shim.js's copy if
// either changes.
function loadOverlay() {
  if (!fs.existsSync(overlayPath)) return { notes: {}, customEdges: [], ratings: {}, importedNodes: [], categoryOverrides: {}, tags: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(overlayPath, "utf-8"));
    return {
      notes: raw.notes || {}, customEdges: raw.customEdges || [], ratings: raw.ratings || {},
      importedNodes: raw.importedNodes || [], categoryOverrides: raw.categoryOverrides || {},
      tags: raw.tags || {},
    };
  } catch {
    return { notes: {}, customEdges: [], ratings: {}, importedNodes: [], categoryOverrides: {}, tags: {} };
  }
}
// Notes, ratings, category overrides, tags, custom edges, and skills/agents
// imported from external repos (via add_repo) all live in a separate
// overlay file, not in graph-data.json itself — merged in here so anything
// Claude Code added shows up in the desktop app too, without graph-data.json
// ever needing to be hand-edited or regen-unsafe.
// A fresh clone has no data/graph-data.json until the setup scripts are run
// (see README) — load with empty:true rather than crashing, so the window
// still opens and can show real setup instructions instead of a blank
// Electron error screen.
const graphData = (() => {
  if (!fs.existsSync(dataPath)) return { nodes: [], edges: [], sourceRoot: "", empty: true };
  const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  const overlay = loadOverlay();
  data.nodes.push(...overlay.importedNodes);
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  data.nodes.forEach((n) => {
    n.notes = overlay.notes[n.id] || [];
    const ratings = overlay.ratings[n.id] || [];
    n.ratings = ratings;
    n.avgRating = ratings.length ? Math.round((ratings.reduce((s, r) => s + r.rating, 0) / ratings.length) * 10) / 10 : null;
    if (overlay.categoryOverrides[n.id]) n.category = overlay.categoryOverrides[n.id];
    n.tags = overlay.tags[n.id] || [];
  });
  overlay.customEdges.forEach((e) => {
    if (byId.has(e.from) && byId.has(e.to)) {
      data.edges.push({ from: e.from, to: e.to, weight: e.weight || 1, kind: "custom", label: e.label });
    }
  });
  return data;
})();
const byId = new Map(graphData.nodes.map((n) => [n.id, n]));
ipcMain.handle("load-graph", () => graphData);

// Real writes, not a mock — same overlay.json the MCP server writes to, so a
// rating/note added here shows up in get_node from any Claude Code session
// too. Inline read+write (not required from graph-overlay.js) for the same
// packaging-boundary reason loadOverlay() above is inlined: electron-packager
// only bundles neo4j-graph-app/ itself, and graph-overlay.js lives one level
// up. Keep in sync with graph-overlay.js's addRating/addNote if either changes.
function loadOverlayRaw() {
  if (!fs.existsSync(overlayPath)) return { notes: {}, customEdges: [], ratings: {}, importedRepos: [], importedNodes: [], categoryOverrides: {}, tags: {} };
  try {
    return JSON.parse(fs.readFileSync(overlayPath, "utf-8"));
  } catch {
    return { notes: {}, customEdges: [], ratings: {}, importedRepos: [], importedNodes: [], categoryOverrides: {}, tags: {} };
  }
}
function saveOverlayRaw(raw) {
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  fs.writeFileSync(overlayPath, JSON.stringify(raw, null, 2));
}

ipcMain.handle("rate-node", (event, nodeId, rating) => {
  const r = Math.round(rating);
  if (r < 1 || r > 5) return { error: `rating must be 1-5` };
  const raw = loadOverlayRaw();
  if (!raw.ratings) raw.ratings = {};
  if (!raw.ratings[nodeId]) raw.ratings[nodeId] = [];
  raw.ratings[nodeId].push({ rating: r, note: "", at: new Date().toISOString().slice(0, 10) });
  saveOverlayRaw(raw);
  const all = raw.ratings[nodeId];
  const avgRating = Math.round((all.reduce((s, x) => s + x.rating, 0) / all.length) * 10) / 10;
  // keep the in-memory cache in sync so the rest of this session (a re-opened
  // detail panel, another node's "referencedBy" list) sees it immediately —
  // load-graph only re-reads graph-data.json + overlay.json on app restart.
  const node = byId.get(nodeId);
  if (node) { node.ratings = all; node.avgRating = avgRating; }
  return { ok: true, ratings: all, avgRating };
});

ipcMain.handle("add-note", (event, nodeId, text) => {
  if (!text || !text.trim()) return { error: "empty note" };
  const raw = loadOverlayRaw();
  if (!raw.notes) raw.notes = {};
  if (!raw.notes[nodeId]) raw.notes[nodeId] = [];
  raw.notes[nodeId].push({ text: text.trim(), at: new Date().toISOString().slice(0, 10) });
  saveOverlayRaw(raw);
  const node = byId.get(nodeId);
  if (node) node.notes = raw.notes[nodeId];
  return { ok: true, notes: raw.notes[nodeId] };
});

// Skill/agent node.path values are relative to the repo root build-graph.py
// was run from — resolve against sourceRoot, recorded by build-graph.py at
// build time, NOT against this app's own __dirname. Packaging only bundles
// neo4j-graph-app/ itself; the real source repos listed in sources.json stay
// wherever they were on disk, outside the .app bundle, so a bundle-relative
// path can never find them (confirmed: this broke exactly that way on first
// packaged-app test).
// Project node.path values are already absolute (scan-project-usage.py
// records each project's own real location directly, since those live
// outside the source repos entirely — sourceRoot-relative resolution would
// be wrong for them by construction) and point at a directory, not a file,
// so they open with openPath rather than showItemInFolder.
ipcMain.handle("reveal-file", (event, relPath) => {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(graphData.sourceRoot || "", relPath);
  if (!fs.existsSync(abs)) return { ok: false, reason: `not found: ${abs}` };
  if (fs.statSync(abs).isDirectory()) {
    shell.openPath(abs);
    return { ok: true, path: abs };
  }
  shell.showItemInFolder(abs);
  return { ok: true, path: abs };
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0B0D0B",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "..", "index.html"));
  win.webContents.on("console-message", (e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on("did-fail-load", (e, code, desc) => console.log("[did-fail-load]", code, desc));
  win.webContents.on("render-process-gone", (e, details) => console.log("[render-process-gone]", details));
  win.webContents.on("preload-error", (e, preloadPath, error) => console.log("[preload-error]", preloadPath, error));
  return win;
}

const isMac = process.platform === "darwin";
const menuTemplate = [
  ...(isMac ? [{
    label: app.name,
    submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  }] : []),
  {
    label: "Edit",
    submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ],
  },
  {
    label: "View",
    submenu: [
      { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      { type: "separator" }, { role: "togglefullscreen" },
    ],
  },
  { role: "windowMenu" },
  {
    label: "Help",
    submenu: [
      {
        label: "View README",
        click: () => shell.openPath(path.join(__dirname, "..", "..", "README.md")),
      },
    ],
  },
];

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});
