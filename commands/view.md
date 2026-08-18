---
description: Open the graph in a browser. No install needed — this is the default way to look at a graph.
allowed-tools: Bash
---

Open the graph viewer in the user's browser, pointed at the current project.

This is the default viewer. It needs nothing beyond `node`, which the plugin already
requires — unlike `/skill-graph:app`, which costs a one-time ~280 MB Electron download.
Prefer this command unless the user specifically asks for the desktop app.

## Preconditions

`.claude/graph/graph-data.json` must exist. If it does not, stop and tell the user to run
`/skill-graph:build`. Do not start the server to "show them the empty state" — it exits
with that same instruction, so starting it only adds a step.

## Launch

Run it in the background and report the URL it prints:

```bash
cd "$(pwd)" && node "${CLAUDE_PLUGIN_ROOT}/server/viewer-server.js" \
  --data-dir "$(pwd)/.claude/graph" &
```

`--data-dir` is what makes it show *this* project. Pass it as an absolute path built from
`pwd` at the moment the command runs — do not write a placeholder like `$PROJECT_DIR` and
expect the shell to fill it in.

The server prints the URL it bound to, the data directory it is showing, and how to stop
it. Report the URL to the user; it opens their browser automatically. If the default port
is taken it walks upward until it finds a free one, so **read the printed URL rather than
assuming a port number**.

## Options

- `--port N` — pin a port instead of letting it choose. If that exact port is busy the
  server exits rather than silently moving, because a pinned port usually means something
  else (a bookmark, a proxy) is relying on it.
- `--no-open` — start the server without launching a browser.

## Stopping it

It runs until stopped. `pkill -f viewer-server.js` ends it. Say so if the user asks how to
close it — closing the browser tab leaves the server running.

## What works here

Everything the desktop app does: notes, ratings and reveal-in-file-manager all write
through the same code the MCP server uses, so a note added in the browser is visible to
`get_node` and survives a rebuild. There is no read-only limitation to warn the user
about.

The one difference is that the server binds `127.0.0.1` only — it is not reachable from
another machine, by design.
