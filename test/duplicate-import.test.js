// Importing a directory the build already catalogues used to produce a state
// with no way out: two nodes sharing an id and a name, and every by-name lookup
// of them answering {"error":"ambiguous","candidates":["x","x"]} — a question
// whose two options print the same string.
//
// commands/setup.md tells the model not to do it. That is worth having, but a
// rule is only as good as the reader; these tests cover the two things that
// hold whether or not anyone read it: add_repo refuses the import, and an
// ambiguous answer is always one the caller can act on.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFileSync } from "child_process";

const PLUGIN = resolve(import.meta.dir, "..");
const BUILD = join(PLUGIN, "scripts", "build-graph.py");

let workspace, project, graphDir;

function skill(dir, name, description) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
}

// Loaded fresh per call: these modules read paths.js at call time, and the env
// var below is what points them at this test's project.
function importer() {
  process.env.GRAPH_DATA_DIR = graphDir;
  return require(join(PLUGIN, "server", "repo-importer.js"));
}
function query() {
  process.env.GRAPH_DATA_DIR = graphDir;
  return require(join(PLUGIN, "server", "graph-query.js"));
}

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "sg-dupe-")));
  project = join(workspace, "proj");
  const skills = join(project, ".claude", "skills");
  mkdirSync(skills, { recursive: true });
  skill(skills, "alpha", "first skill");
  skill(skills, "beta", "second skill");

  graphDir = join(project, ".claude", "graph");
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(
    join(graphDir, "config.json"),
    JSON.stringify({ sources: [{ repo: "proj", root: ".claude/skills", kind: "skill" }], scanRoots: [], scanExclude: [] })
  );
  execFileSync("python3", [BUILD, join(graphDir, "config.json"), join(graphDir, "graph-data.json"), "--project-root", project]);
});

afterAll(() => {
  delete process.env.GRAPH_DATA_DIR;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

test("add_repo refuses a directory the build already catalogues", () => {
  const r = importer().addRepo(project);
  expect(r.ok).toBeUndefined();
  expect(r.error).toContain("already catalogued");
  expect(r.error).toContain("ambiguous");
  expect(r.alreadyCatalogued.name).toBeDefined();
  // The message has to name the way out, not just the problem.
  expect(r.fix).toContain("/skill-graph:build");
});

test("the refusal leaves nothing behind", () => {
  // If the guard fired after writing, the overlay would already be poisoned and
  // the error would be a lie.
  const q = query();
  const g = q.loadGraph();
  expect(g.data.nodes.map((n) => n.name).sort()).toEqual(["alpha", "beta"]);
  const r = q.getNodeDetail(g, "alpha");
  expect(r.error).toBeUndefined();
  expect(r.name).toBe("alpha");
});

test("an unrelated repo is still importable, even if a name repeats", () => {
  // The guard must key on the files being read twice, not on names — two
  // different repos each holding an "alpha" is a real thing people do.
  const other = join(workspace, "other");
  const skills = join(other, ".claude", "skills");
  mkdirSync(skills, { recursive: true });
  skill(skills, "alpha", "same name, different repo");
  const r = importer().addRepo(other);
  expect(r.error).toBeUndefined();
  expect(r.ok).toBe(true);
});

test("a node can be resolved by its id, so a tie-break answer is usable", () => {
  const q = query();
  const g = q.loadGraph();
  const id = g.data.nodes.find((n) => n.name === "alpha").id;
  expect(q.getNodeDetail(g, id).name).toBe("alpha");
});

test("candidates that share a name are reported as ids, never as the same string twice", () => {
  const q = query();
  const g = q.loadGraph();
  // Two repos holding a skill of the same name is legitimate and needs no
  // add_repo misuse to occur, so the graph is doctored directly here.
  const original = g.data.nodes.find((n) => n.name === "alpha");
  g.data.nodes.push({ ...original, id: "other:skill:alpha", repo: "other" });
  g.byId.set("other:skill:alpha", g.data.nodes.at(-1));

  const r = q.getNodeDetail(g, "alpha");
  expect(r.error).toBe("ambiguous");
  expect(new Set(r.candidates).size).toBe(r.candidates.length); // all distinct
  // and each one actually resolves
  for (const c of r.candidates) expect(q.getNodeDetail(g, c).error).toBeUndefined();
});
