// The browser viewer, exercised the way a browser exercises it: a real server
// process on a real port, answering real HTTP.
//
// The claim this file has to defend is parity — that browser mode is not a
// read-only preview. So it does not stop at "the page loads". It writes a note
// and a rating over HTTP and then reads them back out of the project's
// overlay.json on disk, which is the same file the MCP server reads. If the
// viewer ever regresses to client-side stubs, or starts writing somewhere of
// its own, these assertions fail.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawn, spawnSync } from "child_process";

const PLUGIN = resolve(import.meta.dir, "..");
const VIEWER = join(PLUGIN, "server", "viewer-server.js");

let workspace, graphDir, proc, base;

const NODE_ID = "demo:skill:alpha";

// A graph small enough to assert on exactly, in the shape build-graph.py emits.
const GRAPH = {
  sourceRoot: "/nonexistent-source-root",
  nodes: [
    { id: NODE_ID, name: "alpha", type: "skill", repo: "demo", category: "general", path: "alpha/SKILL.md", description: "first" },
    { id: "demo:skill:beta", name: "beta", type: "skill", repo: "demo", category: "general", path: "beta/SKILL.md", description: "second" },
  ],
  edges: [{ from: NODE_ID, to: "demo:skill:beta", weight: 1, kind: "ref" }],
};

function get(path) {
  return fetch(base + path);
}
function post(path, body) {
  return fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const overlayOnDisk = () => JSON.parse(readFileSync(join(graphDir, "overlay.json"), "utf-8"));

beforeAll(async () => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "sg-viewer-")));
  graphDir = join(workspace, ".claude", "graph");
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, "graph-data.json"), JSON.stringify(GRAPH));

  // Port 0 is not used — the server picks its own and prints it, and reading
  // the printed URL is exactly what commands/view.md tells the model to do.
  // Parsing it here means the test fails if that contract ever breaks.
  proc = spawn("node", [VIEWER, "--data-dir", graphDir, "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
  base = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`viewer did not print a URL. stdout: ${out}`)), 10000);
    proc.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`viewer exited early with ${code}`)); });
  });
});

afterAll(() => {
  if (proc) proc.kill();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

test("binds loopback, not a public interface", () => {
  expect(base.startsWith("http://127.0.0.1:")).toBe(true);
});

test("serves the graph the project actually built", async () => {
  const data = await (await get("/api/graph")).json();
  expect(data.nodes.map((n) => n.id).sort()).toEqual(["demo:skill:alpha", "demo:skill:beta"]);
  expect(data.edges).toHaveLength(1);
});

test("serves the viewer page and its assets", async () => {
  const page = await get("/");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toContain("<title>Skill Graph</title>");

  const script = await get("/src/web-shim.js");
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toContain("javascript");
});

// The server can read anything the user can, so a path that resolves outside
// app/ has to be refused however it is spelled — not just when it contains a
// literal "..".
test("refuses to serve files outside the app directory", async () => {
  for (const attack of ["/../../server/paths.js", "/%2e%2e%2f%2e%2e%2fserver%2fpaths.js", "/../.claude-plugin/plugin.json"]) {
    expect((await get(attack)).status).toBe(404);
  }
});

test("a note written over HTTP lands in the project's overlay.json", async () => {
  const res = await post("/api/note", { nodeId: NODE_ID, text: "from the browser" });
  const body = await res.json();
  // The renderer re-renders straight from this shape (renderer.js:922).
  expect(body.ok).toBe(true);
  expect(body.notes.at(-1).text).toBe("from the browser");
  expect(overlayOnDisk().notes[NODE_ID].at(-1).text).toBe("from the browser");
});

test("a rating written over HTTP lands in the project's overlay.json", async () => {
  const body = await (await post("/api/rate", { nodeId: NODE_ID, rating: 4 })).json();
  expect(body.ok).toBe(true);
  expect(body.avgRating).toBe(4);
  expect(body.ratings.at(-1).rating).toBe(4);
  expect(overlayOnDisk().ratings[NODE_ID].at(-1).rating).toBe(4);
});

test("rejects bad writes instead of storing them", async () => {
  const outOfRange = await post("/api/rate", { nodeId: NODE_ID, rating: 9 });
  expect(outOfRange.status).toBe(400);
  expect((await outOfRange.json()).error).toContain("1-5");

  const blank = await post("/api/note", { nodeId: NODE_ID, text: "   " });
  expect(blank.status).toBe(400);

  const notJSON = await fetch(base + "/api/note", { method: "POST", body: "{oops" });
  expect(notJSON.status).toBe(400);

  // Nothing above should have been written.
  const overlay = overlayOnDisk();
  expect(overlay.ratings[NODE_ID]).toHaveLength(1);
  expect(overlay.notes[NODE_ID]).toHaveLength(1);
});

test("unknown endpoints answer 404 rather than falling through to a file", async () => {
  expect((await get("/api/nope")).status).toBe(404);
});

// The desktop app used to start with no data directory and silently write
// ratings into the plugin folder. The viewer must refuse instead, and say
// which command fixes it.
test("refuses to start when the project has no graph yet", () => {
  const empty = mkdtempSync(join(tmpdir(), "sg-viewer-empty-"));
  const r = spawnSync("node", [VIEWER, "--data-dir", empty, "--no-open"], { encoding: "utf-8", timeout: 10000 });
  rmSync(empty, { recursive: true, force: true });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("No graph found");
  expect(r.stderr).toContain("skill-graph:build");
});
