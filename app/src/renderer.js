(async function () {
  "use strict";
  const DATA = await window.graphAPI.loadGraph();

  // A fresh clone (or a first launch before running the setup scripts) has
  // no data yet. Every layout/physics calculation below assumes at least
  // one node — rather than auditing each one for empty-array safety, bail
  // out early with real setup instructions instead of a blank canvas.
  if (!DATA || !DATA.nodes || DATA.nodes.length === 0) {
    document.getElementById("app").innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;width:100%;height:100vh;padding:40px;box-sizing:border-box;">
        <div style="max-width:560px;font-family:-apple-system,sans-serif;color:#E8EAED;">
          <h1 style="font-size:20px;margin:0 0 12px;">No graph data yet</h1>
          <p style="color:#9AA1A8;line-height:1.6;font-size:13px;">
            This viewer shows <b>your own</b> Claude Code skills and agents. Nothing is bundled with it.
            Build a graph for a project first, from a Claude Code session in that project:
          </p>
          <ol style="color:#9AA1A8;line-height:1.9;font-size:13px;padding-left:20px;">
            <li><code style="background:#2B3034;padding:1px 5px;border-radius:4px;">/skill-graph:setup</code> — say which folders hold your skills and agents</li>
            <li><code style="background:#2B3034;padding:1px 5px;border-radius:4px;">/skill-graph:build</code> — scan them and write <code style="background:#2B3034;padding:1px 5px;border-radius:4px;">.claude/graph/graph-data.json</code></li>
            <li><code style="background:#2B3034;padding:1px 5px;border-radius:4px;">/skill-graph:app</code> — reopen this window pointed at that project</li>
          </ol>
          <p style="color:#62686E;line-height:1.6;font-size:12px;">
            Looking in: <code style="background:#2B3034;padding:1px 5px;border-radius:4px;">${(DATA && DATA.dataDir) || "unknown"}</code><br>
            Launch with <code style="background:#2B3034;padding:1px 5px;border-radius:4px;">--data-dir &lt;path&gt;</code> or <code style="background:#2B3034;padding:1px 5px;border-radius:4px;">GRAPH_DATA_DIR</code> to point elsewhere.
          </p>
        </div>
      </div>`;
    return;
  }

  // declared first: tick() gets called synchronously during layout setup,
  // well before the sections further down in this file are reached.
  let running = true, settleFrames = 0;
  const MIN_DIST_SQ = 900; // floor under repulsion's distSq — denominator can't go below this
  const MAX_SPEED = 140; // world-units/tick hard cap, independent of DAMPING

  // Derived from the data, not hardcoded. This was ["agent", "skill"], and
  // passesFilter() gates rendering on activeTypes — so once the build started
  // cataloguing commands and output styles, those nodes existed in the graph,
  // were returned by every query, and could never be drawn. Twenty command
  // nodes were invisible in a graph that reported 592.
  //
  // DATA is already loaded above, so the kinds present are knowable here and
  // cannot drift from claude-infra.json the way a second hardcoded list does.
  // project/claudemd are excluded because they are not authored kinds: they are
  // toggled together by the "project" switch, which passesFilter special-cases.
  const TYPES = [...new Set(DATA.nodes.map((n) => n.type))]
    .filter((t) => t !== "project" && t !== "claudemd")
    .sort();

  // ---- curated group palette (not hash-generated) ----
  // 38 auto-derived categories is too many distinct colors for any viewer to
  // hold in their head — that reads as noise, not information. Collapse them
  // into ~10 deliberately chosen, harmonious groups. The fine-grained category
  // (e.g. "language:python") is preserved on every node and shown in the
  // inspector/search — only the *color* is coarsened.
  const FRONTEND_LANGS = new Set(["language:react", "language:vue", "language:angular", "language:nuxt"]);
  const GROUP_RULES = {
    review: "Review & Quality",
    security: "Security",
    testing: "Testing & Verification",
    verification: "Testing & Verification",
    devops: "Infra & Data",
    database: "Infra & Data",
    backend: "Infra & Data",
    build: "Infra & Data",
    frontend: "Frontend",
    docs: "Docs",
    "content-marketing": "Content & Research",
    research: "Content & Research",
    "agentic-ml": "Agentic & Meta",
    general: "Agentic & Meta",
    patterns: "Agentic & Meta",
    media: "Other",
    accessibility: "Other",
  };
  function groupFor(cat) {
    if (cat === "project") return "Your Projects";
    if (GROUP_RULES[cat]) return GROUP_RULES[cat];
    if (cat.startsWith("language:")) return FRONTEND_LANGS.has(cat) ? "Frontend" : "Languages & Platforms";
    return "Other";
  }
  const GROUP_COLORS = {
    "Review & Quality": "#6EA8FE",
    "Security": "#FF8A65",
    "Testing & Verification": "#4FD1C5",
    "Infra & Data": "#B39DDB",
    "Frontend": "#81C995",
    "Languages & Platforms": "#F0C674",
    "Docs": "#F48FB1",
    "Content & Research": "#FFD54F",
    "Agentic & Meta": "#90A4AE",
    "Other": "#78909C",
    "Your Projects": "#E8EAED",
  };
  const GROUP_RGB = Object.fromEntries(Object.entries(GROUP_COLORS).map(([g, hex]) => {
    const n = parseInt(hex.slice(1), 16);
    return [g, [(n >> 16) & 255, (n >> 8) & 255, n & 255]];
  }));
  function groupColor(g) { return GROUP_COLORS[g] || GROUP_COLORS.Other; }
  function groupColorRGBA(g, alpha) {
    const [r, gr, b] = GROUP_RGB[g] || GROUP_RGB.Other;
    return `rgba(${r},${gr},${b},${alpha})`;
  }
  // Fill = category (above). Ring = type — a second, independent signal so
  // "what kind of thing is this" reads at a glance without losing the
  // category-color info the fill already carries. Every type is the same
  // circle now (no more project square) — size is what marks a project as a
  // different kind of thing, it's the only type whose radius can reach 60.
  // Projects stay ring-less and agents intentionally get no ring either —
  // both are the unmarked baseline, distinguished from skills/claudemd by
  // the absence of a ring rather than a ring of their own.
  const TYPE_RING = {
    skill: { color: "rgba(255,255,255,0.35)", width: 1.2 },
    claudemd: { color: "rgba(87,217,163,0.95)", width: 2.2 }, // same green as this app's established CLAUDE.md signal
  };

  // ---- reusable group-clustered layout ----
  // Groups get their own non-overlapping "neighborhood" on a ring, sized by how
  // many nodes they hold. Nodes fill their group's neighborhood with a
  // phyllotaxis (sunflower-seed) spiral: r = SPACING * sqrt(i), theta = i *
  // golden angle — that formula's whole point is uniform nearest-neighbor
  // distance across the disk, so SPACING *is* that distance in world units.
  // This is a pure function of "which nodes are in play" so it can be run
  // three times: once over everything, once over agents only, once over
  // skills only — three independently-clustered layouts, not one layout with
  // some nodes hidden.
  const NODE_SPACING = 76; // world-space nearest-neighbor gap target; node radii top out at 34
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  // Fills one phyllotaxis spiral (full 360°, golden-angle) centered at `center`
  // — the same formula proven collision-free for a full 68- or 286-node set,
  // so it's just as safe on the smaller per-group-per-type subsets this is
  // actually called on.
  function placeSpiral(list, center, positions) {
    list.forEach((n, idx) => {
      const localR = NODE_SPACING * Math.sqrt(idx + 0.5);
      const localAngle = idx * GOLDEN_ANGLE;
      positions.set(n.id, { x: center.x + Math.cos(localAngle) * localR, y: center.y + Math.sin(localAngle) * localR });
    });
  }

  // Single-type layout (used for the Agents-only and Skills-only views,
  // where there's nothing to sub-split within a group).
  function computeClusterLayout(nodeList) {
    return computeClusterLayoutSplit(nodeList, () => true, () => false);
  }

  // Type-split layout: within EACH group's neighborhood, agents and skills
  // get their own separate phyllotaxis sub-disk rather than one shared spiral
  // ordered by insertion. This matters because golden-angle phyllotaxis
  // scatters sequential indices across the WHOLE disk by design (that's what
  // gives it even coverage) — so agents-then-skills insertion order does NOT
  // produce spatially-separated regions on its own, it just looks randomly
  // interleaved. Two independent spirals, placed far enough apart that their
  // radii can't touch, is what actually separates them.
  function computeClusterLayoutSplit(nodeList, isA, isB) {
    const groupsHere = [...new Set(nodeList.map((n) => groupFor(n.category)))];
    const aCounts = {}, bCounts = {};
    nodeList.forEach((n) => {
      const g = groupFor(n.category);
      if (isA(n)) aCounts[g] = (aCounts[g] || 0) + 1;
      else if (isB(n)) bCounts[g] = (bCounts[g] || 0) + 1;
    });
    // wider than the bare minimum: a real edge between an agent and a skill
    // in the same group pulls them toward each other during the settle pass
    // (LINK_DIST=160), so the resting gap ends up smaller than this constant —
    // padded enough that it stays comfortably above the worst-case touching
    // distance (68, two max-radius nodes) even after that pull.
    const GAP = 130;
    const footprint = new Map(); // effective outer radius this group needs on the big ring
    const subRadius = new Map(); // {a, b} sub-disk radii, for placing the two centers
    groupsHere.forEach((g) => {
      const Na = aCounts[g] || 0, Nb = bCounts[g] || 0;
      const fpA = Na > 0 ? NODE_SPACING * Math.sqrt(Na) : 0;
      const fpB = Nb > 0 ? NODE_SPACING * Math.sqrt(Nb) : 0;
      const gap = (Na > 0 && Nb > 0) ? GAP : 0;
      subRadius.set(g, { fpA, fpB, gap });
      footprint.set(g, fpA + fpB + gap + 70);
    });
    // Row/shelf packing, not a shared-radius ring. A ring puts every group's
    // center the same distance from the origin, so a big group's disk (up to
    // ~550 radius for the 52-member group here) bulges inward toward the
    // center no matter how much *tangential* gap its neighbors get on the
    // ring — two large groups anywhere near each other in angle still had
    // their inward bulges collide near the middle, which is exactly the
    // mixed-color mush in the center of the graph. Row packing instead gives
    // every group a genuinely reserved, non-overlapping rectangle: no two
    // groups can overlap regardless of how different their sizes are.
    const INTER_GROUP_GAP = 160;
    const bySize = [...groupsHere].sort((a, b) => (aCounts[b] || 0) + (bCounts[b] || 0) - ((aCounts[a] || 0) + (bCounts[a] || 0)));
    const totalArea = bySize.reduce((s, g) => s + (footprint.get(g) * 2) ** 2, 0);
    const targetRowWidth = Math.max(1400, Math.sqrt(totalArea) * 1.15);
    const groupCenter = new Map();
    let cursorX = 0, cursorY = 0, rowHeight = 0;
    let rowItems = [];
    function closeRow(rowWidth) {
      const offsetX = -rowWidth / 2;
      rowItems.forEach((g) => {
        const c = groupCenter.get(g);
        groupCenter.set(g, { x: c.x + offsetX, y: c.y });
      });
      rowItems = [];
    }
    bySize.forEach((g) => {
      const r = footprint.get(g);
      const diameter = r * 2;
      if (cursorX > 0 && cursorX + diameter > targetRowWidth) {
        closeRow(cursorX - INTER_GROUP_GAP);
        cursorY += rowHeight + INTER_GROUP_GAP;
        cursorX = 0; rowHeight = 0;
      }
      groupCenter.set(g, { x: cursorX + r, y: cursorY + r }); // top-aligned within the row
      rowItems.push(g);
      cursorX += diameter + INTER_GROUP_GAP;
      rowHeight = Math.max(rowHeight, diameter);
    });
    closeRow(cursorX - INTER_GROUP_GAP);
    let minY = Infinity, maxY = -Infinity;
    groupCenter.forEach((c) => { minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y); });
    const yOffset = -(minY + maxY) / 2;
    groupCenter.forEach((c, g) => groupCenter.set(g, { x: c.x, y: c.y + yOffset }));

    const positions = new Map();
    groupsHere.forEach((g) => {
      const c = groupCenter.get(g);
      const { fpA, fpB, gap } = subRadius.get(g);
      const aList = nodeList.filter((n) => groupFor(n.category) === g && isA(n));
      const bList = nodeList.filter((n) => groupFor(n.category) === g && isB(n));
      // centers offset symmetrically along local X so the two disks' edge-to-edge
      // gap is exactly `gap` by construction, not just "probably far enough"
      const aCenter = (fpB > 0) ? { x: c.x - (fpB + gap / 2), y: c.y } : c;
      const bCenter = (fpA > 0) ? { x: c.x + (fpA + gap / 2), y: c.y } : c;
      placeSpiral(aList, aCenter, positions);
      placeSpiral(bList, bCenter, positions);
    });

    const counts = {};
    groupsHere.forEach((g) => { counts[g] = (aCounts[g] || 0) + (bCounts[g] || 0); });
    return { positions, groupsBySize: bySize, groupCounts: counts };
  }

  // Project nodes are a fundamentally different kind of thing from the
  // agent/skill catalog (tracking, not content), so they get their own
  // dedicated layout/ring for the Agents/Skills-only views. "All" mode is
  // the exception: it means literally everything, catalog + projects
  // together, so it needs its own placement for the projects cluster too.
  const catalogNodes = DATA.nodes.filter((n) => n.type !== "project" && n.type !== "claudemd");
  const projectNodesRaw = DATA.nodes.filter((n) => n.type === "project");
  const claudemdNodesRaw = DATA.nodes.filter((n) => n.type === "claudemd");
  // Every claudemd node has exactly one project it belongs to (the "doc"
  // edge built in scan-project-usage.py) — used to anchor its home position
  // a fixed short distance from that project, in whichever mode the project
  // itself is currently placed in.
  const claudemdParentOf = new Map(
    DATA.edges.filter((e) => e.kind === "doc").map((e) => [e.to, e.from])
  );
  function claudemdOffset(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    const angle = ((h >>> 0) % 1000) / 1000 * Math.PI * 2;
    const dist = 58;
    return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
  }

  // The B side is "every catalogued kind that is not an agent", not "skill".
  //
  // It was `n.type === "skill"`, and placeSpiral only ever writes positions for
  // the A list and the B list — so once the build began cataloguing commands
  // and output styles, those nodes fell through both predicates and got NO
  // position at all. homePositionFor then returned undefined and the very next
  // line read `pos.x` off it, so a single command node in the graph threw
  // during construction of allNodes and the entire viewer failed to render.
  // Not a degraded view: a blank page, on a graph the MCP tools answered
  // questions about perfectly well.
  //
  // Splitting agents from everything-else keeps the existing two-disk geometry
  // (and its footprint arithmetic, which now counts these nodes) rather than
  // inventing a third sub-disk. Kind is still carried on the node and shown in
  // the inspector; only the seating chart groups them.
  const allLayout = computeClusterLayoutSplit(catalogNodes, (n) => n.type === "agent", (n) => n.type !== "agent");
  const agentNodesRaw = catalogNodes.filter((n) => n.type === "agent");
  const skillNodesRaw = catalogNodes.filter((n) => n.type === "skill");
  const agentsLayout = computeClusterLayout(agentNodesRaw);
  const skillsLayout = computeClusterLayout(skillNodesRaw);
  const projectsLayout = computeClusterLayout(projectNodesRaw);

  // allLayout and projectsLayout are two independently-computed phyllotaxis
  // rings that both start from the same origin — placed together unmodified
  // they'd land on top of each other. Shift the whole projects cluster down
  // far enough that its highest point still clears the catalog ring's lowest
  // point, with a margin the settle-pass repulsion can't close back up.
  const catalogRawBounds = boundsFromPositions(allLayout.positions);
  const projectsRawBounds = boundsFromPositions(projectsLayout.positions);
  const ALL_MODE_PROJECT_GAP = 400;
  const projectsAllOffsetY = (catalogRawBounds.maxY - projectsRawBounds.minY) + ALL_MODE_PROJECT_GAP;
  const projectsInAllPositions = new Map(
    [...projectsLayout.positions].map(([id, p]) => [id, { x: p.x, y: p.y + projectsAllOffsetY }])
  );

  function projectHomePosition(projectId, mode) {
    return mode === "all" ? projectsInAllPositions.get(projectId) : projectsLayout.positions.get(projectId);
  }
  function homePositionFor(n, mode) {
    if (n.type === "project") return projectHomePosition(n.id, mode);
    if (n.type === "claudemd") {
      // A claudemd node is anchored to its project through a "doc" edge. If
      // that edge is absent — a partial or hand-edited graph — the lookup
      // yields no base, and reading .x off it killed the whole page for the
      // same reason an unplaced command node did. Same remedy: a real position
      // rather than a crash.
      const base = projectHomePosition(claudemdParentOf.get(n.id), mode) || unplacedPosition(n.id);
      const off = claudemdOffset(n.id);
      return { x: base.x + off.x, y: base.y + off.y };
    }
    // agentsLayout only has positions for agent nodes (skillsLayout likewise
    // skill-only) — switchViewMode calls this for EVERY node regardless of
    // its own type, so asking the agents-only layout for a skill's position
    // returned undefined and crashed on the very first click of the Agents
    // or Skills button. A mismatched type falls back to its "all" position
    // instead — it's invisible in that view anyway (passesFilter hides it),
    // it just needs a real, valid home to sit at while hidden.
    if (mode === "agents" && n.type === "agent") return agentsLayout.positions.get(n.id);
    if (mode === "skills" && n.type === "skill") return skillsLayout.positions.get(n.id);
    // Never return undefined. A node the layout did not place used to crash the
    // whole viewer on the next property read — one unplaced node cost the
    // entire page, which is a wildly disproportionate failure for a seating
    // problem. A deterministic scatter near the origin keeps such a node
    // visible and clickable so the gap is reported rather than fatal.
    return allLayout.positions.get(n.id) || unplacedPosition(n.id);
  }

  // Same hash-scatter shape as claudemdOffset: stable across reloads, so an
  // unplaced node does not jump around between sessions.
  function unplacedPosition(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    const angle = ((h >>> 0) % 1000) / 1000 * Math.PI * 2;
    return { x: Math.cos(angle) * 240, y: Math.sin(angle) * 240 };
  }

  const allNodes = DATA.nodes.map((n) => {
    const group = groupFor(n.category);
    const pos = homePositionFor(n, "all");
    return { ...n, group, x: pos.x, y: pos.y, homeX: pos.x, homeY: pos.y, vx: 0, vy: 0, pinned: false };
  });
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const allEdges = DATA.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  // Edge length encodes real relationship strength, not a flat constant.
  // `weight` is how many times the source's own text actually names the
  // target (extracted in build-graph.py) — real counted evidence, most
  // edges are weight 1 (505 of 723: one passing "see also" mention), a
  // smaller set are 2-3, and a handful up to 14 (a skill discussed
  // repeatedly across the same file). Higher weight -> shorter target
  // distance -> stronger visual pull. A cross-group edge additionally gets
  // pushed further out on top of that: crossing a category boundary is
  // itself a "less related" signal even independent of mention count.
  const EDGE_DIST_MAX = 220, EDGE_DIST_MIN = 90, CROSS_GROUP_STRETCH = 1.3;
  allEdges.forEach((e) => {
    // doc edges (project -> its CLAUDE.md) are a structural "belongs to"
    // link, not a content reference — they get a short, fixed target
    // distance so the file visibly hugs its project instead of drifting to
    // wherever the weight formula below would otherwise place it.
    if (e.kind === "doc") { e.targetDist = 58; return; }
    const w = Math.max(1, e.weight || 1);
    const base = EDGE_DIST_MIN + (EDGE_DIST_MAX - EDGE_DIST_MIN) / w;
    const a = byId.get(e.from), b = byId.get(e.to);
    e.targetDist = (a.group !== b.group) ? base * CROSS_GROUP_STRETCH : base;
  });

  // Real-reference degree only — usage edges (project -> skill, "this project
  // has X installed") and doc edges (project -> its CLAUDE.md) are a
  // different signal and must NOT inflate a skill's apparent importance just
  // because a project happens to use it, nor would excluding them from sizing
  // math make sense the other way for a project node, which needs its OWN
  // much wider scale (see below): a 353-skill god node and a 3-skill project
  // should not look remotely similar in size.
  const degree = new Map();
  allNodes.forEach((n) => degree.set(n.id, 0));
  allEdges.forEach((e) => {
    if (e.kind === "usage" || e.kind === "doc") return;
    degree.set(e.from, (degree.get(e.from) || 0) + 1); degree.set(e.to, (degree.get(e.to) || 0) + 1);
  });
  allNodes.forEach((n) => {
    if (n.type === "project") {
      // wider cap than skills/agents on purpose — a real god node (this
      // machine has one at 353 uses) should visibly dwarf everything else,
      // not cap out at the same size as a moderately-popular skill.
      n.r = Math.min(9 + Math.sqrt(n.usesCount || 0) * 3.4, 60);
    } else if (n.type === "claudemd") {
      // fixed, not degree-driven — it has exactly one edge (to its own
      // project) by construction, so degree can't express "how important is
      // this file". CLAUDE.md is always worth seeing clearly: bigger than a
      // typical mid-popularity skill, smaller than a big project node.
      n.r = 24;
    } else {
      n.r = Math.min(7 + Math.sqrt(degree.get(n.id) || 0) * 5.6, 34);
    }
  });

  // Adjacency DOES include usage edges — hovering a project should surface
  // its skills and hovering a skill should surface which projects use it,
  // the same on-demand-reveal mechanism as everything else. What usage edges
  // are excluded from is the physics (below) and the always-on edge
  // rendering (in draw()) — that's where a 353-degree hub would actually
  // cause a problem; plain traversal doesn't care how many neighbors there are.
  const adjacency = new Map();
  allNodes.forEach((n) => adjacency.set(n.id, new Set()));
  allEdges.forEach((e) => { adjacency.get(e.from).add(e.to); adjacency.get(e.to).add(e.from); });
  function neighborsOf(id) { return new Set([id, ...adjacency.get(id)]); }

  // ---- view mode + filter state ----
  // Declared before tick()/the settle loop below, since both read passesFilter.
  const groups = allLayout.groupsBySize;
  const groupCounts = allLayout.groupCounts;
  let viewMode = "all"; // "all" | "agents" | "skills" | "projects" — drives which layout is "home"
  const activeTypes = new Set([...TYPES, "project"]); // default mode is "all" — everything shows
  const activeGroups = new Set(groups);
  // Empty = no tag filter applied (everything passes). Non-empty = a node
  // must carry at least one selected tag (OR, not AND — this is a coarse
  // visual filter for browsing, not get_file_set's precise AND-by-default
  // search; narrowing further than "any of these" would hide too much for a
  // glance-and-explore panel).
  const activeTagFilter = new Set();
  // Category legend/activeGroups is built only from catalogNodes (agents+skills)
  // — project nodes' group ("Your Projects") never appears in it, so gating
  // them on activeGroups.has(n.group) hid every project node unconditionally.
  // Projects aren't part of the category system at all; only type-gate them.
  function passesFilter(n) {
    // claudemd nodes aren't independently toggleable — they're a satellite
    // of their project and always show/hide together with it.
    if (n.type === "project" || n.type === "claudemd") return activeTypes.has("project");
    if (!activeTypes.has(n.type) || !activeGroups.has(n.group)) return false;
    if (activeTagFilter.size === 0) return true;
    return (n.tags || []).some((t) => activeTagFilter.has(t));
  }

  // ===================== physics =====================
  // A 1/distSq repulsion force has a real singularity as distSq -> 0: any two
  // nodes that happen to get close spike toward infinite force. Fixed with a
  // minimum-distance floor (MIN_DIST_SQ) and a hard per-tick speed cap
  // (MAX_SPEED) — both declared up top since tick() runs before this point in
  // the file, during the synchronous layout settle below.
  //
  // Repulsion and edge-springs only apply between nodes that pass the current
  // view/type/group filter — a node hidden by the Agents/Skills view switch
  // must not still be shoving visible nodes around. The home-pull, by
  // contrast, applies unconditionally to every node regardless of visibility,
  // so a hidden node stays parked at its correct position and doesn't drift
  // off from where it'll reappear.
  function tick() {
    // HOME was 0.02, equal to SPRING — a 0-degree node (59 of 354 catalog
    // nodes have no real edges at all) has nothing pulling it home except
    // this, so it drifted wherever repulsion from ~400 other nodes pushed it,
    // landing well outside its own category's cluster. Raised well above
    // SPRING so a node's category membership visibly wins over incidental
    // repulsion, without being so strong it fights real edge springs.
    // CROSS_SPRING << SPRING on purpose: a real cross-category reference
    // (e.g. a security skill mentioning a testing skill) still needs to
    // *exist* as a visible line, but pulling both endpoints together at full
    // strength is what was dragging whole clusters into each other and
    // blurring every category boundary. Weak cross-group pull + a full-
    // strength HOME keeps each category a legible, separated blob while the
    // line itself still shows the real relationship.
    const REPULSION = 7000, SPRING = 0.02, CROSS_SPRING = 0.004, HOME = 0.055, DAMPING = 0.8;
    for (let i = 0; i < allNodes.length; i++) {
      const a = allNodes[i];
      if (!passesFilter(a)) continue;
      for (let j = i + 1; j < allNodes.length; j++) {
        const b = allNodes[j];
        if (!passesFilter(b)) continue;
        let dx = a.x - b.x, dy = a.y - b.y;
        let rawDistSq = dx * dx + dy * dy;
        if (rawDistSq > 1600000) continue;
        const distSq = Math.max(rawDistSq, MIN_DIST_SQ);
        const force = REPULSION / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
    }
    allEdges.forEach((e) => {
      // usage edges (project -> skill) never join the spring simulation — a
      // 353-degree god node with 353 real springs pulling on it would wreck
      // the layout the same way the earlier physics bugs did. They're purely
      // a traversal/highlight relationship (see adjacency above), not a
      // physical one.
      if (e.kind === "usage") return;
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!passesFilter(a) || !passesFilter(b)) return;
      let dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const spring = a.group === b.group ? SPRING : CROSS_SPRING;
      const force = (dist - e.targetDist) * spring;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    });
    allNodes.forEach((n) => { n.vx += (n.homeX - n.x) * HOME; n.vy += (n.homeY - n.y) * HOME; });
    allNodes.forEach((n) => {
      if (n.pinned) return;
      n.vx *= DAMPING; n.vy *= DAMPING;
      const speed = Math.hypot(n.vx, n.vy);
      if (speed > MAX_SPEED) { const s = MAX_SPEED / speed; n.vx *= s; n.vy *= s; }
      n.x += n.vx; n.y += n.vy;
    });
  }

  // Settle real-edge pull and any residual local overlap synchronously, before
  // the window ever paints — this is instant math, not an animation the user
  // watches. Runs until velocities actually die down (not a blind fixed count)
  // so a real settle and a mid-simulation snapshot can never be confused.
  for (let iter = 0; iter < 400; iter++) {
    tick();
    let maxSpeed = 0;
    for (const n of allNodes) maxSpeed = Math.max(maxSpeed, Math.hypot(n.vx, n.vy));
    if (maxSpeed < 0.4) break;
  }
  allNodes.forEach((n) => { n.vx = 0; n.vy = 0; });
  running = false;

  function boundsFromPositions(posMap) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    posMap.forEach((p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
    return { minX, minY, maxX, maxY };
  }
  function boundsFromNodes(nodeList) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodeList.forEach((n) => { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); });
    return { minX, minY, maxX, maxY };
  }
  // "all" bounds come from the physics-settled positions (slightly different
  // from raw phyllotaxis after edges pull things together) — includes every
  // node now that projects are part of the default view too.
  // agents/skills/projects bounds come straight from their own raw layout
  // since no separate settle pass runs for those subsets — the phyllotaxis
  // spacing is already collision-free on its own, verified analytically.
  // Projects-mode bounds include the claudemd satellite positions too — they
  // sit outside their project's own footprint (offset + own radius), so
  // computing bounds from project positions alone can clip them at the edge.
  const projectsAndClaudemdPositions = new Map([
    ...projectsLayout.positions,
    ...claudemdNodesRaw.map((n) => {
      const base = projectsLayout.positions.get(claudemdParentOf.get(n.id)) || unplacedPosition(n.id);
      const off = claudemdOffset(n.id);
      return [n.id, { x: base.x + off.x, y: base.y + off.y }];
    }),
  ]);
  const boundsByMode = {
    all: boundsFromNodes(allNodes),
    agents: boundsFromPositions(agentsLayout.positions),
    skills: boundsFromPositions(skillsLayout.positions),
    projects: boundsFromPositions(projectsAndClaudemdPositions),
  };
  let layoutBounds = boundsByMode.all;

  // ---- breadth-first shortest path (real graph algorithm, not decorative) ----
  function bfsPath(startId, endId) {
    if (startId === endId) return [startId];
    const visited = new Set([startId]);
    const parent = new Map();
    const queue = [startId];
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      for (const nb of adjacency.get(cur)) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        parent.set(nb, cur);
        if (nb === endId) {
          const path = [nb];
          let c = nb;
          while (c !== startId) { c = parent.get(c); path.push(c); }
          return path.reverse();
        }
        queue.push(nb);
      }
    }
    return null;
  }
  function resolveNode(text) {
    const q = text.trim().toLowerCase();
    if (!q) return { notFound: true };
    const exact = allNodes.filter((n) => n.name.toLowerCase() === q);
    if (exact.length === 1) return { node: exact[0] };
    const sub = allNodes.filter((n) => n.name.toLowerCase().includes(q));
    if (sub.length === 1) return { node: sub[0] };
    if (sub.length > 1) return { ambiguous: sub.slice(0, 6) };
    return { notFound: true };
  }
  function resolveCategory(text) {
    const q = text.trim().toLowerCase();
    const exact = groups.find((g) => g.toLowerCase() === q);
    if (exact) return exact;
    const sub = groups.filter((g) => g.toLowerCase().includes(q));
    return sub.length === 1 ? sub[0] : null;
  }

  // ===================== UI chrome =====================
  const viewModeCounts = { all: catalogNodes.length + projectNodesRaw.length + claudemdNodesRaw.length, agents: agentNodesRaw.length, skills: skillNodesRaw.length, projects: projectNodesRaw.length };
  const realEdgeCountForText = allEdges.filter((e) => e.kind !== "usage" && e.kind !== "doc").length;
  function frameTextForMode(mode) {
    if (mode === "agents") return { q: "showing agents", r: `${agentNodesRaw.length} agents` };
    if (mode === "skills") return { q: "showing skills", r: `${skillNodesRaw.length} skills` };
    if (mode === "projects") {
      return { q: "showing your projects", r: `${projectNodesRaw.length} real projects on disk · ${claudemdNodesRaw.length} have a CLAUDE.md node next to them` };
    }
    return {
      q: "showing everything",
      r: `${catalogNodes.length + projectNodesRaw.length + claudemdNodesRaw.length} nodes `
        + `(${catalogNodes.length} agents/skills + ${projectNodesRaw.length} projects + ${claudemdNodesRaw.length} CLAUDE.md), ${realEdgeCountForText} relationships`,
    };
  }
  const viewSwitchEl = document.getElementById("typeFilters");
  const viewBtns = {};
  [["all", "All"], ["agents", "Agents"], ["skills", "Skills"], ["projects", "Projects"]].forEach(([mode, label]) => {
    const btn = document.createElement("div");
    btn.className = "filter-btn view-btn" + (mode === "all" ? " active" : "");
    btn.innerHTML = `${label} <span class="count">${viewModeCounts[mode]}</span>`;
    btn.addEventListener("click", () => {
      switchViewMode(mode);
      queryInput.value = "";
      const t = frameTextForMode(mode);
      frameQueryEl.textContent = t.q; frameResultEl.textContent = t.r;
    });
    viewSwitchEl.appendChild(btn);
    viewBtns[mode] = btn;
  });

  const legendListEl = document.getElementById("legendList");
  const groupItems = {};
  groups.forEach((g) => {
    const item = document.createElement("div");
    item.className = "leg-item";
    item.innerHTML = `<span class="swatch" style="background:${groupColor(g)}"></span><span class="name">${g}</span><span class="n">${groupCounts[g]}</span>`;
    item.addEventListener("click", () => {
      if (activeGroups.has(g)) activeGroups.delete(g); else activeGroups.add(g);
      item.classList.toggle("off");
      requestRedraw();
    });
    legendListEl.appendChild(item);
    groupItems[g] = item;
  });
  document.getElementById("catToggleAll").addEventListener("click", () => {
    const allOn = activeGroups.size === groups.length;
    activeGroups.clear();
    if (!allOn) groups.forEach((g) => activeGroups.add(g));
    Object.entries(groupItems).forEach(([g, el]) => el.classList.toggle("off", !activeGroups.has(g)));
    requestRedraw();
  });

  // Tags are per-node (not one bucket like category) and are how
  // add_tags/get_file_set actually solve "find the correct set of files" —
  // this panel is the app's own window onto that, not a separate feature.
  // Counted straight from whatever's already loaded in DATA, so a tag added
  // via the MCP server since last launch just shows up on next load.
  const tagCounts = {};
  allNodes.forEach((n) => (n.tags || []).forEach((t) => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const allTagNames = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a]);
  const tagListEl = document.getElementById("tagList");
  const tagItems = {};
  if (tagListEl) {
    const tagFilterStatusEl = document.getElementById("tagFilterStatus");
    const NO_FILTER_TEXT = "no tag filter — showing everything (subject to category/type)";
    tagFilterStatusEl.textContent = NO_FILTER_TEXT;
    allTagNames.forEach((t) => {
      const item = document.createElement("div");
      item.className = "leg-item tag-item";
      item.innerHTML = `<span class="name">#${t}</span><span class="n">${tagCounts[t]}</span>`;
      item.addEventListener("click", () => {
        if (activeTagFilter.has(t)) activeTagFilter.delete(t); else activeTagFilter.add(t);
        item.classList.toggle("on", activeTagFilter.has(t));
        tagFilterStatusEl.textContent = activeTagFilter.size
          ? `showing anything tagged: ${[...activeTagFilter].join(", ")}`
          : NO_FILTER_TEXT;
        wake();
      });
      tagListEl.appendChild(item);
      tagItems[t] = item;
    });
    const tagClearEl = document.getElementById("tagClearAll");
    if (tagClearEl) tagClearEl.addEventListener("click", () => {
      activeTagFilter.clear();
      Object.values(tagItems).forEach((el) => el.classList.remove("on"));
      tagFilterStatusEl.textContent = NO_FILTER_TEXT;
      wake();
    });
  }

  const scannedProjects = DATA.scannedProjects || [];
  const installedCount = catalogNodes.filter((n) => (n.usedBy || []).length > 0).length;
  const realEdgeCount = allEdges.filter((e) => e.kind !== "usage" && e.kind !== "doc").length;
  document.getElementById("statLine").textContent =
    `${catalogNodes.length} nodes (${agentNodesRaw.length} agents, ${skillNodesRaw.length} skills) · ${realEdgeCount} relationships · ${groups.length} groups`;
  document.getElementById("statLine2").textContent =
    `${installedCount} of ${catalogNodes.length} are actually installed somewhere · ${scannedProjects.length} real projects scanned on disk · ${claudemdNodesRaw.length} have a CLAUDE.md node (green ring) linked next to them`;

  // Switching view mode re-clusters onto a separately-computed layout (not
  // just a visibility filter on the combined one) — every node's home target
  // moves to its type-specific position and the existing physics glides it
  // there, the same mechanism focus-mode already uses for camera motion, so
  // no new animation system is needed for a transition that's genuinely
  // wanted (as opposed to the settle-on-launch animation, which wasn't).
  function switchViewMode(mode) {
    viewMode = mode;
    activeTypes.clear();
    if (mode === "agents") activeTypes.add("agent");
    else if (mode === "skills") activeTypes.add("skill");
    else if (mode === "projects") activeTypes.add("project");
    else { TYPES.forEach((t) => activeTypes.add(t)); activeTypes.add("project"); } // "all" — literally everything

    allNodes.forEach((n) => {
      const target = homePositionFor(n, mode);
      n.homeX = target.x; n.homeY = target.y;
    });

    Object.entries(viewBtns).forEach(([m, btn]) => btn.classList.toggle("active", m === mode));
    layoutBounds = boundsByMode[mode];
    selected = null; detailEl.classList.remove("open");
    targetCamera = fitCamera();
    // wake()'s ~20-tick budget is fine for a small nudge, but row-packing
    // made the "All" layout much taller (rows stack instead of wrapping a
    // ring), so a project/claudemd node switching between "All" and
    // "Projects" can need to travel thousands of units. With only 20 ticks
    // it froze mid-transition, permanently outside the new tightly-fitted
    // camera — a totally blank canvas that never recovered. wakeFor gives it
    // enough ticks to actually finish the move.
    wakeFor(400);
  }

  function setSoloFilter(kind, value) {
    if (kind === "category") {
      activeGroups.clear(); activeGroups.add(value);
      Object.entries(groupItems).forEach(([g, el]) => el.classList.toggle("off", g !== value));
    } else if (kind === "type") {
      switchViewMode(value === "agent" ? "agents" : "skills");
    }
  }
  function resetFilters() {
    switchViewMode("all");
    activeGroups.clear(); groups.forEach((g) => activeGroups.add(g));
    Object.values(groupItems).forEach((el) => el.classList.remove("off"));
  }

  // ===================== floating panels (mutually exclusive drawers) =====================
  const panels = { style: document.getElementById("stylePanel"), tags: document.getElementById("tagsPanel"), info: document.getElementById("infoPanel"), help: document.getElementById("helpPanel") };
  const railBtns = { style: document.getElementById("railStyle"), tags: document.getElementById("railTags"), info: document.getElementById("railInfo"), help: document.getElementById("railHelp") };
  let openPanel = null;
  function togglePanel(name) {
    if (openPanel === name) { panels[name].classList.add("hidden"); railBtns[name].classList.remove("active"); openPanel = null; return; }
    if (openPanel) { panels[openPanel].classList.add("hidden"); railBtns[openPanel].classList.remove("active"); }
    panels[name].classList.remove("hidden"); railBtns[name].classList.add("active"); openPanel = name;
  }
  railBtns.style.addEventListener("click", () => togglePanel("style"));
  railBtns.tags.addEventListener("click", () => togglePanel("tags"));
  railBtns.info.addEventListener("click", () => togglePanel("info"));
  railBtns.help.addEventListener("click", () => togglePanel("help"));
  document.getElementById("railDb").addEventListener("click", () => { resetAll(); });
  document.getElementById("railSearch").addEventListener("click", () => { queryInput.focus(); });

  // ===================== query bar =====================
  const queryInput = document.getElementById("queryInput");
  const queryHint = document.getElementById("queryHint");
  const frameQueryEl = document.getElementById("frameQuery");
  const frameResultEl = document.getElementById("frameResult");
  const runBtn = document.getElementById("runBtn");

  let pathResult = null; // {ids:[...], edgeKeys:Set} — from `path A -> B`
  let highlightSet = null; // Set of ids — from find/best/neighbors

  function parseQuery(raw) {
    const q = raw.trim();
    if (!q) return { kind: "reset" };
    let m;
    if ((m = q.match(/^path\s+(.+?)\s*(?:->|→|to)\s*(.+)$/i))) return { kind: "path", a: m[1].trim(), b: m[2].trim() };
    if ((m = q.match(/^(?:neighbors|related)\s+(.+)$/i))) return { kind: "neighbors", name: m[1].trim() };
    if ((m = q.match(/^open\s+(.+)$/i))) return { kind: "open", name: m[1].trim() };
    if ((m = q.match(/^best(?:\s+(\d+))?$/i))) return { kind: "best", n: m[1] ? parseInt(m[1], 10) : 15 };
    if ((m = q.match(/^projects\s+(.+)$/i))) return { kind: "projects", name: m[1].trim() };
    if ((m = q.match(/^project:\s*(.+)$/i))) return { kind: "projectFilter", label: m[1].trim() };
    if ((m = q.match(/^cat(?:egory)?:\s*(.+)$/i))) return { kind: "category", cat: m[1].trim() };
    // Accepts any kind actually present in the graph, singular or plural, so a
    // kind added to claude-infra.json cannot silently stop being addressable.
    // The old form hardcoded (agent|skill): "type:command" failed the regex,
    // fell through to the text branch below, and searched for the literal
    // string "type:command" — zero matches, no error, no hint.
    if ((m = q.match(/^type:\s*([a-z][a-z-]*?)s?$/i))) {
      const t = m[1].toLowerCase();
      if (TYPES.includes(t)) return { kind: "type", type: t };
      return { kind: "badType", asked: m[1], known: TYPES };
    }
    if ((m = q.match(/^find\s+(.+)$/i))) return { kind: "search", text: m[1].trim() };
    return { kind: "search", text: q };
  }

  function runQuery() {
    const parsed = parseQuery(queryInput.value);
    pathResult = null; highlightSet = null;
    queryHint.textContent = "";

    if (parsed.kind === "reset") {
      resetFilters();
      const t = frameTextForMode("all");
      frameQueryEl.textContent = t.q; frameResultEl.textContent = t.r;
    } else if (parsed.kind === "search") {
      // Same per-term rule as graph-query.js find(), for the same reason: a
      // whole-query substring test cannot express "image generation" against a
      // node named image-generation.
      const terms = parsed.text.toLowerCase().split(/\s+/).filter(Boolean);
      const matched = terms.length
        ? allNodes.filter((n) => {
            const hay = `${n.name} ${n.description || ""} ${n.category}`.toLowerCase();
            return terms.every((t) => hay.includes(t));
          })
        : [];
      highlightSet = new Set(matched.map((n) => n.id));
      frameQueryEl.textContent = `find "${parsed.text}"`;
      // The highlight set is built from every node; the canvas only draws what
      // passesFilter() admits. Reporting the match count alone let the frame
      // say "4 matched" over an empty canvas whenever a type, category or tag
      // filter excluded them — indistinguishable, from the user's side, from
      // the node not being in the graph at all.
      const hidden = matched.filter((n) => !passesFilter(n)).length;
      frameResultEl.textContent = `${matched.length} matched`
        + (hidden ? ` · ${hidden} hidden by filters` : "");
      if (hidden && hidden === matched.length) {
        queryHint.textContent = `all ${hidden} match${hidden === 1 ? "" : "es"} are hidden by the current filters — clear them to see ${hidden === 1 ? "it" : "them"}`;
      }
    } else if (parsed.kind === "badType") {
      frameQueryEl.textContent = `type: ${parsed.asked}`;
      frameResultEl.textContent = "no match";
      queryHint.textContent = `no node kind "${parsed.asked}" in this graph — try: ${parsed.known.join(", ")}`;
    } else if (parsed.kind === "open") {
      const r = resolveNode(parsed.name);
      frameQueryEl.textContent = `open ${parsed.name}`;
      if (r.notFound) { queryHint.textContent = `no node matches "${parsed.name}"`; frameResultEl.textContent = "no match"; return; }
      if (r.ambiguous) { queryHint.textContent = `ambiguous — did you mean: ${r.ambiguous.map((n) => n.name).join(", ")}?`; frameResultEl.textContent = "ambiguous"; return; }
      highlightSet = new Set([r.node.id]);
      selected = r.node; openDetail(r.node);
      frameResultEl.textContent = "revealing in Finder…";
      window.graphAPI.revealFile(r.node.path).then((res) => {
        frameResultEl.textContent = res.ok ? `revealed: ${r.node.path}` : `couldn't reveal file — ${res.reason}`;
      });
    } else if (parsed.kind === "best") {
      const pool = allNodes.filter(passesFilter);
      const ranked = [...pool].sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0)).slice(0, parsed.n);
      highlightSet = new Set(ranked.map((n) => n.id));
      frameQueryEl.textContent = `best ${parsed.n}${viewMode !== "all" ? " (" + viewMode + ")" : ""}`;
      const preview = ranked.slice(0, 5).map((n) => `${n.name} (${degree.get(n.id)})`).join(", ");
      frameResultEl.textContent = preview + (ranked.length > 5 ? ` +${ranked.length - 5} more` : "");
    } else if (parsed.kind === "neighbors") {
      const r = resolveNode(parsed.name);
      frameQueryEl.textContent = `neighbors ${parsed.name}`;
      if (r.notFound) { queryHint.textContent = `no node matches "${parsed.name}"`; frameResultEl.textContent = "no match"; return; }
      if (r.ambiguous) { queryHint.textContent = `ambiguous — did you mean: ${r.ambiguous.map((n) => n.name).join(", ")}?`; frameResultEl.textContent = "ambiguous"; return; }
      const touching = allEdges.filter((e) => e.from === r.node.id || e.to === r.node.id).sort((a, b) => b.weight - a.weight);
      const ids = new Set([r.node.id, ...touching.map((e) => (e.from === r.node.id ? e.to : e.from))]);
      highlightSet = ids;
      selected = r.node; openDetail(r.node);
      const strongest = touching.slice(0, 4).map((e) => byId.get(e.from === r.node.id ? e.to : e.from).name);
      frameResultEl.textContent = `${ids.size - 1} connection${ids.size - 1 === 1 ? "" : "s"} · strongest: ${strongest.join(", ") || "none"}`;
    } else if (parsed.kind === "projects") {
      const r = resolveNode(parsed.name);
      frameQueryEl.textContent = `projects ${parsed.name}`;
      if (r.notFound) { queryHint.textContent = `no node matches "${parsed.name}"`; frameResultEl.textContent = "no match"; return; }
      if (r.ambiguous) { queryHint.textContent = `ambiguous — did you mean: ${r.ambiguous.map((n) => n.name).join(", ")}?`; frameResultEl.textContent = "ambiguous"; return; }
      highlightSet = new Set([r.node.id]);
      selected = r.node; openDetail(r.node);
      const used = r.node.usedBy || [];
      frameResultEl.textContent = used.length ? `installed in ${used.length}: ${used.join(", ")}` : "not installed in any scanned project";
    } else if (parsed.kind === "projectFilter") {
      const q = parsed.label.toLowerCase();
      const matched = allNodes.filter((n) => (n.usedBy || []).some((p) => p.toLowerCase().includes(q)));
      frameQueryEl.textContent = `project: ${parsed.label}`;
      if (!matched.length) { queryHint.textContent = `no scanned project matches "${parsed.label}"`; frameResultEl.textContent = "no match"; return; }
      highlightSet = new Set(matched.map((n) => n.id));
      frameResultEl.textContent = `${matched.length} skills/agents installed in this project`;
    } else if (parsed.kind === "category") {
      const resolved = resolveCategory(parsed.cat);
      if (!resolved) { queryHint.textContent = `no category matches "${parsed.cat}" — try one from the Style panel`; frameResultEl.textContent = "no match"; return; }
      setSoloFilter("category", resolved);
      frameQueryEl.textContent = `category: ${resolved}`;
      frameResultEl.textContent = `${groupCounts[resolved]} nodes`;
    } else if (parsed.kind === "type") {
      setSoloFilter("type", parsed.type);
      frameQueryEl.textContent = `type: ${parsed.type}`;
      // Counted from the graph, not looked up in the two-entry view-mode map —
      // that map only has "agents" and "skills", so every other kind reported
      // the skill count.
      frameResultEl.textContent = `${allNodes.filter((n) => n.type === parsed.type).length} nodes`;
    } else if (parsed.kind === "path") {
      const ra = resolveNode(parsed.a), rb = resolveNode(parsed.b);
      frameQueryEl.textContent = `path ${parsed.a} -> ${parsed.b}`;
      if (ra.notFound || rb.notFound) {
        queryHint.textContent = `no node matches "${ra.notFound ? parsed.a : parsed.b}"`;
        frameResultEl.textContent = "no match"; return;
      }
      if (ra.ambiguous || rb.ambiguous) {
        const amb = ra.ambiguous || rb.ambiguous;
        queryHint.textContent = `ambiguous — did you mean: ${amb.map((n) => n.name).join(", ")}?`;
        frameResultEl.textContent = "ambiguous"; return;
      }
      const path = bfsPath(ra.node.id, rb.node.id);
      if (!path) {
        frameResultEl.textContent = "no path found";
        queryHint.textContent = `"${ra.node.name}" and "${rb.node.name}" are not connected through any reference chain`;
      } else {
        const edgeKeys = new Set();
        for (let i = 0; i < path.length - 1; i++) edgeKeys.add(path[i] + "|" + path[i + 1]);
        for (let i = 0; i < path.length - 1; i++) edgeKeys.add(path[i + 1] + "|" + path[i]);
        pathResult = { ids: path, edgeKeys };
        frameResultEl.textContent = `${path.length - 1} hop${path.length - 1 === 1 ? "" : "s"} · ${path.map((id) => byId.get(id).name).join(" → ")}`;
      }
    }
    requestRedraw();
  }
  queryInput.addEventListener("input", runQuery);
  queryInput.addEventListener("keydown", (evt) => { if (evt.key === "Enter") runQuery(); });
  runBtn.addEventListener("click", runQuery);

  function resetAll() {
    queryInput.value = ""; runQuery();
    selected = null; detailEl.classList.remove("open");
    if (focused) exitFocus(); else { targetCamera = fitCamera(); wake(); }
  }

  // ===================== detail panel (node property inspector) =====================
  const detailEl = document.getElementById("detail");
  const detailBody = document.getElementById("detailBody");
  function relList(title, ids) {
    if (!ids.length) return "";
    let html = `<div class="d-row"><b>${title} (${ids.length})</b>`;
    ids.forEach((id) => {
      const t = byId.get(id);
      if (!t) return;
      html += `<div class="rel-item" data-jump="${id}">→ [${t.type}] ${t.name}</div>`;
    });
    html += "</div>";
    return html;
  }
  // Tags are read-only here (set via add_tags over MCP — this app has no
  // write path for them, only the filter panel reads them). Rating and
  // notes ARE real, local writes: click a star or submit a note and it goes
  // straight through IPC to the exact same overlay.json the MCP server
  // writes, immediately, no round trip through Claude Code required.
  function notesAndRatingHtml(n) {
    let html = `<div class="d-section-divider">Your notes</div><div id="writeStatus" class="write-status hidden"></div>`;
    const filled = n.avgRating ? Math.round(n.avgRating) : 0;
    let starsHtml = "";
    for (let i = 1; i <= 5; i++) starsHtml += `<span class="rate-star${i <= filled ? " filled" : ""}" data-star="${i}" title="rate ${i}">★</span>`;
    html += `<div class="d-row"><b>rating</b><div class="rate-stars" id="rateStars">${starsHtml}</div>`;
    html += n.avgRating
      ? `<span class="rate-summary">${n.avgRating} · ${n.ratings.length} rating${n.ratings.length === 1 ? "" : "s"}</span>`
      : `<span class="rate-summary faint">not rated — click a star</span>`;
    html += `</div>`;

    if (n.tags && n.tags.length) {
      html += `<div class="d-row"><b>tags</b>${n.tags.map((t) => `<span class="tool-chip">#${t}</span>`).join("")}</div>`;
    }

    html += `<div class="d-row"><b>notes${n.notes && n.notes.length ? ` (${n.notes.length})` : ""}</b>`;
    if (n.notes && n.notes.length) {
      n.notes.forEach((note) => {
        html += `<div class="note-item"><div>${note.text}</div><div class="note-date">${note.at}</div></div>`;
      });
    }
    html += `<div class="note-add"><textarea id="noteInput" class="mono" placeholder="add a note…" rows="2"></textarea><button id="noteSubmit">Add note</button></div></div>`;
    return html;
  }
  function wireDetailInteractions(n) {
    const pb = document.getElementById("pathBox");
    if (pb) pb.addEventListener("click", () => {
      navigator.clipboard.writeText(n.path).catch(() => {});
      pb.classList.add("flash"); setTimeout(() => pb.classList.remove("flash"), 900);
    });
    detailBody.querySelectorAll(".rel-item").forEach((el) => {
      el.addEventListener("click", () => {
        const target = byId.get(el.dataset.jump);
        if (target) { selected = target; openDetail(target); wake(); }
      });
    });

    const statusEl = document.getElementById("writeStatus");
    function showWriteError(msg) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.classList.remove("hidden");
    }
    detailBody.querySelectorAll(".rate-star").forEach((s) => {
      s.addEventListener("click", async () => {
        const rating = parseInt(s.dataset.star, 10);
        const res = await window.graphAPI.rateNode(n.id, rating);
        if (res && res.ok) { n.avgRating = res.avgRating; n.ratings = res.ratings; openDetail(n); }
        else showWriteError((res && res.error) || "couldn't save rating");
      });
    });
    const noteBtn = document.getElementById("noteSubmit");
    if (noteBtn) noteBtn.addEventListener("click", async () => {
      const input = document.getElementById("noteInput");
      const text = input.value.trim();
      if (!text) return;
      const res = await window.graphAPI.addNote(n.id, text);
      if (res && res.ok) { n.notes = res.notes; openDetail(n); }
      else showWriteError((res && res.error) || "couldn't save note");
    });
  }

  function openDetail(n) {
    if (n.type === "project") { openDetailProject(n); return; }
    if (n.type === "claudemd") { openDetailClaudemd(n); return; }
    const out = allEdges.filter((e) => e.from === n.id && e.kind !== "usage").map((e) => e.to);
    const inn = allEdges.filter((e) => e.to === n.id && e.kind !== "usage").map((e) => e.from);
    let html = `<span class="kind-tag" style="background:${groupColor(n.group)}33;color:${groupColor(n.group)}">${n.type}</span>`;
    html += `<span class="kind-tag" style="background:var(--panel-3);color:var(--text-faint)">${n.repo}</span>`;
    html += `<p class="d-title">${n.name}</p>`;
    html += `<table class="prop-table">
      <tr><td>group</td><td>${n.group}</td></tr>
      <tr><td>category</td><td>${n.category}</td></tr>
      <tr><td>degree</td><td>${degree.get(n.id) || 0} connection${(degree.get(n.id) || 0) === 1 ? "" : "s"}</td></tr>
    </table>`;
    html += `<p class="d-desc">${n.description || "(no description)"}</p>`;
    if (n.tools && n.tools.length) html += `<div class="d-row"><b>tools</b>${n.tools.map((t) => `<span class="tool-chip">${t}</span>`).join("")}</div>`;
    html += `<div class="d-row"><b>file</b><div class="path-box" id="pathBox">${n.path}<span class="copied">copied</span></div></div>`;
    const usedBy = n.usedBy || [];
    if (usedBy.length) {
      html += `<div class="d-row"><b>installed in (${usedBy.length} project${usedBy.length === 1 ? "" : "s"})</b>${usedBy.map((p) => `<span class="tool-chip">${p}</span>`).join("")}</div>`;
    } else {
      html += `<div class="d-row"><b>installed in</b><span style="color:var(--text-faint)">not found in any scanned project</span></div>`;
    }
    html += relList("references (pairs with)", out);
    html += relList("referenced by", inn);
    if (!out.length && !inn.length) html += `<div class="d-row" style="color:var(--text-faint)">no detected cross-references</div>`;
    html += notesAndRatingHtml(n);
    detailBody.innerHTML = html;
    detailEl.classList.add("open");
    wireDetailInteractions(n);
  }

  function openDetailProject(n) {
    const uses = allEdges.filter((e) => e.from === n.id && e.kind === "usage").map((e) => e.to);
    const docEdge = allEdges.find((e) => e.from === n.id && e.kind === "doc");
    let html = `<span class="kind-tag" style="background:${groupColor(n.group)}33;color:${groupColor(n.group)}">project</span>`;
    html += n.hasClaudeMd
      ? `<span class="kind-tag" style="background:rgba(87,217,163,0.15);color:var(--good)">has CLAUDE.md</span>`
      : `<span class="kind-tag" style="background:var(--panel-3);color:var(--text-faint)">no CLAUDE.md</span>`;
    html += `<p class="d-title">${n.name}</p>`;
    html += `<p class="d-desc">${n.description || ""}</p>`;
    html += `<table class="prop-table">
      <tr><td>uses</td><td>${uses.length} of ${catalogNodes.length} catalogued skills/agents</td></tr>
    </table>`;
    html += `<div class="d-row"><b>real location</b><div class="path-box" id="pathBox">${n.path}<span class="copied">copied</span></div></div>`;
    if (docEdge) html += relList("CLAUDE.md", [docEdge.to]);
    if (uses.length) html += relList(`installed here (${uses.length})`, uses);
    else html += `<div class="d-row" style="color:var(--text-faint)">none of the ${catalogNodes.length} catalogued skills/agents are installed here yet</div>`;
    html += notesAndRatingHtml(n);
    detailBody.innerHTML = html;
    detailEl.classList.add("open");
    wireDetailInteractions(n);
  }

  function openDetailClaudemd(n) {
    const parentEdge = allEdges.find((e) => e.kind === "doc" && e.to === n.id);
    const parent = parentEdge ? byId.get(parentEdge.from) : null;
    let html = `<span class="kind-tag" style="background:rgba(87,217,163,0.15);color:var(--good)">CLAUDE.md</span>`;
    html += `<p class="d-title">${n.name}</p>`;
    html += `<p class="d-desc">${n.description || ""}</p>`;
    html += `<div class="d-row"><b>real location</b><div class="path-box" id="pathBox">${n.path}<span class="copied">copied</span></div></div>`;
    if (parent) html += relList("belongs to", [parent.id]);
    html += notesAndRatingHtml(n);
    detailBody.innerHTML = html;
    detailEl.classList.add("open");
    wireDetailInteractions(n);
  }
  document.getElementById("detailClose").addEventListener("click", () => { detailEl.classList.remove("open"); selected = null; requestRedraw(); });

  // ===================== focus mode =====================
  const focusBadge = document.getElementById("focusBadge");

  // Concentric rings around a center, filled outward — not one giant ring,
  // which for a 353-use project would need a ~2800-unit-radius circle to
  // keep nodes from overlapping. Rings fill at a fixed arc-spacing (enough
  // for the largest node radius) and start a new ring outward once the
  // current one is full, so this stays compact and readable whether a
  // project uses 3 skills or 353 of them.
  function computeBurstPositions(centerX, centerY, ids) {
    const ARC_SPACING = 46, RING_GAP = 90, FIRST_RING_R = 130;
    const positions = new Map();
    let ring = 0, placed = 0;
    while (placed < ids.length) {
      const r = FIRST_RING_R + ring * RING_GAP;
      const capacity = Math.max(6, Math.floor((2 * Math.PI * r) / ARC_SPACING));
      const countThisRing = Math.min(capacity, ids.length - placed);
      for (let i = 0; i < countThisRing; i++) {
        const angle = (i / countThisRing) * Math.PI * 2 + ring * 0.35; // stagger so rings don't align radially
        positions.set(ids[placed], { x: centerX + Math.cos(angle) * r, y: centerY + Math.sin(angle) * r });
        placed++;
      }
      ring++;
    }
    return positions;
  }

  // A project is a "god node" on purpose — this is where that's actually
  // shown, not hidden. Its used skills/agents are pulled out of their normal
  // category clusters into a wheel around it, on demand, one project at a
  // time (never all 46 simultaneously — THAT's what the rest of the app
  // deliberately avoids). usesCount can be in the hundreds, so this reuses
  // the same "away from the default, on demand" principle as the usage-edge
  // highlight-on-hover already did, just with real repositioning instead of
  // just a highlighted line to wherever the skill normally lives.
  let hubBurst = null;
  function beginProjectHub(projectNode) {
    const usedIds = allEdges
      .filter((e) => e.from === projectNode.id && e.kind === "usage" && byId.has(e.to))
      .map((e) => e.to);
    if (!usedIds.length) return null;
    const savedTypes = new Set(activeTypes);
    TYPES.forEach((t) => activeTypes.add(t)); // visible even if the current view mode is Projects-only
    const savedHomes = new Map();
    const burstPositions = computeBurstPositions(projectNode.homeX, projectNode.homeY, usedIds);
    usedIds.forEach((id) => {
      const node = byId.get(id);
      savedHomes.set(id, { homeX: node.homeX, homeY: node.homeY });
      const p = burstPositions.get(id);
      node.homeX = p.x; node.homeY = p.y;
    });
    return { savedHomes, savedTypes };
  }
  function endProjectHub(hub) {
    hub.savedHomes.forEach((pos, id) => {
      const node = byId.get(id);
      if (node) { node.homeX = pos.homeX; node.homeY = pos.homeY; }
    });
    activeTypes.clear();
    hub.savedTypes.forEach((t) => activeTypes.add(t));
  }

  function enterFocus(n) {
    // double-clicking straight from one focused project to another skips
    // exitFocus entirely — always clean up any live burst first so its
    // skills don't get stranded at their old burst position forever.
    if (hubBurst) { endProjectHub(hubBurst); hubBurst = null; }
    focused = n;
    if (n.type === "project") hubBurst = beginProjectHub(n);
    const ids = neighborsOf(n.id);
    const pts = allNodes.filter((m) => ids.has(m.id));
    // framed on homeX/homeY (where nodes are HEADING), not x/y (where they
    // currently are) — for a fresh burst those are two very different
    // places, and the camera needs to land on the destination, not the start.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach((p) => { minX = Math.min(minX, p.homeX); maxX = Math.max(maxX, p.homeX); minY = Math.min(minY, p.homeY); maxY = Math.max(maxY, p.homeY); });
    const pad = 120;
    const bw = Math.max(maxX - minX + pad * 2, 200), bh = Math.max(maxY - minY + pad * 2, 200);
    const z = Math.min(viewW / bw, viewH / bh, 2.2);
    targetCamera = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom: z };
    focusBadge.style.display = "block";
    wakeFor(hubBurst ? 400 : 20);
  }
  function exitFocus() {
    focused = null;
    const hadHub = !!hubBurst;
    if (hubBurst) { endProjectHub(hubBurst); hubBurst = null; }
    focusBadge.style.display = "none";
    targetCamera = fitCamera();
    wakeFor(hadHub ? 400 : 20);
  }
  focusBadge.addEventListener("click", exitFocus);

  // ===================== canvas + camera =====================
  const canvas = document.getElementById("graph");
  const ctx = canvas.getContext("2d");
  const wrapEl = document.getElementById("canvasWrap");
  let viewW = 0, viewH = 0;
  const camera = { x: 0, y: 0, zoom: 0.3 };
  let targetCamera = null;

  // zoom-to-fit whichever mode's bounds are currently active.
  function fitCamera() {
    const pad = 100;
    const bw = Math.max(layoutBounds.maxX - layoutBounds.minX + pad * 2, 200);
    const bh = Math.max(layoutBounds.maxY - layoutBounds.minY + pad * 2, 200);
    const z = Math.max(Math.min(viewW / bw, viewH / bh, 1.4), 0.04);
    return { x: (layoutBounds.minX + layoutBounds.maxX) / 2, y: (layoutBounds.minY + layoutBounds.maxY) / 2, zoom: z };
  }

  function resize() {
    const rect = wrapEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    viewW = rect.width; viewH = rect.height;
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    requestRedraw();
  }
  window.addEventListener("resize", resize);
  resize();
  Object.assign(camera, fitCamera()); // first real frame is already correctly framed, no pan-in animation

  function w2s(wx, wy) { return { x: (wx - camera.x) * camera.zoom + viewW / 2, y: (wy - camera.y) * camera.zoom + viewH / 2 }; }
  function s2w(sx, sy) { return { x: (sx - viewW / 2) / camera.zoom + camera.x, y: (sy - viewH / 2) / camera.zoom + camera.y }; }

  let hovered = null, selected = null, focused = null;
  let dragging = null, panStart = null, camStart = null;

  function activeHighlightSet() {
    if (pathResult) return new Set(pathResult.ids);
    if (highlightSet) return highlightSet;
    if (selected) return neighborsOf(selected.id);
    if (hovered) return neighborsOf(hovered.id);
    return null;
  }

  function nodeAt(sx, sy) {
    const w = s2w(sx, sy);
    let best = null, bestD = Infinity;
    for (const n of allNodes) {
      if (!passesFilter(n)) continue;
      const dx = n.x - w.x, dy = n.y - w.y;
      const d = dx * dx + dy * dy;
      const hitR = Math.max(n.r, 7) + 5 / camera.zoom;
      if (d <= hitR * hitR && d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  function draw() {
    ctx.clearRect(0, 0, viewW, viewH);
    const active = activeHighlightSet();
    const isPath = !!pathResult;

    ctx.lineWidth = 1;
    allEdges.forEach((e) => {
      // usage edges never draw in the default always-on pass — a project
      // using 353 skills would permanently paint 353 lines radiating from one
      // point. They still draw in the active-highlight pass below, on demand.
      if (e.kind === "usage") return;
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!passesFilter(a) || !passesFilter(b)) return;
      const key = e.from + "|" + e.to;
      const onPath = isPath && pathResult.edgeKeys.has(key);
      if (onPath) return;
      const dim = !!active && !(active.has(a.id) && active.has(b.id));
      const pa = w2s(a.x, a.y), pb = w2s(b.x, b.y);
      if (e.kind === "doc") {
        // Only 18 of these exist — no clutter risk like usage edges have —
        // so a project's link to its own CLAUDE.md gets to be genuinely
        // bold, not just technically-non-invisible like a regular reference
        // line. Same green as the CLAUDE.md node's ring, so the line and
        // the thing it points at read as one signal.
        ctx.save();
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = dim ? "rgba(87,217,163,0.12)" : "rgba(87,217,163,0.85)";
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        ctx.restore();
        return;
      }
      // Was rgba(76,84,91,0.22) — dark grey at 22% on a near-black canvas is
      // effectively invisible at any zoom wider than "hovering one node".
      // Every edge should read as a real line by default, not just on hover.
      ctx.strokeStyle = dim ? "rgba(120,130,140,0.10)" : "rgba(150,162,176,0.55)";
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    });
    if (active && !isPath) {
      ctx.lineWidth = 1.7; ctx.strokeStyle = "rgba(90,167,240,0.75)";
      allEdges.forEach((e) => {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!passesFilter(a) || !passesFilter(b)) return;
        if (!(active.has(a.id) && active.has(b.id))) return;
        const pa = w2s(a.x, a.y), pb = w2s(b.x, b.y);
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      });
    }
    if (isPath) {
      ctx.lineWidth = 2.6; ctx.strokeStyle = "rgba(240,168,104,0.95)";
      for (let i = 0; i < pathResult.ids.length - 1; i++) {
        const a = byId.get(pathResult.ids[i]), b = byId.get(pathResult.ids[i + 1]);
        const pa = w2s(a.x, a.y), pb = w2s(b.x, b.y);
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
        ctx.font = "9px ui-monospace, 'SF Mono', monospace";
        ctx.fillStyle = "rgba(240,168,104,0.9)"; ctx.textAlign = "center";
        ctx.fillText("REFS", mx, my - 3);
      }
    } else if (active) {
      ctx.font = "8.5px ui-monospace, 'SF Mono', monospace";
      ctx.fillStyle = "rgba(154,161,168,0.65)"; ctx.textAlign = "center";
      allEdges.forEach((e) => {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!passesFilter(a) || !passesFilter(b)) return;
        if (!(active.has(a.id) && active.has(b.id))) return;
        const pa = w2s(a.x, a.y), pb = w2s(b.x, b.y);
        ctx.fillText(e.kind === "usage" ? "USES" : "REFS", (pa.x + pb.x) / 2, (pa.y + pb.y) / 2 - 3);
      });
    }

    allNodes.forEach((n) => {
      if (!passesFilter(n)) return;
      const onPath = isPath && pathResult.ids.includes(n.id);
      const dimmed = active ? (!active.has(n.id) && !onPath) : false;
      const p = w2s(n.x, n.y);
      if (p.x < -40 || p.x > viewW + 40 || p.y < -40 || p.y > viewH + 40) return;
      // node size stays legible even fully zoomed out — real camera.zoom still
      // drives everything else (position, edges, labels), only the node-size
      // formula has a floor so degree differences read at any zoom level.
      const sizeZoom = Math.min(Math.max(camera.zoom, 0.55), 1.6);
      const r = n.r * sizeZoom + 2;
      const alpha = dimmed ? 0.1 : 1;

      // glow is a signal, not ambient decoration — only nodes that are
      // actually part of the highlighted/path set get one.
      if (onPath || n === selected || n === hovered) {
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.8, 0, Math.PI * 2);
        ctx.fillStyle = onPath ? "rgba(240,168,104,0.16)" : groupColorRGBA(n.group, 0.16);
        ctx.fill();
      }
      // Every node type is the same solid circle now — project and CLAUDE.md
      // read as kin (both "your real stuff on disk"), not a different shape
      // fighting the color(category) + ring(type) + size(importance) signals
      // that already do the differentiating work.
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = groupColorRGBA(n.group, alpha); ctx.fill();
      const ring = TYPE_RING[n.type];
      if (ring && !dimmed) {
        ctx.lineWidth = ring.width;
        ctx.strokeStyle = ring.color;
        ctx.stroke();
      }
      if (onPath) {
        ctx.lineWidth = 2.2; ctx.strokeStyle = "rgba(240,168,104,0.95)";
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2); ctx.stroke();
      } else if (n === selected || n === hovered) {
        ctx.lineWidth = 2; ctx.strokeStyle = "rgba(232,234,237,0.9)";
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2); ctx.stroke();
      }

      // Text only appears on interaction — hovered, selected, on the active
      // path, or a neighbor of whichever node is currently hovered/selected.
      const showText = !dimmed && (n === hovered || n === selected || onPath || (active && active.has(n.id)));
      if (showText) {
        if (r > 15) {
          ctx.font = "600 9px -apple-system, sans-serif";
          ctx.fillStyle = "#0B0D0B"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          const label = n.name.length > 12 ? n.name.slice(0, 11) + "…" : n.name;
          ctx.fillText(label, p.x, p.y + 0.5);
          ctx.textBaseline = "alphabetic";
        } else {
          ctx.font = "10px ui-monospace, 'SF Mono', Menlo, monospace";
          ctx.fillStyle = "rgba(232,234,237,0.85)"; ctx.textAlign = "center";
          ctx.fillText(n.name, p.x, p.y + r + 12);
        }
      }
    });
  }

  // ===================== animation loop, sleeps when settled =====================
  const fpsEl = document.getElementById("fps");
  let lastT = performance.now(), frameCount = 0, fpsAcc = 0;
  function loop(t) {
    if (targetCamera) {
      camera.x += (targetCamera.x - camera.x) * 0.12;
      camera.y += (targetCamera.y - camera.y) * 0.12;
      camera.zoom += (targetCamera.zoom - camera.zoom) * 0.12;
      if (Math.abs(targetCamera.zoom - camera.zoom) < 0.001) targetCamera = null;
    }
    if (running) {
      tick();
      settleFrames++;
      if (settleFrames > 500) running = false;
    }
    draw();
    const dt = t - lastT; lastT = t; frameCount++; fpsAcc += dt;
    if (fpsAcc > 500) { fpsEl.textContent = (1000 / (fpsAcc / frameCount)).toFixed(0) + " fps"; fpsAcc = 0; frameCount = 0; }
    if (running || targetCamera || dragging || panStart) requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  function wake() { if (!running) { running = true; settleFrames = 480; requestAnimationFrame(loop); } }
  // wake() only budgets ~20 more ticks (settleFrames starts at 480, stops at
  // 500) — fine for a single dragged node, not enough for a project hub
  // burst where hundreds of nodes need to travel a real distance to their
  // new radial position. minFrames gives it a bigger budget to actually
  // finish settling instead of freezing mid-animation.
  function wakeFor(minFrames) {
    settleFrames = Math.min(settleFrames, 500 - minFrames);
    if (!running) { running = true; requestAnimationFrame(loop); }
  }
  function requestRedraw() { if (!running) requestAnimationFrame(draw); }

  // ===================== pointer interaction =====================
  canvas.addEventListener("pointerdown", (evt) => {
    const rect = canvas.getBoundingClientRect();
    const sx = evt.clientX - rect.left, sy = evt.clientY - rect.top;
    const n = nodeAt(sx, sy);
    if (n) { dragging = n; n.pinned = true; canvas.setPointerCapture(evt.pointerId); wake(); }
    else { panStart = { x: evt.clientX, y: evt.clientY }; camStart = { x: camera.x, y: camera.y }; canvas.classList.add("panning"); }
  });
  canvas.addEventListener("pointermove", (evt) => {
    const rect = canvas.getBoundingClientRect();
    const sx = evt.clientX - rect.left, sy = evt.clientY - rect.top;
    if (dragging) {
      const w = s2w(sx, sy);
      dragging.x = w.x; dragging.y = w.y; dragging.vx = 0; dragging.vy = 0;
      requestRedraw(); return;
    }
    if (panStart) {
      camera.x = camStart.x - (evt.clientX - panStart.x) / camera.zoom;
      camera.y = camStart.y - (evt.clientY - panStart.y) / camera.zoom;
      requestRedraw(); return;
    }
    const n = nodeAt(sx, sy);
    if (n !== hovered) { hovered = n; canvas.classList.toggle("hoverable", !!n); requestRedraw(); }
  });
  function endDrag() { if (dragging) { dragging.pinned = false; dragging = null; } panStart = null; canvas.classList.remove("panning"); }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointerleave", () => { endDrag(); if (hovered) { hovered = null; requestRedraw(); } });

  canvas.addEventListener("click", (evt) => {
    const rect = canvas.getBoundingClientRect();
    const n = nodeAt(evt.clientX - rect.left, evt.clientY - rect.top);
    if (n) { selected = selected === n ? null : n; if (selected) openDetail(selected); else detailEl.classList.remove("open"); }
    else { selected = null; detailEl.classList.remove("open"); }
    requestRedraw();
  });
  canvas.addEventListener("dblclick", (evt) => {
    const rect = canvas.getBoundingClientRect();
    const n = nodeAt(evt.clientX - rect.left, evt.clientY - rect.top);
    if (n) enterFocus(n); else if (focused) exitFocus();
  });
  canvas.addEventListener("wheel", (evt) => {
    evt.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = evt.clientX - rect.left, sy = evt.clientY - rect.top;
    const before = s2w(sx, sy);
    camera.zoom = Math.max(0.05, Math.min(6, camera.zoom * (evt.deltaY > 0 ? 0.91 : 1.1)));
    const after = s2w(sx, sy);
    camera.x += before.x - after.x; camera.y += before.y - after.y;
    requestRedraw();
  }, { passive: false });

  document.getElementById("zoomIn").addEventListener("click", () => { camera.zoom = Math.min(6, camera.zoom * 1.25); requestRedraw(); });
  document.getElementById("zoomOut").addEventListener("click", () => { camera.zoom = Math.max(0.05, camera.zoom * 0.8); requestRedraw(); });
  document.getElementById("zoomReset").addEventListener("click", () => { targetCamera = fitCamera(); wake(); });

  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape") {
      if (document.activeElement === queryInput) queryInput.blur();
      resetAll();
    }
  });

  runQuery(); // initial state — must run after `running`/`requestRedraw` are declared above
})();
