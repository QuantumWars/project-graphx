// Adds any external repo's .claude/skills and .claude/agents into the
// catalog. Mirrors build-graph.py's frontmatter parsing and category
// heuristic so imported nodes are consistent with the rest of the graph.
//
// Stored in the durable overlay (graph-overlay.js), NOT graph-data.json —
// that file gets fully rebuilt by build-graph.py, which only ever scans the
// repos listed in sources.json and would silently drop anything else
// written there.
//
// Scope, stated plainly: this extracts frontmatter (name/description/tools)
// only. It does NOT compute cross-reference edges the way build-graph.py
// does for the sources.json repos (that requires scanning every other
// node's body text for name mentions, repo-wide) — an imported skill starts
// with zero connections. Use add_custom_edge to link it to related catalog
// items by hand as you find them.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const overlay = require("../graph-overlay.js");

const IMPORT_ROOT = path.join(__dirname, "..", "imported-repos");

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

// Same heuristic as build-graph.py's category_for(), kept in sync by hand.
const LANG_TOKENS = ["python", "golang", "go-", "rust", "java-", "kotlin", "swift", "csharp", "cpp", "c++", "php", "perl", "ruby", "typescript", "javascript", "dart", "arkts", "harmonyos", "django", "laravel", "quarkus", "springboot", "fsharp", "angular", "vue", "nuxt", "react", "android", "ios"];
const ROLE_SUFFIX = [["reviewer", "review"], ["build-resolver", "build"], ["tdd", "testing"], ["testing", "testing"], ["verification", "verification"], ["security", "security"], ["patterns", "patterns"]];
const KEYWORD_FALLBACK = [
  [["security", "vuln", "secret", "auth", "injection"], "security"],
  [["test", "tdd", "e2e", "coverage"], "testing"],
  [["review", "audit", "lint", "quality"], "review"],
  [["doc", "readme", "comment"], "docs"],
  [["deploy", "docker", "ci", "cd", "devops", "infra", "kubernetes", "migration"], "devops"],
  [["database", "postgres", "sql", "clickhouse", "supabase"], "database"],
  [["frontend", "react", "ui", "component", "css", "design"], "frontend"],
  [["backend", "api", "server"], "backend"],
  [["research", "market", "investor", "competitor"], "research"],
  [["writ", "content", "copy", "marketing", "social", "seo", "brand"], "content-marketing"],
  [["ml", "eval", "model", "train", "llm", "agent", "harness", "orchestrat", "loop", "memory", "instinct"], "agentic-ml"],
  [["accessib", "a11y"], "accessibility"],
  [["video", "audio", "image", "3d"], "media"],
];
function categoryFor(name, desc) {
  const hay = `${name} ${desc}`.toLowerCase();
  for (const tok of LANG_TOKENS) {
    if (hay.includes(tok)) {
      let norm = tok.replace(/-$/, "").replace("c++", "cpp");
      if (norm === "golang") norm = "go";
      return `language:${norm}`;
    }
  }
  for (const [suffix, cat] of ROLE_SUFFIX) if (name.toLowerCase().includes(suffix)) return cat;
  for (const [kws, cat] of KEYWORD_FALLBACK) if (kws.some((k) => hay.includes(k))) return cat;
  return "general";
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
  const dest = path.join(IMPORT_ROOT, label);
  if (fs.existsSync(dest)) return { error: `"${label}" already has a local clone at ${dest} — remove_repo first to re-import` };
  fs.mkdirSync(IMPORT_ROOT, { recursive: true });
  try {
    execFileSync("git", ["clone", "--depth", "1", source, dest], { stdio: "pipe" });
  } catch (err) {
    return { error: `git clone failed: ${String(err.message || err).slice(0, 500)}` };
  }
  return { repoPath: dest, label, isLocal: false };
}

function scanRepo(repoPath, label) {
  const nodes = [];
  const agentsDir = path.join(repoPath, ".claude", "agents");
  if (fs.existsSync(agentsDir)) {
    fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")).forEach((f) => {
      const p = path.join(agentsDir, f);
      const { fm } = frontmatter(fs.readFileSync(p, "utf-8"));
      const name = fm.name || f.replace(/\.md$/, "");
      const desc = fm.description || "";
      const toolsRaw = (fm.tools || "").replace(/^\[|\]$/g, "");
      const tools = toolsRaw.split(/[,\s]+/).filter(Boolean);
      nodes.push({
        id: `import:${label}:agent:${name}`, name, type: "agent", repo: `import:${label}`,
        description: desc, tools, category: categoryFor(name, desc), path: p, sourceRepo: label,
      });
    });
  }
  const skillsDir = path.join(repoPath, ".claude", "skills");
  if (fs.existsSync(skillsDir)) {
    fs.readdirSync(skillsDir).filter((d) => {
      try { return fs.statSync(path.join(skillsDir, d)).isDirectory(); } catch { return false; }
    }).forEach((d) => {
      const p = path.join(skillsDir, d, "SKILL.md");
      if (!fs.existsSync(p)) return;
      const { fm } = frontmatter(fs.readFileSync(p, "utf-8"));
      const name = fm.name || d;
      const desc = fm.description || "";
      nodes.push({
        id: `import:${label}:skill:${name}`, name, type: "skill", repo: `import:${label}`,
        description: desc, tools: [], category: categoryFor(name, desc), path: p, sourceRepo: label,
      });
    });
  }
  return nodes;
}

function addRepo(source) {
  const located = cloneOrLocate(source);
  if (located.error) return { error: located.error };
  const nodes = scanRepo(located.repoPath, located.label);
  if (!nodes.length) {
    if (!located.isLocal) fs.rmSync(located.repoPath, { recursive: true, force: true }); // don't keep a useless clone around
    return { error: `no .claude/skills or .claude/agents found in ${located.repoPath}` };
  }
  const repoResult = overlay.addImportedRepo({ label: located.label, source, repoPath: located.repoPath, isLocal: located.isLocal, nodeCount: nodes.length });
  if (repoResult.error) return repoResult;
  overlay.addImportedNodes(nodes);
  return {
    ok: true, label: located.label, repoPath: located.repoPath,
    agentsFound: nodes.filter((n) => n.type === "agent").length,
    skillsFound: nodes.filter((n) => n.type === "skill").length,
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

module.exports = { addRepo, removeRepo };
