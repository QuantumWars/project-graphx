// The README shows what an ambiguous lookup answers. This runs that scenario
// and asserts the real answer equals the documented one.
//
// It exists because of how that example got there. It was written as a
// schematic — plausible ids, composed by hand, never printed by any run — and
// was only confirmed later by someone building a project named to match it. A
// schematic example is legitimate documentation, and this one is correct. But
// "correct today, by hand" is exactly the state that goes stale silently: the
// id format is a code detail, and nothing else would notice if it changed.
//
// So the README is the fixture rather than a copy of it. The scenario below is
// constructed to produce those exact ids, and the assertion compares against
// the block parsed out of README.md. Change the id format and this fails.
// Change the README and this fails. Neither can drift alone.
//
// The scenario runs in a child process, for the same reason paths.test.js does
// it: these modules take their data directory from GRAPH_DATA_DIR, and test
// files in one runner share process.env. Setting it here passed alone and
// failed in the suite, because another file's cleanup removed it partway
// through. A child process owns its own environment and cannot be raced.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFileSync } from "child_process";

const PLUGIN = resolve(import.meta.dir, "..");
const BUILD = join(PLUGIN, "scripts", "build-graph.py");

// The README names the projects `myproj` and `other`, and ids are built from
// those labels, so the fixture has to use the same two names for the example to
// be reproducible at all.
const PROJECT_LABEL = "myproj";
const IMPORTED_LABEL = "other";
const SHARED_NAME = "code-reviewer";

let workspace, result;

function agent(dir, name, description) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
}

// Parsed rather than pasted: a copy here would be a second thing to keep in
// step, which is the problem this test exists to remove.
function documentedExample() {
  const readme = readFileSync(join(PLUGIN, "README.md"), "utf-8");
  const block = readme.match(/```json\s*(\{[^`]*?"error":\s*"ambiguous"[^`]*?\})\s*```/);
  if (!block) throw new Error("README no longer contains a fenced json example of an ambiguous result");
  return JSON.parse(block[1]);
}

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "sg-readme-")));

  const project = join(workspace, PROJECT_LABEL);
  agent(join(project, ".claude", "agents"), SHARED_NAME, "reviews code");

  // A separate repo that genuinely holds the same name — the legitimate case
  // the refusal deliberately still allows.
  agent(join(workspace, IMPORTED_LABEL, ".claude", "agents"), SHARED_NAME, "reviews code, elsewhere");

  const graphDir = join(project, ".claude", "graph");
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(
    join(graphDir, "config.json"),
    JSON.stringify({ sources: [{ repo: PROJECT_LABEL, root: ".claude/agents", kind: "agent" }], scanRoots: [], scanExclude: [] })
  );
  execFileSync("python3", [BUILD, join(graphDir, "config.json"), join(graphDir, "graph-data.json"), "--project-root", project]);

  const script = `
    const imp = require(${JSON.stringify(join(PLUGIN, "server", "repo-importer.js"))});
    const q = require(${JSON.stringify(join(PLUGIN, "server", "graph-query.js"))});
    const added = imp.addRepo(${JSON.stringify(join(workspace, IMPORTED_LABEL))});
    const g = q.loadGraph();
    const lookup = q.getNodeDetail(g, ${JSON.stringify(SHARED_NAME)});
    const resolved = (lookup.candidates || []).map((c) => {
      const r = q.getNodeDetail(g, c);
      return { candidate: c, error: r.error, name: r.name };
    });
    console.log(JSON.stringify({ added: !added.error, lookup, resolved }));
  `;
  const out = execFileSync("node", ["-e", script], {
    encoding: "utf-8",
    env: { ...process.env, GRAPH_DATA_DIR: graphDir },
  });
  result = JSON.parse(out.trim().split("\n").at(-1));
});

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

test("the fixture actually reached the ambiguous state", () => {
  // Without this, a scenario that silently failed to import would leave the
  // assertions below comparing nothing and passing.
  expect(result.added).toBe(true);
  expect(result.lookup.error).toBe("ambiguous");
});

test("an ambiguous lookup answers exactly what the README says it does", () => {
  const documented = documentedExample();
  expect(result.lookup.error).toBe(documented.error);
  expect([...result.lookup.candidates].sort()).toEqual([...documented.candidates].sort());
});

test("the documented candidates are themselves resolvable", () => {
  // The example's whole point is that a candidate can be passed back to break
  // the tie. If they were not accepted as input it would be documenting a dead
  // end, and the assertion above would still pass.
  expect(result.resolved).toHaveLength(documentedExample().candidates.length);
  for (const r of result.resolved) {
    expect(r.error).toBeUndefined();
    expect(r.name).toBe(SHARED_NAME);
  }
});
