// Only defined when there's no Electron preload (i.e. this page is open in a
// plain browser tab for fast design iteration) — the packaged app's preload.js
// already sets window.graphAPI via contextBridge before this file runs, so
// this never overrides the real IPC-backed implementation.
if (!window.graphAPI) {
  window.graphAPI = {
    // Mirrors graph-overlay.js's applyOverlay() — duplicated here in browser
    // JS since that module is CommonJS/Node-only and this page has no
    // bundler. Keep the two in sync if either changes. overlay.json is
    // optional (404 is fine, just means nothing's been added yet).
    loadGraph: async () => {
      const data = await fetch("data/graph-data.json").then((r) => r.json());
      const empty = { notes: {}, customEdges: [], ratings: {}, importedNodes: [], categoryOverrides: {}, tags: {} };
      const overlay = await fetch("data/overlay.json").then((r) => (r.ok ? r.json() : empty)).catch(() => empty);
      const notes = overlay.notes || {};
      const ratings = overlay.ratings || {};
      const categoryOverrides = overlay.categoryOverrides || {};
      const tagsMap = overlay.tags || {};
      data.nodes.push(...(overlay.importedNodes || []));
      const byId = new Map(data.nodes.map((n) => [n.id, n]));
      data.nodes.forEach((n) => {
        n.notes = notes[n.id] || [];
        const r = ratings[n.id] || [];
        n.ratings = r;
        n.avgRating = r.length ? Math.round((r.reduce((s, x) => s + x.rating, 0) / r.length) * 10) / 10 : null;
        if (categoryOverrides[n.id]) n.category = categoryOverrides[n.id];
        n.tags = tagsMap[n.id] || [];
      });
      (overlay.customEdges || []).forEach((e) => {
        if (byId.has(e.from) && byId.has(e.to)) data.edges.push({ from: e.from, to: e.to, weight: e.weight || 1, kind: "custom", label: e.label });
      });
      return data;
    },
    revealFile: () =>
      Promise.resolve({
        ok: false,
        reason: "reveal-in-Finder needs the desktop app — not available in the web preview",
      }),
    // Plain browser JS can't write to disk — rating/notes are real IPC
    // writes to overlay.json in the desktop app, with no web equivalent.
    rateNode: () => Promise.resolve({ error: "rating needs the desktop app — not available in the web preview" }),
    addNote: () => Promise.resolve({ error: "notes need the desktop app — not available in the web preview" }),
  };
}
