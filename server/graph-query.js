// Pure Node query engine over graph-data.json — mirrors the command language
// already built into the Electron app's renderer.js (best/path/neighbors/
// projects/find/cat:/type:), reimplemented server-side since renderer.js runs
// in a browser context (DOM/canvas) and isn't reusable here as-is. Keep the
// semantics in sync if either changes.
const fs = require("fs");
const path = require("path");
const overlay = require("./graph-overlay.js");
const paths = require("./paths.js");

// A project that has never run the build has no graph-data.json. That is the
// ordinary first-run state, not a fault, and it must not surface as a raw
// ENOENT stack trace from deep inside a tool call — the caller needs to be
// told which file is missing and which command creates it.
class GraphNotBuiltError extends Error {
  constructor(dataPath) {
    super(`No graph found at ${dataPath}. Run /skill-graph:build to create one (or /skill-graph:setup first if this project has no config.json yet).`);
    this.name = "GraphNotBuiltError";
    this.dataPath = dataPath;
  }
}

function loadGraph() {
  const DATA_PATH = paths.dataPath();
  if (!fs.existsSync(DATA_PATH)) throw new GraphNotBuiltError(DATA_PATH);
  const data = overlay.applyOverlay(JSON.parse(fs.readFileSync(DATA_PATH, "utf-8")));
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const byName = new Map();
  data.nodes.forEach((n) => {
    if (!byName.has(n.name)) byName.set(n.name, []);
    byName.get(n.name).push(n);
  });
  // "doc" edges (project -> its CLAUDE.md) are a structural link, not a
  // content reference — excluded from degree for the same reason "usage"
  // edges are: they'd inflate importance based on a relationship that isn't
  // "this content is worth citing".
  const realEdges = data.edges.filter((e) => e.kind !== "usage" && e.kind !== "doc");
  const degree = new Map();
  data.nodes.forEach((n) => degree.set(n.id, 0));
  realEdges.forEach((e) => {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  });
  const adjacency = new Map();
  data.nodes.forEach((n) => adjacency.set(n.id, new Set()));
  data.edges.forEach((e) => {
    adjacency.get(e.from).add(e.to);
    adjacency.get(e.to).add(e.from);
  });
  return { data, byId, byName, degree, adjacency, realEdges };
}

function resolveNode(g, text) {
  const q = text.trim().toLowerCase();
  if (!q) return { notFound: true };

  // An id is tried first because it is the only identifier guaranteed unique,
  // and it is what the ambiguity branch below hands back. Without this, the
  // candidates offered to break a tie could not themselves be looked up, and
  // the tie would have no answer.
  const byExactId = g.byId.get(text.trim());
  if (byExactId) return { node: byExactId };

  const exact = g.data.nodes.filter((n) => n.name.toLowerCase() === q);
  if (exact.length === 1) return { node: exact[0] };
  const sub = g.data.nodes.filter((n) => n.name.toLowerCase().includes(q));
  if (sub.length === 1) return { node: sub[0] };
  if (sub.length > 1) {
    // Two repos may legitimately hold a skill of the same name, so a candidate
    // list of bare names can contain the same string twice — asking the user to
    // choose between two identical options. Any name that is not unique within
    // the list is reported as its id instead, which is.
    const picked = sub.slice(0, 8);
    const seen = picked.map((n) => n.name);
    const repeated = new Set(seen.filter((n, i) => seen.indexOf(n) !== i));
    return { ambiguous: picked.map((n) => (repeated.has(n.name) ? n.id : n.name)) };
  }
  return { notFound: true };
}

function bfsPath(g, startId, endId) {
  if (startId === endId) return [startId];
  const visited = new Set([startId]);
  const parent = new Map();
  const queue = [startId];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    for (const nb of g.adjacency.get(cur)) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      parent.set(nb, cur);
      if (nb === endId) {
        const p = [nb];
        let c = nb;
        while (c !== startId) { c = parent.get(c); p.push(c); }
        return p.reverse();
      }
      queue.push(nb);
    }
  }
  return null;
}

function nodeSummary(n) {
  return { id: n.id, name: n.name, type: n.type, category: n.category, path: n.path, tags: n.tags || [] };
}

function best(g, { n = 15, type = null, category = null } = {}) {
  let pool = g.data.nodes.filter((x) => x.type !== "project" && x.type !== "claudemd");
  if (type) pool = pool.filter((x) => x.type === type);
  if (category) pool = pool.filter((x) => x.category === category || x.category.includes(category));
  const ranked = pool
    .map((x) => ({ ...nodeSummary(x), degree: g.degree.get(x.id) || 0 }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, n);
  return { ranked };
}

function neighbors(g, name) {
  const r = resolveNode(g, name);
  if (r.notFound) return { error: `no node matches "${name}"` };
  if (r.ambiguous) return { error: "ambiguous", candidates: r.ambiguous };
  const touching = g.realEdges
    .filter((e) => e.from === r.node.id || e.to === r.node.id)
    .sort((a, b) => b.weight - a.weight)
    .map((e) => {
      const otherId = e.from === r.node.id ? e.to : e.from;
      return { ...nodeSummary(g.byId.get(otherId)), weight: e.weight };
    });
  return { node: nodeSummary(r.node), neighbors: touching };
}

function findPath(g, aText, bText) {
  const ra = resolveNode(g, aText), rb = resolveNode(g, bText);
  if (ra.notFound || rb.notFound) return { error: `no node matches "${ra.notFound ? aText : bText}"` };
  if (ra.ambiguous || rb.ambiguous) return { error: "ambiguous", candidates: ra.ambiguous || rb.ambiguous };
  const p = bfsPath(g, ra.node.id, rb.node.id);
  if (!p) return { error: `no path — "${ra.node.name}" and "${rb.node.name}" are not connected` };
  return { hops: p.length - 1, path: p.map((id) => nodeSummary(g.byId.get(id))) };
}

function projectsUsing(g, name) {
  const r = resolveNode(g, name);
  if (r.notFound) return { error: `no node matches "${name}"` };
  if (r.ambiguous) return { error: "ambiguous", candidates: r.ambiguous };
  return { node: nodeSummary(r.node), usedBy: r.node.usedBy || [] };
}

function projectDetail(g, label) {
  const q = label.trim().toLowerCase();
  const proj = g.data.nodes.find((n) => n.type === "project" && n.name.toLowerCase() === q);
  if (!proj) {
    const sub = g.data.nodes.filter((n) => n.type === "project" && n.name.toLowerCase().includes(q));
    if (sub.length === 1) return projectDetailFor(g, sub[0]);
    if (sub.length > 1) return { error: "ambiguous", candidates: sub.map((n) => n.name) };
    return { error: `no scanned project matches "${label}"` };
  }
  return projectDetailFor(g, proj);
}
function projectDetailFor(g, proj) {
  const uses = g.data.edges
    .filter((e) => e.from === proj.id && e.kind === "usage")
    .map((e) => nodeSummary(g.byId.get(e.to)));
  return {
    project: proj.name, hasClaudeMd: proj.hasClaudeMd, path: proj.path, uses,
    notes: proj.notes || [], avgRating: proj.avgRating, ratings: proj.ratings || [],
  };
}

// Every term must appear somewhere in name + description + category; the terms
// need not all land in the same field.
//
// This used to test the whole query as one contiguous substring against each
// field in turn, which made the tool useless for the way people actually search
// it. "image generation" matched nothing in a 592-node catalogue holding a skill
// called image-generation, because the hyphen breaks the phrase and no
// description carries those two words adjacent. The failure reads as a missing
// node rather than a search that cannot express the question — the description
// still promised name/description/category search, and it was doing all three,
// just only ever for one unbroken string.
//
// AND rather than OR across terms: "image generation" must not return every
// node mentioning "image". search_ranked already scores per-term; this is the
// unranked filter catching up to it.
function find(g, text) {
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { matched: [] };
  const matched = g.data.nodes.filter((n) => {
    if (n.type === "project" || n.type === "claudemd") return false;
    const hay = `${n.name} ${n.description || ""} ${n.category}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  return { matched: matched.map(nodeSummary) };
}

function getNodeDetail(g, name) {
  const r = resolveNode(g, name);
  if (r.notFound) return { error: `no node matches "${name}"` };
  if (r.ambiguous) return { error: "ambiguous", candidates: r.ambiguous };
  const n = r.node;
  if (n.type === "project") return projectDetailFor(g, n);
  const out = g.realEdges.filter((e) => e.from === n.id).map((e) => ({ ...nodeSummary(g.byId.get(e.to)), weight: e.weight }));
  const inn = g.realEdges.filter((e) => e.to === n.id).map((e) => ({ ...nodeSummary(g.byId.get(e.from)), weight: e.weight }));
  return {
    ...nodeSummary(n),
    description: n.description,
    tools: n.tools || [],
    degree: g.degree.get(n.id) || 0,
    usedBy: n.usedBy || [],
    references: out,
    referencedBy: inn,
    notes: n.notes || [],
    avgRating: n.avgRating,
    ratings: n.ratings || [],
    tags: n.tags || [],
  };
}

// Ranked search — `find()` above just dumps every substring match in
// arbitrary (insertion) order. This scores each hit: exact name match beats
// a name that starts with the query, beats a name that just contains it,
// beats a hit that's only in the description or category — and within a
// tier, real graph degree (how much this thing is actually referenced) plus
// your own rating (if you've rated it) break ties, so a well-known or
// well-rated skill outranks an obscure one with the same text match quality.
// How well one node matches one search term. Exact name beats prefix beats
// substring beats a description mention beats a category mention.
function termTier(x, term) {
  const name = x.name.toLowerCase();
  if (name === term) return 100;
  if (name.startsWith(term)) return 80;
  if (name.includes(term)) return 60;
  if ((x.description || "").toLowerCase().includes(term)) return 30;
  if (x.category.toLowerCase().includes(term)) return 15;
  return 0;
}

// Words too common to carry signal. Dropped only when other words remain, so
// a deliberate search for one of them still works.
const STOPWORDS = new Set(["a", "an", "the", "and", "or", "for", "of", "to", "in", "on", "with", "my", "me", "is", "it"]);

function searchRanked(g, text, n = 15) {
  const q = text.trim().toLowerCase();
  if (!q) return { query: text, results: [] };

  // The original scored the query as ONE substring, so any multi-word search
  // — which is what a person describing a need actually types — matched
  // nothing at all, because "python security review" is not a literal
  // substring of any name or description. Multi-word queries are now scored
  // per word and combined.
  //
  // A single-word query takes the original path untouched: its tier, and so
  // its ranking against degree and rating, is exactly what it was before.
  const all = q.split(/\s+/).filter(Boolean);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  const terms = meaningful.length ? meaningful : all;

  const results = [];
  g.data.nodes.forEach((x) => {
    if (x.type === "project" || x.type === "claudemd") return;

    let tier;
    if (terms.length === 1) {
      tier = termTier(x, terms[0]);
    } else {
      // Scored on average strength, then scaled by how many of the words hit
      // at all: matching every word weakly beats matching one word strongly
      // and ignoring the rest. A literal phrase hit is added on top, so an
      // exact multi-word name still outranks a scattered match.
      let sum = 0, matched = 0;
      for (const t of terms) {
        const s = termTier(x, t);
        if (s > 0) { sum += s; matched++; }
      }
      const phrase = termTier(x, q);
      if (matched === 0 && phrase === 0) return;
      tier = phrase + (sum / terms.length) * (matched / terms.length);
    }
    if (tier === 0) return;
    const ratingBoost = x.avgRating ? (x.avgRating - 3) * 4 : 0; // -8..+8, centered on a neutral 3-star
    const score = tier + Math.min(g.degree.get(x.id) || 0, 20) + ratingBoost;
    results.push({ ...nodeSummary(x), score, degree: g.degree.get(x.id) || 0, avgRating: x.avgRating });
  });
  results.sort((a, b) => b.score - a.score);
  return { query: text, results: results.slice(0, n) };
}

// Graph-structural search, not text search: what else gets referenced
// alongside the same things as X? Jaccard similarity over each node's real
// (non-usage, non-doc) neighbor set — the same technique recommendation
// systems use for "people who bought X also bought Y", applied to which
// skills/agents actually get cited near each other in the source text. Two
// nodes that share no text can still surface here if they're consistently
// mentioned together with the same third parties.
function relatedByConnections(g, name, n = 10) {
  const r = resolveNode(g, name);
  if (r.notFound) return { error: `no node matches "${name}"` };
  if (r.ambiguous) return { error: "ambiguous", candidates: r.ambiguous };
  const target = r.node;
  const targetNeighbors = new Set(
    g.realEdges.filter((e) => e.from === target.id || e.to === target.id).map((e) => (e.from === target.id ? e.to : e.from))
  );
  if (!targetNeighbors.size) return { node: nodeSummary(target), related: [], note: "no real references to compare against" };
  const scored = [];
  g.data.nodes.forEach((cand) => {
    if (cand.id === target.id || cand.type === "project" || cand.type === "claudemd") return;
    const candNeighbors = new Set(
      g.realEdges.filter((e) => e.from === cand.id || e.to === cand.id).map((e) => (e.from === cand.id ? e.to : e.from))
    );
    if (!candNeighbors.size) return;
    let shared = 0;
    candNeighbors.forEach((id) => { if (targetNeighbors.has(id)) shared++; });
    if (shared === 0) return;
    const union = new Set([...targetNeighbors, ...candNeighbors]).size;
    scored.push({ ...nodeSummary(cand), sharedConnections: shared, jaccard: Math.round((shared / union) * 1000) / 1000 });
  });
  scored.sort((a, b) => b.jaccard - a.jaccard || b.sharedConnections - a.sharedConnections);
  return { node: nodeSummary(target), related: scored.slice(0, n) };
}

// The existing taxonomy, with counts — call this before set_category so a
// new category is a deliberate choice, not an accidental near-duplicate of
// one that already exists (e.g. "web-cloning" vs "website-cloning").
function listCategories(g) {
  const counts = {};
  g.data.nodes.forEach((n) => {
    if (n.type === "project" || n.type === "claudemd") return;
    counts[n.category] = (counts[n.category] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count }));
}

// Every tag currently in use, with counts — call this before get_file_set so
// a tag filter reuses an existing label (e.g. "react") instead of missing
// results because of a near-duplicate spelling (e.g. "reactjs").
function listTags(g) {
  const counts = {};
  g.data.nodes.forEach((n) => {
    (n.tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
}

function resolvedPath(g, n) {
  return path.isAbsolute(n.path) ? n.path : path.join(g.data.sourceRoot, n.path);
}

// The actual answer to "segregate skills/agents and get the correct set of
// files": one category per node is too coarse to reliably pick a precise
// set, so this filters on type + category + AS MANY tags as needed (all
// must match by default — set tagMode:"any" to broaden) + a text match,
// and returns real, resolved, ready-to-open file paths — not just names to
// look up again elsewhere.
function getFileSet(g, { type, categories, tags, tagMode, text } = {}) {
  let pool = g.data.nodes.filter((n) => n.type !== "project" && n.type !== "claudemd");
  if (type) pool = pool.filter((n) => n.type === type);
  if (categories && categories.length) {
    const catSet = new Set(categories.map((c) => c.toLowerCase()));
    pool = pool.filter((n) => catSet.has((n.category || "").toLowerCase()));
  }
  if (tags && tags.length) {
    const wanted = tags.map((t) => t.toLowerCase());
    pool = pool.filter((n) => {
      const have = new Set((n.tags || []).map((t) => t.toLowerCase()));
      return tagMode === "any" ? wanted.some((t) => have.has(t)) : wanted.every((t) => have.has(t));
    });
  }
  if (text) {
    const q = text.toLowerCase();
    pool = pool.filter((n) => n.name.toLowerCase().includes(q) || (n.description || "").toLowerCase().includes(q));
  }
  return {
    count: pool.length,
    files: pool.map((n) => ({
      name: n.name, type: n.type, category: n.category, tags: n.tags || [],
      description: n.description, path: resolvedPath(g, n), avgRating: n.avgRating,
    })),
  };
}

module.exports = {
  loadGraph, resolveNode, best, neighbors, findPath, projectsUsing, projectDetail, find, getNodeDetail, listCategories,
  listTags, getFileSet,
  searchRanked, relatedByConnections,
  dataPath: paths.dataPath, GraphNotBuiltError,
};
