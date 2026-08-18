#!/usr/bin/env node
// Serves the graph viewer at http://127.0.0.1:<port> so it can be opened in a
// browser instead of Electron.
//
// This exists because the desktop app costs a ~280 MB `npm install` written
// into the plugin directory — which paths.js declares is wiped on every
// reinstall. Node is already a hard requirement (the MCP server runs on it),
// so a viewer built on node:http costs nothing extra to install.
//
// It is not a degraded preview. The renderer touches the outside world in
// exactly four places (loadGraph / rateNode / addNote / revealFile), and a
// process on localhost can serve all four — including the two writes and the
// file-manager reveal that a plain `file://` page could never do. The writes
// go to the same overlay.json the MCP server reads, via the same functions it
// calls, so a rating added in the browser is visible to `get_node` and
// survives a rebuild.
//
// Usage:
//   node server/viewer-server.js [--data-dir DIR] [--port N] [--no-open]
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const paths = require("./paths.js");
const overlay = require("./graph-overlay.js");

// --- arguments -------------------------------------------------------------
// --data-dir is turned into GRAPH_DATA_DIR rather than kept as a local, so
// paths.js remains the single place that decides where a project's data lives.
// Everything downstream (overlayPath, dataPath) then agrees automatically.
function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const dataDirArg = arg("--data-dir");
if (dataDirArg) process.env.GRAPH_DATA_DIR = path.resolve(dataDirArg);

const PORT_ARG = Number(arg("--port")) || 0;
const NO_OPEN = process.argv.includes("--no-open");
const DEFAULT_PORT = 7317;

const APP_DIR = paths.appDir();

// --- preconditions ---------------------------------------------------------
// Checked before binding a port, so a missing graph is a clear message on the
// terminal the user is already looking at rather than an empty window they
// have to interpret. The desktop app's silent fallback to its own bundled
// data/ folder is exactly the failure this avoids.
function preflight() {
  const dataPath = paths.dataPath();
  if (!fs.existsSync(dataPath)) {
    console.error(`No graph found at ${dataPath}`);
    console.error("Run /skill-graph:build to create one (or /skill-graph:setup first if this project has no config.json yet).");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(APP_DIR, "index.html"))) {
    console.error(`Viewer files not found at ${APP_DIR}. The plugin install looks incomplete.`);
    process.exit(1);
  }
  return dataPath;
}

// --- static files ----------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
};

// Resolve first, then confirm the result is still inside APP_DIR. Checking the
// raw URL for ".." is not enough — encodings and symlinks both get past that,
// and this process can read anything the user can.
function staticFile(urlPath) {
  const rel = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "") || "index.html";
  const abs = path.resolve(APP_DIR, rel);
  const within = abs === APP_DIR || abs.startsWith(APP_DIR + path.sep);
  if (!within) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}

// --- responses -------------------------------------------------------------
function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    // A viewer request is a note or a rating; anything past 1 MB is not one of
    // those, and an unbounded read on a localhost socket is a trivial way to
    // exhaust memory.
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) { reject(new Error("request body too large")); req.destroy(); }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}

// --- API -------------------------------------------------------------------
// Each handler delegates to graph-overlay.js — the same module the MCP server
// calls. Reimplementing the merge here is what produced three divergent copies
// of applyOverlay in the first place.
const REVEAL = {
  darwin: (abs) => ["open", ["-R", abs]],
  win32: (abs) => ["explorer", [`/select,${abs}`]],
  linux: (abs) => ["xdg-open", [path.dirname(abs)]],
};

async function api(req, res, route) {
  if (route === "/api/graph" && req.method === "GET") {
    const data = overlay.applyOverlay(JSON.parse(fs.readFileSync(paths.dataPath(), "utf-8")));
    return sendJSON(res, 200, data);
  }

  // The renderer expects { ok, notes } / { ok, avgRating, ratings } — it
  // re-renders the detail panel straight from them (renderer.js:912, :922).
  // graph-overlay.js returns just the appended entry, so the full list is read
  // back rather than reconstructed, keeping this the only place that knows the
  // difference.
  if (route === "/api/note" && req.method === "POST") {
    const { nodeId, text } = await readBody(req);
    if (!nodeId || !text || !String(text).trim()) return sendJSON(res, 400, { error: "nodeId and a non-empty text are required" });
    const result = overlay.addNote(nodeId, String(text).trim());
    if (result.error) return sendJSON(res, 400, result);
    return sendJSON(res, 200, { ok: true, notes: overlay.loadOverlay().notes[nodeId] || [] });
  }

  if (route === "/api/rate" && req.method === "POST") {
    const { nodeId, rating, note } = await readBody(req);
    if (!nodeId || typeof rating !== "number") return sendJSON(res, 400, { error: "nodeId and a numeric rating are required" });
    const result = overlay.addRating(nodeId, rating, note);
    if (result.error) return sendJSON(res, 400, result);
    return sendJSON(res, 200, { ok: true, avgRating: result.avgRating, ratings: overlay.loadOverlay().ratings[nodeId] || [] });
  }

  if (route === "/api/reveal" && req.method === "POST") {
    const { path: relPath } = await readBody(req);
    if (!relPath) return sendJSON(res, 400, { error: "path is required" });
    const data = JSON.parse(fs.readFileSync(paths.dataPath(), "utf-8"));
    const abs = path.isAbsolute(relPath) ? relPath : path.join(data.sourceRoot || "", relPath);
    const build = REVEAL[process.platform];
    if (!build) return sendJSON(res, 200, { ok: false, path: abs, reason: `revealing a file is not supported on ${process.platform}` });
    const [cmd, args] = build(abs);
    return execFile(cmd, args, (err) => sendJSON(res, 200, err ? { ok: false, path: abs, reason: String(err) } : { ok: true, path: abs }));
  }

  return sendJSON(res, 404, { error: `no such endpoint: ${req.method} ${route}` });
}

// --- server ----------------------------------------------------------------
const server = http.createServer((req, res) => {
  const route = req.url.split("?")[0];

  if (route.startsWith("/api/")) {
    api(req, res, route).catch((e) => sendJSON(res, 400, { error: String(e.message || e) }));
    return;
  }

  const file = staticFile(req.url);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("not found");
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
});

function openBrowser(url) {
  const OPEN = { darwin: ["open", [url]], win32: ["cmd", ["/c", "start", "", url]], linux: ["xdg-open", [url]] };
  const cmd = OPEN[process.platform];
  if (!cmd) return;
  execFile(cmd[0], cmd[1], () => {}); // best effort — the URL is printed regardless
}

// Bind to 127.0.0.1 explicitly, never 0.0.0.0. This process reads files and
// runs a file-manager command on request; it has no business being reachable
// from anything but this machine.
function listen(port, attemptsLeft) {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && attemptsLeft > 0) return listen(port + 1, attemptsLeft - 1);
    console.error(`Could not start the viewer: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    console.log(`Skill Graph viewer: ${url}`);
    console.log(`Showing: ${paths.dataDir()}`);
    console.log("Press Ctrl-C to stop.");
    if (!NO_OPEN) openBrowser(url);
  });
}

if (require.main === module) {
  preflight();
  listen(PORT_ARG || DEFAULT_PORT, PORT_ARG ? 0 : 20);
}

module.exports = { server, staticFile, APP_DIR };
