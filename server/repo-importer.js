// Adds any external repo's .claude/skills and .claude/agents into the
// catalog. Mirrors build-graph.py's frontmatter parsing and category
// heuristic so imported nodes are consistent with the rest of the graph.
//
// Stored in the durable overlay (graph-overlay.js), NOT graph-data.json —
// that file gets fully rebuilt by build-graph.py, which only ever scans
// the configured sources, and would silently drop anything else written there.
//
// Scope, stated plainly: this extracts frontmatter (name/description/tools)
// only. It does NOT compute cross-reference edges the way build-graph.py
// does for configured sources (that requires scanning every other node's body
// text for name mentions, repo-wide) — an imported skill starts with zero
// connections. Use add_custom_edge to link it to related catalog items by
// hand as you find them.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const overlay = require("./graph-overlay.js");
const paths = require("./paths.js");
const infra = require("./infra-types.js");

function frontmatter(text) {
  if (!text.startsWith("---")) return { fm: {}, body: text };
  const parts = text.split("---");
  if (parts.length < 3) return { fm: {}, body: text };
  const fm = {};
  let cur = null;
  parts[1].split("\n").forEach((line) => {
    if (!line.trim()) return;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m) { cur = m[1]; fm[cur] = m[2].trim(); }
    else if (cur && /^[\s-]/.test(line)) fm[cur] = `${fm[cur]} ${line.trim()}`.trim();
  });
  return { fm, body: parts.slice(2).join("---") };
}

// A hand-maintained mirror of build-graph.py's category_for(). It had already
// drifted — this copy still carried the "go-"/"java-" dash workarounds the
// Python side replaced with real word boundaries — so the two are now pinned
// together by test/heuristic-parity.test.js, which runs both over the same
// inputs and fails on any disagreement. Change one, change the other, or the
// suite says so.
const LANG_TOKENS = ["python", "golang", "go", "rust", "java", "kotlin", "swift", "csharp", "cpp", "c++", "php", "perl", "ruby", "typescript", "javascript", "dart", "arkts", "harmonyos", "django", "laravel", "quarkus", "springboot", "fsharp", "angular", "vue", "nuxt", "react", "android", "ios", "swiftui", "flutter"];
const LANG_ALIAS = { golang: "go", "c++": "cpp", swiftui: "swift", flutter: "dart" };
const BOUNDED_KEYWORDS = new Set(["ci", "cd", "ui", "ml", "api", "3d", "e2e"]);
const ROLE_SUFFIX = [["reviewer", "review"], ["build-resolver", "build"], ["tdd", "testing"], ["testing", "testing"], ["verification", "verification"], ["security", "security"], ["patterns", "patterns"]];
const KEYWORD_FALLBACK = [
  [["security", "vuln", "secret", "auth", "injection"], "security"],
  [["test", "tdd", "e2e", "coverage"], "testing"],
  [["review", "audit", "lint", "quality"], "review"],
  [["docs", "documentation", "docstring", "readme", "comment"], "docs"],
  [["deploy", "docker", "ci", "cd", "devops", "infra", "kubernetes", "migration"], "devops"],
  [["database", "postgres", "sql", "clickhouse", "supabase"], "database"],
  [["frontend", "react", "ui", "component", "css", "design system", "ui design"], "frontend"],
  [["backend", "api", "server"], "backend"],
  [["research", "market", "investor", "competitor"], "research"],
  [["writ", "content", "copy", "marketing", "social", "seo", "brand"], "content-marketing"],
  [["ml", "eval", "model", "train", "llm", "agent", "harness", "orchestrat", "loop", "memory", "instinct"], "agentic-ml"],
  [["accessib", "a11y"], "accessibility"],
  [["video", "audio", "image", "3d"], "media"],
];

const RE_CACHE = new Map();
function wordIn(tok, hay) {
  let rx = RE_CACHE.get(tok);
  if (!rx) {
    rx = new RegExp(`(?<![a-z0-9])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`);
    RE_CACHE.set(tok, rx);
  }
  return rx.test(hay);
}
const kwIn = (kw, hay) => (BOUNDED_KEYWORDS.has(kw) ? wordIn(kw, hay) : hay.includes(kw));

function langOf(hay) {
  for (const tok of [...LANG_TOKENS].sort((a, b) => b.length - a.length)) {
    if (wordIn(tok, hay)) return `language:${LANG_ALIAS[tok] || tok}`;
  }
  return null;
}

function categoryFor(name, desc) {
  const lname = name.toLowerCase();
  const hay = `${lname} ${(desc || "").toLowerCase()}`;
  const lang = langOf(lname);
  if (lang) return lang;
  for (const [suffix, cat] of ROLE_SUFFIX) if (lname.includes(suffix)) return cat;
  for (const haystack of [lname, hay]) {
    for (const [kws, cat] of KEYWORD_FALLBACK) if (kws.some((k) => kwIn(k, haystack))) return cat;
  }
  return langOf(hay) || "general";
}

function slugFromSource(source) {
  const m = source.replace(/\/$/, "").match(/([^/]+?)(\.git)?$/);
  return (m ? m[1] : "repo").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function cloneOrLocate(source) {
  const isUrl = /^https?:\/\//.test(source) || source.startsWith("git@");
  if (!isUrl) {
    const abs = path.resolve(source);
    if (!fs.existsSync(abs)) return { error: `local path not found: ${abs}` };
    return { repoPath: abs, label: path.basename(abs), isLocal: true };
  }
  const label = slugFromSource(source);
  const dest = path.join(paths.importRoot(), label);
  if (fs.existsSync(dest)) {
    // A clone on disk means one of two things, and they need opposite answers.
    //
    // If the overlay still records this label, the repo really is imported and
    // re-importing would duplicate it — refuse, and the advice to run
    // remove_repo first is followable.
    //
    // If the overlay does NOT record it, the clone is an orphan: remove_repo
    // ran without deleteClone (its default), which unregistered the label but
    // left the files. Refusing here used to be a dead end — add_repo said "run
    // remove_repo first", and remove_repo said "no imported repo labeled ...",
    // so neither tool could undo the other and only a manual rm escaped it.
    // Adopting the existing clone re-registers it and costs no network.
    if (overlay.hasImportedRepo(label)) {
      return { error: `"${label}" is already imported (clone at ${dest}) — remove_repo first to re-import` };
    }
    return { repoPath: dest, label, isLocal: false, adopted: true };
  }
  fs.mkdirSync(paths.importRoot(), { recursive: true });
  try {
    execFileSync("git", ["clone", "--depth", "1", source, dest], { stdio: "pipe" });
  } catch (err) {
    return { error: `git clone failed: ${String(err.message || err).slice(0, 500)}` };
  }
  return { repoPath: dest, label, isLocal: false };
}

// Driven by the shared claude-infra.json table, not by a branch per kind. The
// two-branch version this replaces imported agents and skills only, so a repo
// whose .claude/ held commands or output styles imported as "nothing found" —
// and, worse, a repo holding ONLY those was reported as having no .claude/ at
// all and had its clone deleted. Every other part of the pipeline (build,
// install, the usage scan, push) already reads the table; this was the last
// place that still hardcoded two of the four kinds.
function scanRepo(repoPath, label) {
  const nodes = [];
  for (const kind of infra.kinds()) {
    const spec = infra.spec(kind);
    const dir = path.join(repoPath, ".claude", spec.installDir);
    if (!fs.existsSync(dir)) continue;

    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }

    for (const entry of entries) {
      // "flat" kinds are one .md file per item; "dir" kinds are a directory
      // holding a named entry file. The fallback name differs accordingly.
      let filePath, fallbackName;
      if (spec.layout === "flat") {
        if (!entry.endsWith(".md")) continue;
        filePath = path.join(dir, entry);
        fallbackName = entry.replace(/\.md$/, "");
      } else {
        try { if (!fs.statSync(path.join(dir, entry)).isDirectory()) continue; } catch { continue; }
        filePath = path.join(dir, entry, spec.entryFile);
        if (!fs.existsSync(filePath)) continue;
        fallbackName = entry;
      }

      const { fm } = frontmatter(fs.readFileSync(filePath, "utf-8"));
      const name = fm.name || fallbackName;
      const desc = fm.description || "";
      // Only agents declare a tools list; the others have no such field, so
      // this parses to an empty array for them rather than needing a branch.
      const tools = (fm.tools || "").replace(/^\[|\]$/g, "").split(/[,\s]+/).filter(Boolean);
      nodes.push({
        id: `import:${label}:${kind}:${name}`, name, type: kind, repo: `import:${label}`,
        description: desc, tools, category: categoryFor(name, desc), path: filePath, sourceRepo: label,
      });
    }
  }
  return nodes;
}

// Importing a directory the build already catalogues produces two nodes for
// every item under it — graph-data.json holds one, overlay.json the other, and
// applyOverlay concatenates them without deduplicating. Their ids differ (the
// imported one is namespaced `import:`), so nothing detects the clash, but
// their NAMES are identical, and names are what every lookup resolves by. The
// result is worse than a duplicate: get_node answers
// {"error":"ambiguous","candidates":["x","x"]}, and there is no answer the user
// can give that resolves it.
//
// Refusing here rather than merging is deliberate. A merge would have to guess
// which copy wins, and they are not equivalent — the built node carries real
// cross-reference edges computed from file bodies, the imported one has none by
// design. Silently keeping the wrong one would cost edges no error would ever
// mention.
// Ids cannot detect this: imported nodes are namespaced `import:`, so they never
// collide with built ones. The collision is on NAME, which is what every lookup
// resolves by — and name alone is the wrong test, because two genuinely
// different repos may each hold a `code-reviewer` and that import is legitimate.
//
// The real condition is that the same files are being read twice. So the check
// is on paths: refuse when the directory being imported overlaps a configured
// source, in either direction.
// Deliberately not derived from config.json. The config states source roots as
// paths relative to the project, and resolving those requires projectRoot(),
// which falls back to the current working directory — and an MCP server's cwd
// is not reliably the project. A wrong root there makes this guard quietly
// answer "no overlap" and stop guarding, which is the failure mode that
// matters least visibly and most.
//
// graph-data.json already records where every catalogued file actually is, as
// written by the build itself. Asking whether any of those files sits inside
// the directory being imported answers the real question — are these the same
// files? — without a second, weaker copy of the resolution logic.
function builtFileUnder(repoPath) {
  const dataPath = paths.dataPath();
  if (!fs.existsSync(dataPath)) return null; // nothing built yet, nothing to duplicate
  let data;
  try {
    data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  } catch {
    return null; // a corrupt graph is the build's problem to report, not this one's
  }
  const target = path.resolve(repoPath);
  const under = (p) => p === target || p.startsWith(target + path.sep);
  for (const n of data.nodes || []) {
    if (!n.path || n.type === "project") continue;
    const abs = path.isAbsolute(n.path) ? n.path : path.resolve(data.sourceRoot || "", n.path);
    if (under(abs)) return { name: n.name, path: abs };
  }
  return null;
}

function addRepo(source) {
  const located = cloneOrLocate(source);
  if (located.error) return { error: located.error };
  const nodes = scanRepo(located.repoPath, located.label);
  if (!nodes.length) {
    // An adopted clone was already on disk before this call, so deleting it
    // here would destroy something this call did not create. Only a clone this
    // call made is cleaned up.
    if (!located.isLocal && !located.adopted) fs.rmSync(located.repoPath, { recursive: true, force: true });
    const looked = infra.kinds().map((k) => `.claude/${infra.spec(k).installDir}`).join(", ");
    return { error: `nothing importable in ${located.repoPath} — looked for ${looked}` };
  }

  const clash = builtFileUnder(located.repoPath);
  if (clash) {
    if (!located.isLocal && !located.adopted) fs.rmSync(located.repoPath, { recursive: true, force: true });
    return {
      error:
        `${located.repoPath} is already catalogued by the build — ${clash.path} is in the graph already. ` +
        `Importing it would add a second copy of every item under it, and because both copies carry the same name, ` +
        `every by-name lookup of them would answer "ambiguous" with two identical choices. Nothing was imported.`,
      alreadyCatalogued: clash,
      fix: "Run /skill-graph:build to refresh what is already configured. add_repo is for repositories that are not configured sources — and unlike the build it reads frontmatter only, so its nodes carry no cross-reference edges.",
    };
  }
  const repoResult = overlay.addImportedRepo({ label: located.label, source, repoPath: located.repoPath, isLocal: located.isLocal, nodeCount: nodes.length });
  if (repoResult.error) return repoResult;
  overlay.addImportedNodes(nodes);
  // One count per kind the table knows, rather than two named fields. Adding a
  // kind to claude-infra.json used to leave its items importable but invisible
  // in this summary, which reads as "nothing was found".
  const found = {};
  for (const kind of infra.kinds()) {
    const n = nodes.filter((x) => x.type === kind).length;
    if (n) found[kind] = n;
  }
  return {
    ok: true, label: located.label, repoPath: located.repoPath,
    adopted: located.adopted || false, // reused a clone left by a previous remove_repo
    found,
    names: nodes.map((n) => `${n.name} (${n.type})`),
    note: "New nodes start with zero connections — cross-references aren't auto-computed for imports. Use add_custom_edge to link them to related catalog items.",
  };
}

function removeRepo(label, deleteClone) {
  const result = overlay.removeImportedRepo(label);
  if (result.error) return result;
  if (deleteClone && result.repo && !result.repo.isLocal && fs.existsSync(result.repo.repoPath)) {
    fs.rmSync(result.repo.repoPath, { recursive: true, force: true });
  }
  return result;
}

// categoryFor is exported so the parity suite can run it against the Python
// implementation. It is the same function the import path uses — not a copy.
module.exports = { addRepo, removeRepo, categoryFor };
