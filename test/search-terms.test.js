// find_skills matched the whole query as one contiguous substring, so it could
// not answer the way people actually search it: "image generation" returned
// nothing from a catalogue holding a skill named image-generation, because the
// hyphen breaks the phrase and no description carries those two words adjacent.
//
// The failure was silent and looked like a missing node, which is worse than an
// error — the tool's own description promised name/description/category search
// and was honestly doing all three, just only ever for one unbroken string.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFileSync } from "child_process";

const PLUGIN = resolve(import.meta.dir, "..");
const BUILD = join(PLUGIN, "scripts", "build-graph.py");
const PY = require(resolve(PLUGIN, "server", "paths.js")).pythonBin();

let workspace, graphDir;

function skill(dir, name, description) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
}

function query() {
  process.env.GRAPH_DATA_DIR = graphDir;
  return require(join(PLUGIN, "server", "graph-query.js"));
}
const names = (r) => r.matched.map((m) => m.name).sort();

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "sg-terms-")));
  graphDir = join(workspace, "graphdata");
  mkdirSync(graphDir, { recursive: true });
  const skills = join(workspace, "repo", ".claude", "skills");

  // The real shape of the bug: the words are split across a hyphenated NAME and
  // a description that never puts them adjacent.
  skill(skills, "image-generation", "Generate or edit pictures with a hosted model via OpenRouter.");
  skill(skills, "image-postprocess", "Deterministic picture work: exact hex, exact text, crops.");
  skill(skills, "video-encoder", "Encode video files. Nothing to do with still pictures.");

  writeFileSync(join(graphDir, "config.json"), JSON.stringify({
    sources: [{ repo: "repo", root: skills, kind: "skill" }], scanRoots: [], scanExclude: [],
  }));
  execFileSync(PY.cmd, [...PY.args, BUILD, join(graphDir, "config.json"), join(graphDir, "graph-data.json"),
    "--project-root", workspace], { stdio: "pipe" });
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  delete process.env.GRAPH_DATA_DIR;
});

test("a multi-word query finds a hyphenated name — the case that returned nothing", () => {
  const q = query();
  expect(names(q.find(q.loadGraph(), "image generation"))).toEqual(["image-generation"]);
});

test("terms may land in different fields", () => {
  // "image" is only in the name; "openrouter" only in the description.
  const q = query();
  expect(names(q.find(q.loadGraph(), "image openrouter"))).toEqual(["image-generation"]);
});

test("terms are ANDed, so one common word does not drag everything in", () => {
  const q = query();
  // "picture" appears in all three descriptions; adding "crops" must narrow it.
  expect(names(q.find(q.loadGraph(), "picture")).length).toBe(3);
  expect(names(q.find(q.loadGraph(), "picture crops"))).toEqual(["image-postprocess"]);
});

test("single-word search is unchanged — no regression for the queries that worked", () => {
  const q = query();
  expect(names(q.find(q.loadGraph(), "image"))).toEqual(["image-generation", "image-postprocess"]);
});

test("a query matching nothing still returns nothing", () => {
  const q = query();
  expect(names(q.find(q.loadGraph(), "image kubernetes"))).toEqual([]);
});

test("projects and CLAUDE.md nodes are never returned", () => {
  const q = query();
  const g = q.loadGraph();
  g.data.nodes.push({ id: "project:p", name: "picture-project", type: "project", category: "general", description: "picture", path: "/tmp/p" });
  expect(names(q.find(g, "picture"))).not.toContain("picture-project");
});
