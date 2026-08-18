// The .claude types beyond skills and agents, and the drift report that decides
// when /skill-graph:push has something to do.
//
// The table in scripts/claude-infra.json is read by three separate programs —
// the Python build, the Python scan, and the Node server. A copy in any one of
// them is how they come to disagree about where a command lives, and that
// disagreement is silent: the file lands, the scan does not find it, and the
// item reports as installed nowhere. So the first test here is that all three
// agree on disk, run against real files rather than asserted about.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFileSync } from "child_process";

const PLUGIN = resolve(import.meta.dir, "..");
const infra = require(join(PLUGIN, "server", "infra-types.js"));
const PY = require(join(PLUGIN, "server", "paths.js")).pythonBin();
const TABLE = JSON.parse(readFileSync(join(PLUGIN, "scripts", "claude-infra.json"), "utf-8"));

function fixture() {
  const w = realpathSync(mkdtempSync(join(tmpdir(), "sg-infra-")));
  const cat = join(w, "cat");
  for (const d of ["skills/deploy", "agents", "commands", "output-styles", "graph"]) {
    mkdirSync(join(cat, ".claude", d), { recursive: true });
  }
  writeFileSync(join(cat, ".claude", "skills", "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: Ship a release.\n---\nUse the shipper agent and the release command.\n");
  writeFileSync(join(cat, ".claude", "agents", "shipper.md"),
    "---\nname: shipper\ndescription: Runs releases.\n---\nCalls the release command.\n");
  // A command's frontmatter carries no `name:` — the filename is the name.
  writeFileSync(join(cat, ".claude", "commands", "release.md"),
    "---\ndescription: Cut a release and tag it\n---\nRun the deploy skill first.\n");
  writeFileSync(join(cat, ".claude", "output-styles", "terse.md"),
    "---\nname: terse\ndescription: Short answers only\n---\nBe brief.\n");
  const app = join(w, "app");
  mkdirSync(join(app, ".claude"), { recursive: true });
  writeFileSync(join(app, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(cat, ".claude", "graph", "config.json"), JSON.stringify({
    sources: TABLE.types.map((t) => ({ repo: "cat", root: `.claude/${t.installDir}`, kind: t.kind })),
    scanRoots: [w], scanExclude: [],
  }, null, 2));
  return { w, cat, app, graphDir: join(cat, ".claude", "graph") };
}

function build(f) {
  execFileSync(PY.cmd, [...PY.args, join(PLUGIN, "scripts", "build-graph.py"),
    join(f.graphDir, "config.json"), join(f.graphDir, "graph-data.json"), "--project-root", f.cat],
    { cwd: f.cat, stdio: "pipe" });
  execFileSync(PY.cmd, [...PY.args, join(PLUGIN, "scripts", "scan-project-usage.py"),
    join(f.graphDir, "graph-data.json"), "--config", join(f.graphDir, "config.json"), "--project-root", f.cat],
    { cwd: f.cat, stdio: "pipe" });
  return JSON.parse(readFileSync(join(f.graphDir, "graph-data.json"), "utf-8"));
}

test("every kind in the table is catalogued, with its kind as the node type", () => {
  const f = fixture();
  const g = build(f);
  const byType = Object.fromEntries(g.nodes.filter((n) => n.type !== "project" && n.type !== "claudemd")
    .map((n) => [n.type, n.id]));
  for (const t of TABLE.types) expect(byType[t.kind]).toBeDefined();
  expect(byType.command).toBe("cat:command:release"); // name from the filename, not frontmatter
  expect(byType["output-style"]).toBe("cat:output-style:terse");
  rmSync(f.w, { recursive: true, force: true });
});

test("references are counted across types, not only within one", () => {
  const f = fixture();
  const g = build(f);
  const edge = (a, b) => g.edges.some((e) => e.from.endsWith(a) && e.to.endsWith(b));
  expect(edge("skill:deploy", "command:release")).toBe(true);
  expect(edge("command:release", "skill:deploy")).toBe(true);
  expect(edge("agent:shipper", "command:release")).toBe(true);
  rmSync(f.w, { recursive: true, force: true });
});

test("an unknown kind is refused, rather than silently walked as a skill", () => {
  const f = fixture();
  writeFileSync(join(f.graphDir, "config.json"), JSON.stringify({
    sources: [{ repo: "cat", root: ".claude/commands", kind: "commands" }], // plural typo
    scanRoots: [], scanExclude: [],
  }));
  let failed = false, msg = "";
  try {
    execFileSync(PY.cmd, [...PY.args, join(PLUGIN, "scripts", "build-graph.py"),
      join(f.graphDir, "config.json"), join(f.graphDir, "g.json"), "--project-root", f.cat],
      { cwd: f.cat, stdio: "pipe" });
  } catch (e) { failed = true; msg = String(e.stderr); }
  expect(failed).toBe(true);
  expect(msg).toContain("unknown kind");
  rmSync(f.w, { recursive: true, force: true });
});

test("each kind installs where the scanner looks for it", () => {
  const f = fixture();
  build(f);
  const installer = require(join(PLUGIN, "server", "skill-installer.js"));
  const q = { resolveNode: (g, n) => ({ node: g.data.nodes.find((x) => x.name === n) }) };
  const g = { data: JSON.parse(readFileSync(join(f.graphDir, "graph-data.json"), "utf-8")) };
  g.data.sourceRoot = f.cat;
  process.env.GRAPH_DATA_DIR = f.graphDir;

  for (const [name, rel] of [["release", "commands/release.md"], ["terse", "output-styles/terse.md"],
                             ["deploy", "skills/deploy/SKILL.md"], ["shipper", "agents/shipper.md"]]) {
    const r = installer.installSkill(g, q, name, "app");
    expect(r.ok).toBe(true);
    // isFile, not existsSync. The bug this covers copied a command as a
    // DIRECTORY — commands/release.md/release.md — and existsSync is true for
    // a directory, so it passed while the scanner found nothing.
    const at = join(f.app, ".claude", rel);
    expect(existsSync(at)).toBe(true);
    expect(statSync(at).isFile()).toBe(true);
  }
  const g2 = { data: JSON.parse(readFileSync(join(f.graphDir, "graph-data.json"), "utf-8")) };
  const app = g2.data.nodes.find((n) => n.type === "project" && n.name === "app");
  expect(app).toBeDefined();
  rmSync(f.w, { recursive: true, force: true });
});

