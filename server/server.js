#!/usr/bin/env node
// MCP server exposing this project's skill+agent graph — the catalogued
// items, the real cross-references between them, and the projects on disk
// that actually have each one installed — as tools any Claude Code session
// can call directly. No GUI required; plain stdio.
//
// The graph itself is per-project and built by /skill-graph:build. Nothing
// here assumes a particular catalogue, size or source repo.
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { execFile } = require("child_process");
const q = require("./graph-query.js");
const overlay = require("./graph-overlay.js");
const installer = require("./skill-installer.js");
const repoImporter = require("./repo-importer.js");

// Filterable types come from the shared table rather than a literal list, so a
// kind added to claude-infra.json is filterable the same day it is catalogued.
const INFRA_KINDS = require("./infra-types.js").kinds();

const server = new McpServer({ name: "skill-graph", version: "0.1.2" });

function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// Every tool that names a node resolves it the same way, so they describe the
// argument the same way. The id clause is the load-bearing part: when a name is
// ambiguous these tools answer with candidate ids, and a caller reading only
// this description would have no way to know the string it was just handed is
// a legal input — leaving the ambiguity it was given to resolve unresolvable.
const NODE_REF = "exact or partial name, or an id returned in the candidates of an ambiguous result";

server.registerTool(
  "best_skills",
  {
    title: "Best skills/agents",
    description:
      "Rank this project's catalogued agents and skills by how many other real files actually reference them — a counted signal drawn from the source text, not a popularity guess. Optionally filter by type (agent|skill) or raw category (e.g. 'security', 'review', 'language:python').",
    inputSchema: {
      n: z.number().int().min(1).optional().describe("how many to return, default 15"),
      type: z.enum(INFRA_KINDS).optional(),
      category: z.string().optional().describe("raw category string or substring, e.g. 'security'"),
    },
  },
  async ({ n, type, category }) => ok(q.best(q.loadGraph(), { n, type, category }))
);

server.registerTool(
  "get_node",
  {
    title: "Get skill/agent/project detail",
    description:
      "Full detail for one node by name (an agent, a skill, or one of the scanned projects): description, tools, real file path, what it references, what references it, and — for a project — exactly which catalogued items it has installed on disk.",
    inputSchema: { name: z.string().describe(NODE_REF) },
  },
  async ({ name }) => ok(q.getNodeDetail(q.loadGraph(), name))
);

server.registerTool(
  "find_skills",
  {
    title: "Find skills/agents",
    description: "Fuzzy search the catalogue by name, description, or category.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ok(q.find(q.loadGraph(), text))
);

server.registerTool(
  "graph_neighbors",
  {
    title: "Neighbors of a node",
    description:
      "What a given agent/skill actually connects to via real name-references in the source text, sorted strongest first (weight = how many times it's actually mentioned).",
    inputSchema: { name: z.string().describe(NODE_REF) },
  },
  async ({ name }) => ok(q.neighbors(q.loadGraph(), name))
);

server.registerTool(
  "graph_path",
  {
    title: "Shortest path between two nodes",
    description: "Real breadth-first search over the actual reference graph — how (and whether) two agents/skills are connected, and through what.",
    inputSchema: { a: z.string().describe(NODE_REF), b: z.string().describe(NODE_REF) },
  },
  async ({ a, b }) => ok(q.findPath(q.loadGraph(), a, b))
);

server.registerTool(
  "projects_using",
  {
    title: "Which real projects use this skill/agent",
    description:
      "Backed by an actual filesystem scan of every .claude/agents and .claude/skills folder under the configured scan roots — not a manifest that can drift. Returns which of your projects currently have this installed.",
    inputSchema: { name: z.string().describe(NODE_REF) },
  },
  async ({ name }) => ok(q.projectsUsing(q.loadGraph(), name))
);

server.registerTool(
  "project_installed_skills",
  {
    title: "What a real project has installed",
    description: "For one scanned project, list every catalogued agent/skill it actually has in its own .claude/, plus whether it has a CLAUDE.md. Call projects_using or get_node first if you need the exact project label.",
    inputSchema: { project: z.string().describe("project label, e.g. 'Personal/context-management' or a substring like 'context-management'") },
  },
  async ({ project }) => ok(q.projectDetail(q.loadGraph(), project))
);

server.registerTool(
  "search_ranked",
  {
    title: "Ranked search",
    description:
      "Search the catalogue with real relevance ranking, not an arbitrary-order substring dump: exact name match > name starts with query > name contains query > description match > category match, with real reference-count degree breaking ties within a tier. Use this instead of find_skills when you want the best match first.",
    inputSchema: {
      text: z.string(),
      n: z.number().int().min(1).max(100).optional().describe("how many to return, default 15"),
    },
  },
  async ({ text, n }) => ok(q.searchRanked(q.loadGraph(), text, n))
);

server.registerTool(
  "related_by_connections",
  {
    title: "Related by shared connections (graph structure, not text)",
    description:
      "Not a text search — a graph algorithm (Jaccard similarity over real reference neighbors). Finds what else tends to get referenced alongside the same things as a given skill/agent, the same technique behind 'people who bought X also bought Y'. Two nodes with completely different names/descriptions can still turn up here if the real source text consistently cites them near the same third parties.",
    inputSchema: {
      name: z.string().describe(NODE_REF),
      n: z.number().int().min(1).max(50).optional().describe("how many to return, default 10"),
    },
  },
  async ({ name, n }) => ok(q.relatedByConnections(q.loadGraph(), name, n))
);

server.registerTool(
  "add_note",
  {
    title: "Add a note to a node",
    description:
      "Attach a persistent text note to any agent/skill/project/CLAUDE.md node — a real write, not a suggestion. Stored in .claude/graph/overlay.json, NOT in graph-data.json itself, specifically so it survives the next /skill-graph:build re-scan instead of being silently overwritten. Shows up in get_node's `notes` field and in the desktop app's detail panel on next load.",
    inputSchema: { name: z.string().describe(NODE_REF), text: z.string() },
  },
  async ({ name, text }) => {
    const g = q.loadGraph();
    const r = q.resolveNode(g, name);
    if (r.notFound) return ok({ error: `no node matches "${name}"` });
    if (r.ambiguous) return ok({ error: "ambiguous", candidates: r.ambiguous });
    return ok(overlay.addNote(r.node.id, text));
  }
);

server.registerTool(
  "remove_note",
  {
    title: "Remove a note from a node",
    description: "Removes one note by its index (0-based) in that node's notes array, as returned by get_node.",
    inputSchema: { name: z.string().describe(NODE_REF), index: z.number().int().min(0) },
  },
  async ({ name, index }) => {
    const g = q.loadGraph();
    const r = q.resolveNode(g, name);
    if (r.notFound) return ok({ error: `no node matches "${name}"` });
    if (r.ambiguous) return ok({ error: "ambiguous", candidates: r.ambiguous });
    return ok(overlay.removeNote(r.node.id, index));
  }
);

server.registerTool(
  "add_custom_edge",
  {
    title: "Add a custom relationship between two nodes",
    description:
      "Link two existing nodes with a relationship the automated text-scan didn't catch (e.g. 'these two skills work well together in practice'). Stored in the same durable overlay as notes — survives regeneration. The edge is real: it participates in graph_path, graph_neighbors, related_by_connections and best_skills' degree count, and renders in the desktop app as a distinct line.",
    inputSchema: {
      from: z.string().describe(`source node — ${NODE_REF}`),
      to: z.string().describe(`target node — ${NODE_REF}`),
      label: z.string().optional().describe("short relationship label, default 'related'"),
      weight: z.number().optional().describe("relationship strength, default 1 — higher pulls the two nodes closer together visually"),
    },
  },
  async ({ from, to, label, weight }) => {
    const g = q.loadGraph();
    const ra = q.resolveNode(g, from), rb = q.resolveNode(g, to);
    if (ra.notFound || rb.notFound) return ok({ error: `no node matches "${ra.notFound ? from : to}"` });
    if (ra.ambiguous || rb.ambiguous) return ok({ error: "ambiguous", candidates: ra.ambiguous || rb.ambiguous });
    return ok(overlay.addCustomEdge(ra.node.id, rb.node.id, label, weight));
  }
);

server.registerTool(
  "remove_custom_edge",
  {
    title: "Remove a custom edge",
    description: "Removes one custom edge by its index (0-based), as returned by add_custom_edge or listed in the overlay file directly.",
    inputSchema: { index: z.number().int().min(0) },
  },
  async ({ index }) => ok(overlay.removeCustomEdge(index))
);

server.registerTool(
  "rate_skill",
  {
    title: "Rate a skill/agent/project",
    description:
      "Give a node a 1-5 star rating with an optional note (e.g. 'worked great for X', 'too verbose, avoid'). Ratings accumulate — rating the same thing again adds a new entry rather than overwriting, and get_node returns the running average plus full history. Stored in the same durable overlay as notes/custom edges. Feeds into search_ranked as a tiebreaker, so well-rated things surface first.",
    inputSchema: {
      name: z.string().describe(NODE_REF),
      rating: z.number().int().min(1).max(5),
      note: z.string().optional(),
    },
  },
  async ({ name, rating, note }) => {
    const g = q.loadGraph();
    const r = q.resolveNode(g, name);
    if (r.notFound) return ok({ error: `no node matches "${name}"` });
    if (r.ambiguous) return ok({ error: "ambiguous", candidates: r.ambiguous });
    return ok(overlay.addRating(r.node.id, rating, note));
  }
);

server.registerTool(
  "remove_rating",
  {
    title: "Remove a rating",
    description: "Removes one rating by its index (0-based) in that node's ratings array, as returned by get_node.",
    inputSchema: { name: z.string().describe(NODE_REF), index: z.number().int().min(0) },
  },
  async ({ name, index }) => {
    const g = q.loadGraph();
    const r = q.resolveNode(g, name);
    if (r.notFound) return ok({ error: `no node matches "${name}"` });
    if (r.ambiguous) return ok({ error: "ambiguous", candidates: r.ambiguous });
    return ok(overlay.removeRating(r.node.id, index));
  }
);

server.registerTool(
  "install_skill",
  {
    title: "Install a skill/agent into a real project",
    description:
      "Copies a catalogued skill or agent's REAL files into a scanned project's own .claude/ folder (agents/<name>.md, or skills/<name>/ for a whole skill directory). A genuine filesystem write to the destination project only — the catalogued source tree is read-only and never modified. After copying, automatically re-scans so usedBy/usesCount reflect the install immediately. Fails cleanly (no partial write) if already installed there.",
    inputSchema: {
      name: z.string().describe(NODE_REF),
      project: z.string().describe("project label, e.g. 'context-management' or a substring — must match one of the scanned real projects"),
    },
  },
  async ({ name, project }) => {
    const g = q.loadGraph();
    return ok(installer.installSkill(g, q, name, project));
  }
);

server.registerTool(
  "uninstall_skill",
  {
    title: "Remove an installed skill/agent from a real project",
    description:
      "Deletes a skill/agent's real files from a project's own .claude/ folder — a genuine, irreversible filesystem delete (recursive for a skill directory). Only ever touches the target project, never the catalogued source tree. Re-scans automatically afterward so the graph reflects the removal immediately. Fails cleanly if it isn't actually installed there.",
    inputSchema: {
      name: z.string().describe(NODE_REF),
      project: z.string().describe("project label — must match one of the scanned real projects"),
    },
  },
  async ({ name, project }) => {
    const g = q.loadGraph();
    return ok(installer.uninstallSkill(g, q, name, project));
  }
);

server.registerTool(
  "add_repo",
  {
    title: "Add skills/agents from any external repo",
    description:
      "Extracts every .claude/skills/*/SKILL.md and .claude/agents/*.md from any repo (GitHub URL — clones it shallowly into .claude/graph/imported-repos/ — or a local path) into this catalog. Extraction is frontmatter-only (name/description/tools), the same parser the build pipeline uses. New nodes start with ZERO real connections — cross-references are not auto-computed for imports, unlike configured sources which get a full body-text scan. Use add_custom_edge afterward to link an import to related catalog items you notice. Stored in the durable overlay, so /skill-graph:build never removes it — only remove_repo does. Fails cleanly if the repo has no .claude/skills or .claude/agents at all.",
    inputSchema: {
      source: z.string().describe("a GitHub URL (https://... or git@...) or a local filesystem path"),
    },
  },
  async ({ source }) => ok(repoImporter.addRepo(source))
);

server.registerTool(
  "remove_repo",
  {
    title: "Remove a previously-added repo's skills/agents",
    description: "Removes an imported repo's metadata and every node it contributed. Pass deleteClone:true to also delete the local clone from disk (only meaningful for repos added via URL, not a local path you pointed at directly).",
    inputSchema: {
      label: z.string().describe("the repo's label, as returned by add_repo or list_imported_repos"),
      deleteClone: z.boolean().optional().describe("also delete the cloned files from disk, default false"),
    },
  },
  async ({ label, deleteClone }) => ok(repoImporter.removeRepo(label, deleteClone))
);

server.registerTool(
  "list_imported_repos",
  {
    title: "List repos added via add_repo",
    description: "Shows every external repo currently contributing nodes to the catalog: label, source, local clone path, and how many nodes each contributed.",
    inputSchema: {},
  },
  async () => ok(overlay.loadOverlay().importedRepos)
);

server.registerTool(
  "list_categories",
  {
    title: "List the category taxonomy in use",
    description: "Every category currently used across the catalog, with counts. Call this before set_category so a new category is a deliberate, considered choice rather than an accidental near-duplicate of an existing one (e.g. 'web-cloning' vs 'website-cloning').",
    inputSchema: {},
  },
  async () => ok(q.listCategories(q.loadGraph()))
);

server.registerTool(
  "set_category",
  {
    title: "Set a node's real category",
    description:
      "Overrides the category build-graph.py's keyword heuristic assigned (or that an import guessed) — that heuristic is crude: it matches the FIRST keyword hit in a fixed priority list, so a website-cloning skill whose description happens to mention 'CSS' gets stamped 'frontend' even though its actual purpose is cloning, not frontend work. Use this to set the category to whatever the skill's real use case is, based on actually reading its description/purpose. Call list_categories first to reuse an existing bucket when one genuinely fits — only introduce a new category name when nothing does. Survives regeneration; wins over the heuristic every time the graph loads.",
    inputSchema: { name: z.string().describe(NODE_REF), category: z.string() },
  },
  async ({ name, category }) => {
    const g = q.loadGraph();
    const r = q.resolveNode(g, name);
    if (r.notFound) return ok({ error: `no node matches "${name}"` });
    if (r.ambiguous) return ok({ error: "ambiguous", candidates: r.ambiguous });
    return ok(overlay.setCategory(r.node.id, category));
  }
);

server.registerTool(
  "remove_category_override",
  {
    title: "Revert a node to its heuristic-assigned category",
    description: "Removes a set_category override, reverting the node to whatever build-graph.py's keyword heuristic (or the import-time guess) assigns it.",
    inputSchema: { name: z.string().describe(NODE_REF) },
  },
  async ({ name }) => {
    const g = q.loadGraph();
    const r = q.resolveNode(g, name);
    if (r.notFound) return ok({ error: `no node matches "${name}"` });
    if (r.ambiguous) return ok({ error: "ambiguous", candidates: r.ambiguous });
    return ok(overlay.removeCategoryOverride(r.node.id));
  }
);

server.registerTool(
  "add_tags",
  {
    title: "Tag a node with as many labels as actually apply",
    description:
      "Category is one bucket per node — too coarse to reliably find 'the correct set of files' for a specific need. Tags are additive: a skill can be 'react' AND 'security' AND 'testing' at once. Add whichever tags genuinely describe it, based on reading its real purpose. Feeds get_file_set's filtering. Call list_tags first to reuse existing labels where one fits, rather than fragmenting into near-duplicates.",
    inputSchema: { name: z.string().describe(NODE_REF), tags: z.array(z.string()).min(1) },
  },
  async ({ name, tags }) => {
    const g = q.loadGraph();
    const r = q.resolveNode(g, name);
    if (r.notFound) return ok({ error: `no node matches "${name}"` });
    if (r.ambiguous) return ok({ error: "ambiguous", candidates: r.ambiguous });
    return ok(overlay.addTags(r.node.id, tags));
  }
);

server.registerTool(
  "remove_tags",
  {
    title: "Remove tags from a node",
    description: "Removes the given tags from a node, leaving any others in place.",
    inputSchema: { name: z.string().describe(NODE_REF), tags: z.array(z.string()).min(1) },
  },
  async ({ name, tags }) => {
    const g = q.loadGraph();
    const r = q.resolveNode(g, name);
    if (r.notFound) return ok({ error: `no node matches "${name}"` });
    if (r.ambiguous) return ok({ error: "ambiguous", candidates: r.ambiguous });
    return ok(overlay.removeTags(r.node.id, tags));
  }
);

server.registerTool(
  "list_tags",
  {
    title: "List every tag in use",
    description: "Every tag currently applied across the catalog, with counts. Check this before add_tags or get_file_set so you reuse an existing label instead of a near-duplicate spelling.",
    inputSchema: {},
  },
  async () => ok(q.listTags(q.loadGraph()))
);

server.registerTool(
  "get_file_set",
  {
    title: "Get the exact set of files matching real criteria",
    description:
      "The actual answer to 'give me the correct skills/agents for X' — not a ranked guess, a precise filter. Combine type + category + tags (ALL must match by default; tagMode:'any' to broaden) + a text match to narrow the whole catalog down to exactly what a task needs. Returns real, resolved file paths ready to Read or hand to install_skill — not just names you'd have to look up again. Call list_categories and list_tags first so your filter values actually exist in the catalog.",
    inputSchema: {
      type: z.enum(INFRA_KINDS).optional(),
      categories: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      tagMode: z.enum(["all", "any"]).optional().describe("default 'all' — every listed tag must match"),
      text: z.string().optional().describe("substring match against name/description"),
    },
  },
  async (filters) => ok(q.getFileSet(q.loadGraph(), filters))
);

server.registerTool(
  "reveal_in_finder",
  {
    title: "Reveal the real file in Finder",
    description: "Opens Finder to the actual source file (or, for a project, the actual project folder) on disk. A real OS-level action, not a copied path.",
    inputSchema: { name: z.string().describe(NODE_REF) },
  },
  async ({ name }) => {
    const g = q.loadGraph();
    const r = q.resolveNode(g, name);
    if (r.notFound) return ok({ error: `no node matches "${name}"` });
    if (r.ambiguous) return ok({ error: "ambiguous", candidates: r.ambiguous });
    const n = r.node;
    const path = require("path");
    const abs = path.isAbsolute(n.path) ? n.path : path.join(g.data.sourceRoot || "", n.path);
    // Each platform's own file-manager reveal. Anything else gets the real
    // path back and an honest statement that revealing isn't wired there,
    // rather than an ENOENT from a command that was never going to exist.
    const REVEAL = {
      darwin: ["open", ["-R", abs]],
      win32: ["explorer", [`/select,${abs}`]],
      linux: ["xdg-open", [require("path").dirname(abs)]],
    };
    const cmd = REVEAL[process.platform];
    if (!cmd) return ok({ ok: false, path: abs, error: `revealing a file is not supported on ${process.platform}` });
    return new Promise((resolve) => {
      execFile(cmd[0], cmd[1], (err) => {
        resolve(ok(err ? { ok: false, error: String(err), path: abs } : { ok: true, path: abs }));
      });
    });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
