// Four defects found by driving the shipped pipeline end to end — install,
// build, query, install-into-a-project, uninstall, import, push — against a
// throwaway catalogue. Each was invisible to the existing suite because each
// sits at a seam between two components that are individually correct:
//
//   1. add_repo read only .claude/agents and .claude/skills, while every other
//      part of the pipeline had moved to the claude-infra.json table. A repo
//      holding only commands imported as "nothing found" and had its clone
//      deleted.
//   2. remove_repo's default leaves the clone on disk, and add_repo then
//      refused the label forever: "remove_repo first" was advice remove_repo
//      could no longer take. Only a manual rm escaped.
//   3. uninstalling the last item pruned the project's own .claude directory,
//      and the usage scanner finds projects BY that directory — so the project
//      vanished from the graph and the next call blamed the wrong thing.
//   4. the usage scanner counted the catalogue's own imported clones as the
//      user's projects, because a clone carries a .claude/ of its own.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFileSync } from "child_process";

const PLUGIN = resolve(import.meta.dir, "..");
const BUILD = join(PLUGIN, "scripts", "build-graph.py");
const SCAN = join(PLUGIN, "scripts", "scan-project-usage.py");
const PY = require(resolve(PLUGIN, "server", "paths.js")).pythonBin();

let workspace, catalogue, consumer, graphDir;

function writeSkill(dir, name) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} does a thing\n---\n\nbody\n`);
}
function writeFlat(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${name} does a thing\n---\n\nbody\n`);
}

// Required fresh per call: these modules resolve paths.js at call time, and the
// env var below is what points them at this test's catalogue rather than the
// developer's own.
function mod(file) {
  process.env.GRAPH_DATA_DIR = graphDir;
  return require(join(PLUGIN, "server", file));
}

function build() {
  execFileSync(PY.cmd, [...PY.args, BUILD, join(graphDir, "config.json"), join(graphDir, "graph-data.json"),
    "--project-root", workspace], { stdio: "pipe" });
}
function scan() {
  return execFileSync(PY.cmd, [...PY.args, SCAN, join(graphDir, "graph-data.json"),
    "--config", join(graphDir, "config.json"), "--project-root", workspace], { stdio: "pipe" }).toString();
}
const graph = () => JSON.parse(require("fs").readFileSync(join(graphDir, "graph-data.json"), "utf-8"));

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "sg-gaps-")));
  catalogue = join(workspace, "catalogue");
  consumer = join(workspace, "consumer");
  graphDir = join(workspace, "graphdata");
  mkdirSync(graphDir, { recursive: true });

  writeSkill(join(catalogue, ".claude", "skills"), "alpha-skill");
  writeFlat(join(catalogue, ".claude", "agents"), "gamma-agent");
  // The consumer starts with a .claude it owns and this plugin did not create.
  mkdirSync(join(consumer, ".claude"), { recursive: true });
  writeFileSync(join(consumer, "CLAUDE.md"), "# consumer\n");

  writeFileSync(join(graphDir, "config.json"), JSON.stringify({
    sources: [
      { repo: "catalogue", root: join(catalogue, ".claude", "skills"), kind: "skill" },
      { repo: "catalogue", root: join(catalogue, ".claude", "agents"), kind: "agent" },
    ],
    scanRoots: [workspace],
    scanExclude: ["/node_modules/"], // deliberately WITHOUT /imported-repos/
  }));
  build();
  scan();
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  delete process.env.GRAPH_DATA_DIR;
});

// --- 1. every kind in claude-infra.json is importable ----------------------

test("add_repo imports commands and output styles, not just skills and agents", () => {
  const other = join(workspace, "other-repo");
  writeSkill(join(other, ".claude", "skills"), "imported-skill");
  writeFlat(join(other, ".claude", "agents"), "imported-agent");
  writeFlat(join(other, ".claude", "commands"), "imported-command");
  writeFlat(join(other, ".claude", "output-styles"), "imported-style");

  const r = mod("repo-importer.js").addRepo(other);
  expect(r.error).toBeUndefined();
  expect(r.found).toEqual({ skill: 1, agent: 1, command: 1, "output-style": 1 });

  mod("repo-importer.js").removeRepo("other-repo");
});

test("a repo holding ONLY commands imports, rather than reading as empty", () => {
  const cmdOnly = join(workspace, "cmd-only");
  writeFlat(join(cmdOnly, ".claude", "commands"), "solo-command");

  const r = mod("repo-importer.js").addRepo(cmdOnly);
  expect(r.error).toBeUndefined();
  expect(r.found).toEqual({ command: 1 });

  mod("repo-importer.js").removeRepo("cmd-only");
});

test("a repo with no .claude at all still fails, and names every directory it looked in", () => {
  const empty = join(workspace, "empty-repo");
  mkdirSync(empty, { recursive: true });
  const r = mod("repo-importer.js").addRepo(empty);
  expect(r.error).toContain("nothing importable");
  for (const dir of ["skills", "agents", "commands", "output-styles"]) {
    expect(r.error).toContain(`.claude/${dir}`);
  }
});

// --- 2. remove_repo must not strand a clone no tool can reach ---------------

test("a clone left behind by remove_repo is adopted, not refused forever", () => {
  const src = join(workspace, "adoptme");
  writeFlat(join(src, ".claude", "agents"), "adopted-agent");

  // Stand in for a URL clone: register it, then unregister WITHOUT deleting —
  // exactly what remove_repo's default does — and leave the files on disk.
  const importer = mod("repo-importer.js");
  const overlay = mod("graph-overlay.js");
  const importRoot = join(graphDir, "imported-repos");
  mkdirSync(importRoot, { recursive: true });
  execFileSync("cp", ["-R", src, join(importRoot, "adoptme")]);

  overlay.addImportedRepo({ label: "adoptme", source: "https://example.invalid/adoptme",
    repoPath: join(importRoot, "adoptme"), isLocal: false, nodeCount: 1 });
  const removed = importer.removeRepo("adoptme"); // no deleteClone: files stay
  expect(removed.error).toBeUndefined();
  expect(existsSync(join(importRoot, "adoptme"))).toBe(true);
  expect(overlay.hasImportedRepo("adoptme")).toBe(false);

  // The dead end: this used to answer "remove_repo first to re-import", while
  // remove_repo answered "no imported repo labeled adoptme".
  const again = importer.addRepo("https://example.invalid/adoptme");
  expect(again.error).toBeUndefined();
  expect(again.adopted).toBe(true);
  expect(again.found).toEqual({ agent: 1 });

  importer.removeRepo("adoptme", true);
  expect(existsSync(join(importRoot, "adoptme"))).toBe(false);
});

test("a genuinely registered repo is still refused, with advice that can be followed", () => {
  const importRoot = join(graphDir, "imported-repos");
  const src = join(workspace, "still-there");
  writeFlat(join(src, ".claude", "agents"), "present-agent");
  mkdirSync(importRoot, { recursive: true });
  execFileSync("cp", ["-R", src, join(importRoot, "still-there")]);

  const importer = mod("repo-importer.js");
  mod("graph-overlay.js").addImportedRepo({ label: "still-there", source: "https://example.invalid/still-there",
    repoPath: join(importRoot, "still-there"), isLocal: false, nodeCount: 1 });

  const r = importer.addRepo("https://example.invalid/still-there");
  expect(r.error).toContain("already imported");
  expect(mod("repo-importer.js").removeRepo("still-there", true).error).toBeUndefined();
});

// --- 3. uninstall must not delete a .claude it did not create ---------------

test("uninstalling the last item leaves the project's .claude directory standing", () => {
  const installer = mod("skill-installer.js");
  const q = mod("graph-query.js");

  const installed = installer.installSkill(q.loadGraph(), q, "alpha-skill", "consumer");
  expect(installed.error).toBeUndefined();
  expect(existsSync(join(consumer, ".claude", "skills", "alpha-skill"))).toBe(true);

  const removed = installer.uninstallSkill(q.loadGraph(), q, "alpha-skill", "consumer");
  expect(removed.error).toBeUndefined();

  // The directory this plugin created is gone...
  expect(existsSync(join(consumer, ".claude", "skills"))).toBe(false);
  // ...and the one it did not is not.
  expect(existsSync(join(consumer, ".claude"))).toBe(true);
});

test("the project is still in the graph after its last item is uninstalled", () => {
  scan();
  const ids = graph().nodes.map((n) => n.id);
  expect(ids).toContain("project:consumer");
  expect(ids).toContain("claudemd:consumer");
});

// --- 4. the catalogue's own clones are not the user's projects --------------

test("an imported clone is not counted as a project, even when scanExclude omits it", () => {
  const importRoot = join(graphDir, "imported-repos");
  const clone = join(importRoot, "someones-repo");
  writeSkill(join(clone, ".claude", "skills"), "their-skill");
  writeFileSync(join(clone, "CLAUDE.md"), "# theirs\n");

  // graphDir is inside the scan root here, which is exactly the default
  // per-project layout: the data directory lives at <project>/.claude/graph.
  expect(clone.startsWith(workspace)).toBe(true);
  // And the config does NOT list /imported-repos/ — the guard must not depend
  // on the user having configured it.
  expect(JSON.parse(require("fs").readFileSync(join(graphDir, "config.json"), "utf-8")).scanExclude)
    .not.toContain("/imported-repos/");

  scan();
  const ids = graph().nodes.map((n) => n.id);
  expect(ids.filter((id) => id.includes("someones-repo"))).toEqual([]);
});
