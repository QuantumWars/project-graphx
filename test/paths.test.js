// Path resolution is the whole of what made this repo-shaped tool into a
// plugin, so it is tested against real directories on disk rather than mocks.
// Each test builds the exact filesystem shape that would break it.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFileSync } from "child_process";

const PLUGIN = resolve(import.meta.dir, "..");
const PATHS = join(PLUGIN, "server", "paths.js");
const temps = [];

// realpath, because on macOS os.tmpdir() is /var/... which is a symlink to
// /private/var/... — the module under test resolves paths and returns the
// real one, so a test comparing against the symlinked spelling fails on a
// difference that is not the code's.
function tmp(prefix = "sg-") {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

// Runs a snippet in a fresh node process so cwd, argv and env are all real
// rather than simulated — the three inputs path resolution actually reads.
function inNode({ script, cwd, env = {}, scriptPath }) {
  const file = scriptPath || join(tmp(), "probe.js");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, script);
  return execFileSync(process.execPath, [file], {
    cwd,
    env: { ...process.env, GRAPH_PROJECT_DIR: "", CLAUDE_PROJECT_DIR: "", GRAPH_DATA_DIR: "", CLAUDE_PLUGIN_ROOT: "", ...env },
    encoding: "utf-8",
  }).trim();
}

const probe = (expr) => `const p = require(${JSON.stringify(PATHS)}); console.log(${expr});`;

test("projectRoot prefers GRAPH_PROJECT_DIR over everything else", () => {
  const explicit = tmp();
  const elsewhere = tmp();
  const got = inNode({ script: probe("p.projectRoot()"), cwd: elsewhere, env: { GRAPH_PROJECT_DIR: explicit } });
  expect(got).toBe(explicit);
});

test("projectRoot walks up to the nearest ancestor holding .claude", () => {
  const root = tmp();
  mkdirSync(join(root, ".claude"));
  const deep = join(root, "a", "b", "c");
  mkdirSync(deep, { recursive: true });
  expect(inNode({ script: probe("p.projectRoot()"), cwd: deep })).toBe(root);
});

test("projectRoot accepts a .git-only project (no .claude yet)", () => {
  const root = tmp();
  mkdirSync(join(root, ".git"));
  const deep = join(root, "src");
  mkdirSync(deep);
  expect(inNode({ script: probe("p.projectRoot()"), cwd: deep })).toBe(root);
});

test("projectRoot stops at cwd when no marker exists anywhere above it", () => {
  // A temp dir under /tmp has no .git or .claude above it. If the walk were
  // unbounded and marker-less it would climb to "/" and silently claim the
  // filesystem root as the project.
  const lonely = tmp();
  expect(inNode({ script: probe("p.projectRoot()"), cwd: lonely })).toBe(lonely);
});

test("data lives under the project's .claude/graph, not with the plugin", () => {
  const root = tmp();
  mkdirSync(join(root, ".claude"));
  const got = inNode({ script: probe("p.dataPath()"), cwd: root });
  expect(got).toBe(join(root, ".claude", "graph", "graph-data.json"));
  expect(got.startsWith(PLUGIN)).toBe(false);
});

test("pluginRoot ignores a stale __dirname and uses the real running location", () => {
  // This is the bundled case. The bundler inlines __dirname as a build-time
  // string literal, so on any other machine __dirname/.. points at a directory
  // that either does not exist or is not the plugin. Reproduced here by
  // putting paths.js somewhere with no plugin manifest above it, while the
  // script that runs it sits inside a real one.
  const stale = tmp();
  mkdirSync(join(stale, "server"), { recursive: true });
  cpSync(PATHS, join(stale, "server", "paths.js"));

  const real = tmp();
  mkdirSync(join(real, ".claude-plugin"), { recursive: true });
  writeFileSync(join(real, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "skill-graph" }));
  mkdirSync(join(real, "server"), { recursive: true });
  // The entry point sits in the real plugin, so process.argv[1] points there,
  // while the module it loads sits in the stale one.
  writeFileSync(
    join(real, "server", "probe.js"),
    `const p = require(${JSON.stringify(join(stale, "server", "paths.js"))}); console.log(p.pluginRoot());`,
  );

  const got = execFileSync(process.execPath, [join(real, "server", "probe.js")], {
    cwd: tmp(),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: "" },
    encoding: "utf-8",
  });
  expect(got.trim()).toBe(real);
});

test("CLAUDE_PLUGIN_ROOT wins outright when Claude Code sets it", () => {
  const declared = tmp();
  expect(inNode({ script: probe("p.pluginRoot()"), cwd: tmp(), env: { CLAUDE_PLUGIN_ROOT: declared } })).toBe(declared);
});

test("an explicitly empty scanRoots is honoured, not replaced by a default", () => {
  // "[]" means scan nothing. Treating it as falsy and substituting ~/code
  // would make the tool walk the user's whole code directory against their
  // written instruction.
  const root = tmp();
  const dir = join(root, ".claude", "graph");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ sources: [], scanRoots: [] }));
  const got = inNode({ script: probe("JSON.stringify(p.loadConfig().scanRoots)"), cwd: root });
  expect(got).toBe("[]");
});

test("a corrupt config reports the problem instead of throwing", () => {
  const root = tmp();
  const dir = join(root, ".claude", "graph");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), "{ not json");
  const got = inNode({ script: probe("p.loadConfig().error"), cwd: root });
  expect(got).toContain("not valid JSON");
});

test("the original bare-array sources.json format still loads", () => {
  const root = tmp();
  const dir = join(root, ".claude", "graph");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify([{ repo: "r", root: "x", kind: "skill" }]));
  const got = inNode({ script: probe("p.loadConfig().sources.length"), cwd: root });
  expect(got).toBe("1");
});
