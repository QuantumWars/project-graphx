// Browser mode. Only defined when there is no Electron preload — the desktop
// app's preload.js sets window.graphAPI via contextBridge before this file
// runs, so this never overrides the real IPC-backed implementation.
//
// Every method here talks to server/viewer-server.js on localhost, which
// delegates to the same graph-overlay.js functions the MCP server calls. That
// makes browser mode a peer of the desktop app rather than a preview: notes
// and ratings written here land in the project's overlay.json and are visible
// to the MCP tools.
//
// This file used to re-implement applyOverlay() so it could merge overlay.json
// client-side. It no longer does — the server returns already-merged data, so
// the third copy of that logic is gone.
if (!window.graphAPI) {
  const post = async (route, body) => {
    try {
      const res = await fetch(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (e) {
      // The renderer shows res.error / res.reason to the user, so a dead
      // server has to arrive in that shape rather than as a thrown promise.
      const msg = "viewer server is not responding — was it stopped?";
      return { ok: false, error: msg, reason: msg };
    }
  };

  window.graphAPI = {
    loadGraph: () => fetch("api/graph").then((r) => r.json()),
    revealFile: (relPath) => post("api/reveal", { path: relPath }),
    rateNode: (nodeId, rating) => post("api/rate", { nodeId, rating }),
    addNote: (nodeId, text) => post("api/note", { nodeId, text }),
  };
}
