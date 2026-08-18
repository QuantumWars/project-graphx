// The category heuristic exists twice: once in Python (scripts/build-graph.py,
// used when cataloguing a configured source) and once in JavaScript
// (server/repo-importer.js, used when importing an external repo). They must
// agree, or the same skill lands in two different categories depending on how
// it arrived.
//
// They did not agree. The JS copy still carried "go-" and "java-" dash
// workarounds that the Python side had already replaced with real word
// boundaries, and its frontend list still contained the bare "design" the
// Python side had deliberately removed. Nothing detected that, because
// "kept in sync by hand" is a comment, not a mechanism.
//
// This is the mechanism. Both implementations are run over the same inputs
// and any disagreement fails the suite.
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { join, resolve } from "path";
import { createRequire } from "module";

const PLUGIN = resolve(import.meta.dir, "..");
const require_ = createRequire(import.meta.url);

// Drawn from the real catalogue, weighted toward the cases that were actually
// wrong. Each pair is (name, description) exactly as it appears in a real
// frontmatter block.
const CASES = [
  // The reported bug: a passing platform mention in a description.
  ["accessibility", "Design, implement, and audit inclusive digital products using WCAG 2.2 Level AA. Use this skill to generate semantic ARIA for Web and Native platforms (iOS/Android)."],
  ["a11y-architect", "Accessibility Architect specializing in WCAG 2.2 compliance for Web and Native platforms."],
  // Short stems that sit inside ordinary words: ci/specialist, ui/build, ml/yaml.
  ["seo-specialist", "SEO specialist for technical SEO audits, on-page optimization and structured data."],
  ["orch-build-mvp", "Build an MVP end to end with tests."],
  ["config-gc", "Garbage-collect stale YAML config entries."],
  ["architect", "Software architecture specialist for system design, scalability, and technical decision-making."],
  ["chief-of-staff", "Personal communication chief of staff that triages email and Slack."],
  // Language names that are prefixes or suffixes of other words.
  ["swiftui-patterns", "SwiftUI view composition and state patterns."],
  ["nuxt4-patterns", "Nuxt 4 application patterns."],
  ["flutter-reviewer", "Flutter and Dart code reviewer."],
  ["kotlin-reviewer", "Kotlin and Android/KMP code reviewer."],
  ["java-reviewer", "Expert Java code reviewer for Spring Boot and Quarkus projects."],
  ["django-build-resolver", "Django/Python build, migration, and dependency error resolution specialist."],
  ["vue-patterns", "Vue and Nuxt composition patterns."],
  ["react-performance", "React rendering performance."],
  ["reactivity-notes", "Notes on reactivity in signals-based UIs."],
  ["trusted-setup", "A trusted setup ceremony for zk circuits."],
  ["golang-testing", "Go testing idioms."],
  ["cpp-testing", "C++ unit testing."],
  // "doc" inside "docker".
  ["docker-patterns", "Docker build and runtime patterns."],
  ["documentation-lookup", "Look up library documentation."],
  // Plain role and keyword routes, to prove the untouched paths still agree.
  ["code-reviewer", "Expert code review specialist."],
  ["security-review", "Security checklist and patterns for auth and secrets."],
  ["python-testing", "pytest idioms and fixtures."],
  ["deep-research", "Multi-source deep research with cited reports."],
  ["video-editing", "Cut and assemble video with ffmpeg."],
  ["postgres-patterns", "PostgreSQL schema and query patterns."],
  ["autonomous-loops", "Run an agent in a loop until a goal is met."],
  ["planner", "Expert planning specialist for complex features and refactoring."],
  ["", ""],
  ["no-signal-at-all", "A thing that does a thing."],
];

function pythonCategories(cases) {
  const driver = `
import json, sys, importlib.util
spec = importlib.util.spec_from_loader("bg", loader=None)
src = open(${JSON.stringify(join(PLUGIN, "scripts", "build-graph.py"))}).read().split("args = sys.argv[1:]")[0]
ns = {}
exec(compile(src, "build-graph.py", "exec"), ns)
print(json.dumps([ns["category_for"](n, d) for n, d in json.load(sys.stdin)]))
`;
  const out = execFileSync("python3", ["-c", driver], { input: JSON.stringify(cases), encoding: "utf-8" });
  return JSON.parse(out);
}

test("the Python and JavaScript category heuristics agree on every case", () => {
  const { categoryFor } = require_(join(PLUGIN, "server", "repo-importer.js"));
  const py = pythonCategories(CASES);
  const js = CASES.map(([n, d]) => categoryFor(n, d));

  const disagreements = CASES
    .map(([n], i) => (py[i] === js[i] ? null : `  ${n || "(empty)"}: python=${py[i]} js=${js[i]}`))
    .filter(Boolean);
  expect(disagreements.join("\n")).toBe("");
});

// The specific classifications this change was made to fix. These are asserted
// as values, not just as parity, so that "both wrong in the same way" fails.
test("a platform named only in the description does not claim the category", () => {
  const { categoryFor } = require_(join(PLUGIN, "server", "repo-importer.js"));
  expect(categoryFor(...CASES[0])).toBe("accessibility");
  expect(categoryFor(...CASES[1])).toBe("accessibility");
});

test("a short keyword does not match inside an unrelated word", () => {
  const { categoryFor } = require_(join(PLUGIN, "server", "repo-importer.js"));
  // "ci" inside "specialist" used to make this devops.
  expect(categoryFor(...CASES[2])).toBe("content-marketing");
  // "ui" inside "build" used to make this frontend.
  expect(categoryFor(...CASES[3])).not.toBe("frontend");
});

test("a version digit does not break a language name, but a letter still does", () => {
  const { categoryFor } = require_(join(PLUGIN, "server", "repo-importer.js"));
  expect(categoryFor(...CASES[8])).toBe("language:nuxt");        // nuxt4
  expect(categoryFor(...CASES[7])).toBe("language:swift");       // swiftui -> swift
  expect(categoryFor("reactivity-notes", "Notes on reactivity in signals-based UIs.")).not.toBe("language:react");
  expect(categoryFor("trusted-setup", "A trusted setup ceremony for zk circuits.")).not.toBe("language:rust");
});

test("with no signal at all it says general rather than inventing one", () => {
  const { categoryFor } = require_(join(PLUGIN, "server", "repo-importer.js"));
  expect(categoryFor("no-signal-at-all", "A thing that does a thing.")).toBe("general");
});
