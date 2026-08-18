---
description: Open the desktop graph explorer for this project. Builds the Electron app on first use.
allowed-tools: Bash, Read
argument-hint: "[--pack]"
---

Open the desktop viewer, pointed at the current project's graph.

**Check first whether the user actually wants this one.** `/skill-graph:view` shows the
same graph in a browser with the same features and no download. This command is worth its
cost only if they specifically want a native window. If they have not said so, offer
`/skill-graph:view` instead.

## Preconditions

`.claude/graph/graph-data.json` must exist. If it does not, stop and tell the user to run `/skill-graph:build`. The app opens without it, but shows only setup instructions.

## First run — install the viewer's dependencies

The viewer is Electron and its dependencies are **not** bundled with the plugin; they are large and platform-specific. Check first:

```bash
test -d "${CLAUDE_PLUGIN_ROOT}/app/node_modules" && echo present || echo missing
```

If missing, tell the user this is a one-time ~280 MB install and ask before running it:

```bash
cd "${CLAUDE_PLUGIN_ROOT}/app" && npm install
```

## Launch

```bash
GRAPH_DATA_DIR="$PWD/.claude/graph" \
  npx --prefix "${CLAUDE_PLUGIN_ROOT}/app" electron "${CLAUDE_PLUGIN_ROOT}/app" &
```

`GRAPH_DATA_DIR` is what makes the app show *this* project. Run the block as written — it
reads `$PWD` before anything changes directory, so the path is the real project. Do not
rewrite it into a `cd` followed by a placeholder like `$PROJECT_DIR`; an unset variable
expands to nothing, `GRAPH_DATA_DIR` becomes `/.claude/graph`, and the app then refuses to
start rather than writing a rating somewhere nobody reads.

## Packaging (`--pack`)

Only when the user passes `--pack`. Builds a standalone `.app`:

```bash
cd "${CLAUDE_PLUGIN_ROOT}/app" && npm run pack
```

State plainly that the pack script targets **macOS arm64 only** — it is not a cross-platform build, and on any other platform the user should run the app with `npm start` instead. The packaged app still needs `GRAPH_DATA_DIR` set, or a `--data-dir <path>` argument, to find a project.
