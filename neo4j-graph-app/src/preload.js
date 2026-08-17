const { contextBridge, ipcRenderer } = require("electron");

// The renderer never gets raw fs access — every path here is one specific,
// named IPC call into the main process, which is the only thing that ever
// touches the filesystem. rateNode/addNote are real writes to overlay.json,
// not local-only state — the same file the MCP server reads and writes.
contextBridge.exposeInMainWorld("graphAPI", {
  loadGraph: () => ipcRenderer.invoke("load-graph"),
  revealFile: (relPath) => ipcRenderer.invoke("reveal-file", relPath),
  rateNode: (nodeId, rating) => ipcRenderer.invoke("rate-node", nodeId, rating),
  addNote: (nodeId, text) => ipcRenderer.invoke("add-note", nodeId, text),
});
