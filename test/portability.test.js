// The platform-specific halves of install/uninstall, which the end-to-end test
// cannot reach because it runs on exactly one platform.
//
// Three things are covered: that the interpreter is discovered rather than
// assumed, that an install refuses to write anything when it cannot be
// completed, and that the scanner's exclude list still matches when the
// filesystem separator is a backslash.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { execFileSync } from "child_process";

const PLUGIN = resolve(import.meta.dir, "..");
const paths = require(join(PLUGIN, "server", "paths.js"));
const installer = require(join(PLUGIN, "server", "skill-installer.js"));

// --- interpreter discovery -------------------------------------------------

test("a Python 3 interpreter is found by probing, and it really is version 3", () => {
  const py = paths.pythonBin();
  expect(py).not.toBeNull();
  const v = execFileSync(py.cmd, [...py.args, "-c", "import sys; print(sys.version_info[0])"], { encoding: "utf-8" }).trim();
  expect(v).toBe("3");
});

test("the candidates include the two names a Windows install actually provides", () => {
  // Not a style assertion. `python3` does not exist on a stock Windows Python,
  // and hardcoding it was the entire platform dependency.
  expect(paths.pythonTried()).toContain("python3");
  expect(paths.pythonTried()).toContain("py -3");
});

// --- an install that cannot finish writes nothing --------------------------

test("with no interpreter, install reports the missing dependency and leaves no files", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sg-nopy-")));
  const target = join(dir, "target-project");
  const src = join(dir, "catalogue", "skills", "alpha");
  mkdirSync(target, { recursive: true });
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "SKILL.md"), "---\nname: alpha\ndescription: d\n---\nbody\n");

  const graph = {
    data: {
      sourceRoot: dir,
      nodes: [
        { id: "cat:skill:alpha", name: "alpha", type: "skill", path: join(src, "SKILL.md") },
        { id: "proj:target-project", name: "target-project", type: "project", path: target },
      ],
    },
  };
  const q = { resolveNode: (g, n) => ({ node: g.data.nodes.find((x) => x.name === n) }) };

  const real = paths.pythonBin;
  paths.pythonBin = () => null;
  try {
    const r = installer.installSkill(graph, q, "alpha", "target-project");
    expect(r.ok).toBeUndefined();
    expect(r.error).toContain("no Python 3 interpreter found");
    // The end state is the same whether it refused up front or copied and then
    // rolled back, so an assertion on the directory alone cannot tell the two
    // apart — and the second one is what shipped, and what corrupted a project
    // whenever the rollback could not run either. The message is the only thing
    // that distinguishes them, so the message is what is pinned.
    expect(r.error).not.toContain("removed again");
    // The point of the fix: it refused before writing, so .claude was never
    // created. Reporting an error after copying is what left a half-applied
    // state on every Windows machine.
    expect(existsSync(join(target, ".claude"))).toBe(false);
    expect(readdirSync(target)).toEqual([]);
  } finally {
    paths.pythonBin = real;
  }
  rmSync(dir, { recursive: true, force: true });
});

// --- the prune never escapes the project -----------------------------------

test("pruning stops at the project root and never removes it", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sg-prune-")));
  const project = join(dir, "proj");
  const deep = join(project, ".claude", "skills", "gone");
  mkdirSync(deep, { recursive: true });
  rmSync(deep, { recursive: true, force: true });

  installer.pruneEmptyParents(deep, project);

  expect(existsSync(join(project, ".claude", "skills"))).toBe(false);
  expect(existsSync(join(project, ".claude"))).toBe(false);
  // An empty project root is still the caller's directory, not ours to delete,
  // and neither is anything above it.
  expect(existsSync(project)).toBe(true);
  expect(existsSync(dir)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("pruning a path outside the project removes nothing", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sg-prune-out-")));
  const project = join(dir, "proj");
  const outside = join(dir, "elsewhere", "thing");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(dir, "elsewhere"), { recursive: true });

  installer.pruneEmptyParents(outside, project);

  expect(existsSync(join(dir, "elsewhere"))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

// --- the scanner's excludes survive a backslash separator ------------------

test("scanExclude matches when the separator is a backslash, as it is on Windows", () => {
  // os.sep is read at call time, so setting it is enough to make the function
  // see the paths a Windows os.walk would hand it. Running the real function
  // beats asserting on a copy of its logic.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sg-sep-")));
  const driver = join(dir, "driver.py");
  writeFileSync(driver, [
    "import os, sys, json, importlib.util",
    "spec = importlib.util.spec_from_file_location('scan', sys.argv[1])",
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "os.sep = chr(92)",
    "win = 'C:' + chr(92) + 'code' + chr(92) + 'proj' + chr(92) + 'node_modules' + chr(92) + 'pkg'",
    "norm = m.as_posix(win)",
    "print(json.dumps({'normalised': norm, 'matches': '/node_modules/' in norm + '/'}))",
  ].join("\n"));

  const py = paths.pythonBin();
  const out = execFileSync(py.cmd, [...py.args, driver, join(PLUGIN, "scripts", "scan-project-usage.py")], { encoding: "utf-8" });
  const got = JSON.parse(out);
  expect(got.normalised).toBe("C:/code/proj/node_modules/pkg");
  expect(got.matches).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("on this platform the separator is already a slash, so normalising changes nothing", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sg-sep2-")));
  const driver = join(dir, "driver.py");
  writeFileSync(driver, [
    "import sys, json, importlib.util",
    "spec = importlib.util.spec_from_file_location('scan', sys.argv[1])",
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "p = '/Users/x/code/proj/node_modules/pkg'",
    "print(json.dumps({'same': m.as_posix(p) == p}))",
  ].join("\n"));

  const py = paths.pythonBin();
  const out = execFileSync(py.cmd, [...py.args, driver, join(PLUGIN, "scripts", "scan-project-usage.py")], { encoding: "utf-8" });
  expect(JSON.parse(out).same).toBe(sep === "/");
  rmSync(dir, { recursive: true, force: true });
});
