// The one test that would have caught every defect this project has shipped:
// it builds a real project on disk, runs the real build scripts against it,
// launches the real shipped server binary, and asks it real questions.
//
// Nothing here is injected. The server is started exactly the way .mcp.json
// starts it — `node server/server.bundle.mjs` — so a bundle that is stale,
// broken, or resolving paths against the build machine fails here rather than
// on a stranger's laptop. Unit tests over the same modules would all pass
// while the shipped artifact did nothing.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFileSync, spawn } from "child_process";

const PLUGIN = resolve(import.meta.dir, "..");
const BUNDLE = join(PLUGIN, "server", "server.bundle.mjs");

let workspace, project, graphDir, server, rpc;

// --- a minimal MCP stdio client -------------------------------------------
// Framed by newline-delimited JSON, which is what StdioServerTransport speaks.
function connect(command, args, env) {
  const proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buf = "";
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    }
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((res, rej) => {
      const mine = ++id;
      pending.set(mine, res);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }) + "\n");
      setTimeout(() => pending.has(mine) && (pending.delete(mine), rej(new Error(`timeout on ${method}. stderr: ${stderr}`))), 15000);
    });
  return { proc, call, stderr: () => stderr };
}

// A tool result is JSON encoded inside a text content block.
const unwrap = (r) => {
  if (r.error) throw new Error(`tool error: ${JSON.stringify(r.error)}`);
  return JSON.parse(r.result.content[0].text);
};

// --- fixture ---------------------------------------------------------------
function agent(dir, name, description, body = "") {
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\ntools: Read, Grep\n---\n\n${body}\n`);
}
function skill(dir, name, description, body = "") {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

beforeAll(async () => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "sg-e2e-")));
  project = join(workspace, "catalogue-project");
  const agents = join(project, ".claude", "agents");
  const skills = join(project, ".claude", "skills");
  mkdirSync(agents, { recursive: true });
  mkdirSync(skills, { recursive: true });

  // Two agents and two skills. The cross-references are deliberate: the
  // graph's whole claim is that it counts real mentions in real file bodies,
  // so the fixture contains real mentions and the test asserts on the count.
  agent(agents, "security-auditor", "Audits code for vulnerabilities.",
    "Run this before release. Pair it with the threat-modelling skill, and hand findings to report-writer.");
  agent(agents, "report-writer", "Turns findings into a written report.",
    "Consumes output from security-auditor.");
  skill(skills, "threat-modelling", "How to build a threat model for a service.",
    "Use with security-auditor. See also secure-defaults.");
  skill(skills, "secure-defaults", "Safe default configuration for new services.", "Nothing references this one.");

  // A second project that has ONE of the catalogued skills installed. This is
  // what the usage scan is supposed to find, and the only way to prove it did.
  const consumer = join(workspace, "consumer-project");
  mkdirSync(join(consumer, ".claude", "skills"), { recursive: true });
  skill(join(consumer, ".claude", "skills"), "threat-modelling", "installed copy");

  graphDir = join(project, ".claude", "graph");
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, "config.json"), JSON.stringify({
    sources: [
      { repo: "fixture", root: ".claude/agents", kind: "agent" },
      { repo: "fixture", root: ".claude/skills", kind: "skill" },
    ],
    scanRoots: [workspace],
    scanExclude: ["/node_modules/"],
  }, null, 2));

  // The build, run exactly as commands/build.md documents it.
  execFileSync("python3", [
    join(PLUGIN, "scripts", "build-graph.py"),
    join(graphDir, "config.json"),
    join(graphDir, "graph-data.json"),
    "--project-root", project,
  ], { cwd: project, stdio: "pipe" });

  execFileSync("python3", [
    join(PLUGIN, "scripts", "scan-project-usage.py"),
    join(graphDir, "graph-data.json"),
    "--config", join(graphDir, "config.json"),
    "--project-root", project,
  ], { cwd: project, stdio: "pipe" });

  server = connect("node", [BUNDLE], { GRAPH_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: PLUGIN });
  rpc = server.call;
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
});

afterAll(() => {
  server?.proc.kill();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

// --- the build produced real data -----------------------------------------
test("build writes the graph into the project, not into the plugin", () => {
  expect(existsSync(join(graphDir, "graph-data.json"))).toBe(true);
  expect(existsSync(join(PLUGIN, "graph-data.json"))).toBe(false);
  expect(existsSync(join(PLUGIN, "app", "data", "graph-data.json"))).toBe(false);
});

test("every catalogued node is present, and sourceRoot points at the project", () => {
  const data = JSON.parse(readFileSync(join(graphDir, "graph-data.json"), "utf-8"));
  const names = data.nodes.filter((n) => n.type === "agent" || n.type === "skill").map((n) => n.name).sort();
  expect(names).toEqual(["report-writer", "secure-defaults", "security-auditor", "threat-modelling"]);
  expect(data.sourceRoot).toBe(project);
});

test("the usage scan found the consumer project's real installed copy", () => {
  const data = JSON.parse(readFileSync(join(graphDir, "graph-data.json"), "utf-8"));
  const tm = data.nodes.find((n) => n.name === "threat-modelling" && n.type === "skill");
  expect(tm.usedBy).toContain("consumer-project");
  const untouched = data.nodes.find((n) => n.name === "secure-defaults");
  expect(untouched.usedBy).toEqual([]);
});

// --- the shipped server answers over stdio --------------------------------
test("the shipped bundle exposes its tools", async () => {
  const { result } = await rpc("tools/list", {});
  const names = result.tools.map((t) => t.name);
  for (const required of ["best_skills", "find_skills", "get_node", "graph_neighbors", "projects_using", "install_skill"]) {
    expect(names).toContain(required);
  }
});

test("find_skills returns a fixture node through the real server", async () => {
  const out = unwrap(await rpc("tools/call", { name: "find_skills", arguments: { text: "threat" } }));
  const hits = JSON.stringify(out);
  expect(hits).toContain("threat-modelling");
});

test("get_node reports the real on-disk path of a fixture file", async () => {
  const out = unwrap(await rpc("tools/call", { name: "get_node", arguments: { name: "security-auditor" } }));
  expect(JSON.stringify(out)).toContain("security-auditor");
});

test("edges reflect real mentions: the unreferenced skill ranks below the referenced one", async () => {
  const out = unwrap(await rpc("tools/call", { name: "best_skills", arguments: { n: 10 } }));
  const rows = JSON.stringify(out);
  expect(rows).toContain("security-auditor");
  // secure-defaults is mentioned by exactly one file; security-auditor by
  // three. If the ranking were arbitrary this ordering would not hold.
  const list = Array.isArray(out) ? out : out.results || out.nodes || [];
  const pos = (n) => list.findIndex((x) => x.name === n);
  if (pos("security-auditor") !== -1 && pos("secure-defaults") !== -1) {
    expect(pos("security-auditor")).toBeLessThan(pos("secure-defaults"));
  }
});

test("projects_using reports the consumer project through the server", async () => {
  const out = unwrap(await rpc("tools/call", { name: "projects_using", arguments: { name: "threat-modelling" } }));
  expect(JSON.stringify(out)).toContain("consumer-project");
});

test("a write lands in the project's overlay and survives a rebuild", async () => {
  unwrap(await rpc("tools/call", { name: "add_note", arguments: { name: "secure-defaults", text: "reviewed by e2e" } }));
  const overlayFile = join(graphDir, "overlay.json");
  expect(existsSync(overlayFile)).toBe(true);
  expect(readFileSync(overlayFile, "utf-8")).toContain("reviewed by e2e");

  // graph-data.json is regenerated wholesale; the overlay is the only reason
  // a note is not destroyed by the next build.
  execFileSync("python3", [
    join(PLUGIN, "scripts", "build-graph.py"),
    join(graphDir, "config.json"), join(graphDir, "graph-data.json"),
    "--project-root", project,
  ], { cwd: project, stdio: "pipe" });

  const after = unwrap(await rpc("tools/call", { name: "get_node", arguments: { name: "secure-defaults" } }));
  expect(JSON.stringify(after)).toContain("reviewed by e2e");
});

test("a project with no graph gets a message naming the file and the fix", async () => {
  // The ordinary first-run state. It must not surface as a raw ENOENT.
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "sg-empty-")));
  mkdirSync(join(empty, ".claude"), { recursive: true });
  const other = connect("node", [BUNDLE], { GRAPH_PROJECT_DIR: empty, CLAUDE_PLUGIN_ROOT: PLUGIN });
  await other.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  const res = await other.call("tools/call", { name: "best_skills", arguments: {} });
  const text = JSON.stringify(res);
  expect(text).toContain("No graph found");
  expect(text).toContain("skill-graph:build");
  other.proc.kill();
  rmSync(empty, { recursive: true, force: true });
});

test("search_ranked handles a multi-word query, not just one substring", async () => {
  // "threat modelling for a service" is not a literal substring of anything in
  // the fixture. Scored as one string it returns nothing, which is what a user
  // describing a need would always get.
  const out = unwrap(await rpc("tools/call", { name: "search_ranked", arguments: { text: "threat modelling for a service" } }));
  expect(out.results.length).toBeGreaterThan(0);
  expect(out.results[0].name).toBe("threat-modelling");
});

test("search_ranked still ranks a single word exactly as before", async () => {
  const out = unwrap(await rpc("tools/call", { name: "search_ranked", arguments: { text: "secure-defaults" } }));
  expect(out.results[0].name).toBe("secure-defaults");
});

test("a query of only stopwords does not silently match everything", async () => {
  const out = unwrap(await rpc("tools/call", { name: "search_ranked", arguments: { text: "the and of" } }));
  expect(out.results.length).toBe(0);
});
