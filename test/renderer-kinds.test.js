// The viewer's layout placed agents and skills and nothing else. Every other
// catalogued kind fell through both predicates of computeClusterLayoutSplit,
// received no position, and the very next line read `.x` off undefined — so ONE
// command node in the graph threw during construction and the entire page
// rendered blank. The MCP tools answered questions about that same graph
// perfectly, which is what made it read as "search is broken" rather than "the
// viewer is down".
//
// Nothing could have caught this: viewer.test.js exercises the SERVER (routes,
// overlay writes, path traversal) and never executes renderer.js, and the
// renderer is browser code with no test of its own. So this runs the real file
// in a VM against a graph holding every kind in claude-infra.json, with a
// permissive DOM stub — anything DOM-shaped answers, so only genuine logic
// errors surface. It asserts the one thing that matters: it does not throw.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import vm from "vm";

const PLUGIN = resolve(import.meta.dir, "..");
const RENDERER = join(PLUGIN, "app", "src", "renderer.js");
const KINDS = JSON.parse(readFileSync(join(PLUGIN, "scripts", "claude-infra.json"), "utf-8")).types.map((t) => t.kind);

function node(id, type, category) {
  return { id, name: id.split(":").pop(), type, category, description: `${type} for testing`, tools: [], path: `/tmp/${id}.md`, usedBy: [] };
}

// One node per catalogued kind, plus the two synthetic kinds the usage scan
// adds, plus a second category so the group-packing code has more than one box.
function fixtureGraph() {
  const nodes = [];
  KINDS.forEach((k, i) => {
    nodes.push(node(`repo:${k}:alpha`, k, "general"));
    nodes.push(node(`repo:${k}:beta`, k, i % 2 ? "security" : "media"));
  });
  nodes.push({ ...node("project:proj", "project", "general"), hasClaudeMd: true });
  nodes.push(node("claudemd:proj", "claudemd", "general"));
  return {
    nodes,
    edges: [
      { from: "repo:agent:alpha", to: "repo:skill:alpha", weight: 1 },
      // How the build really anchors a CLAUDE.md to its project.
      { from: "project:proj", to: "claudemd:proj", weight: 1, kind: "doc" },
    ],
    sourceRoot: "/tmp",
  };
}

// Permissive stub: every DOM lookup answers with something chainable.
function runRenderer(graph) {
  const anyObj = () => new Proxy(function () {}, {
    get: (t, p) =>
      p === "getContext" ? () => anyObj()
      : p === "length" ? 0
      : p === Symbol.toPrimitive ? () => ""
      : typeof p === "string" ? anyObj() : undefined,
    set: () => true, apply: () => anyObj(), has: () => true,
  });
  const document = new Proxy({}, { get: (t, p) => {
    if (p === "querySelectorAll") return () => [];
    if (p === "addEventListener") return () => {};
    if (typeof p === "string" && (p.startsWith("get") || p.startsWith("query") || p === "createElement")) return () => anyObj();
    return anyObj();
  }});

  return new Promise((resolve) => {
    let thrown = null;
    const ctx = {
      window: { graphAPI: { loadGraph: async () => graph }, addEventListener() {}, devicePixelRatio: 1,
                innerWidth: 1400, innerHeight: 900, matchMedia: () => ({ matches: false, addEventListener() {} }) },
      document, console: { log() {}, warn() {}, error() {} },
      requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
      setTimeout, clearTimeout, devicePixelRatio: 1,
      performance: { now: () => 0 },
      ResizeObserver: class { observe() {} disconnect() {} },
      navigator: { platform: "MacIntel" },
      localStorage: { getItem: () => null, setItem() {} },
    };
    ctx.globalThis = ctx; ctx.self = ctx;
    vm.createContext(ctx);
    // The renderer is an async IIFE, so a layout failure surfaces as a rejected
    // promise rather than a synchronous throw.
    const onRejection = (e) => { thrown = e; };
    process.once("unhandledRejection", onRejection);
    try { vm.runInContext(readFileSync(RENDERER, "utf-8"), ctx, { filename: "renderer.js" }); }
    catch (e) { thrown = e; }
    setTimeout(() => { process.removeListener("unhandledRejection", onRejection); resolve(thrown); }, 400);
  });
}

test("the renderer builds against a graph holding every catalogued kind", async () => {
  const err = await runRenderer(fixtureGraph());
  expect(err === null ? null : String(err && err.message)).toBeNull();
});

test("adding a kind to claude-infra.json cannot silently break the viewer", async () => {
  // Guards the generalisation itself: a kind the layout has never heard of must
  // still get a position rather than crashing the page.
  const g = fixtureGraph();
  g.nodes.push(node("repo:future-kind:gamma", "future-kind", "general"));
  const err = await runRenderer(g);
  expect(err === null ? null : String(err && err.message)).toBeNull();
});

test("a graph of only projects still builds", async () => {
  const g = { nodes: [{ ...node("project:solo", "project", "general"), hasClaudeMd: false }], edges: [], sourceRoot: "/tmp" };
  const err = await runRenderer(g);
  expect(err === null ? null : String(err && err.message)).toBeNull();
});
