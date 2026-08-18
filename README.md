# project-graphx

A Neo4j-Browser-style desktop app for exploring your own Claude Code agents and
skills as a graph — plus an MCP server so Claude Code itself can query, tag,
install, and reorganize that catalog directly.

Point it at any repo (or several) that follow the `.claude/agents` /
`.claude/skills` convention, and it builds a real graph: which agents/skills
actually reference each other by name, which of your real projects on disk
have which of them installed, and lets you browse, search, rate, note, and
tag all of it — with every write landing on real files, not a mock.

## Why

Skill/agent catalogs grow past the point where a flat file listing is useful.
This turns that listing into something you can actually navigate: a canvas
you can search and click through, and — more importantly — a set of MCP
tools so Claude Code can ask "what's the correct set of skills for this
task" and get back real, resolved file paths instead of a guess.

## Features

**Desktop app** (Electron, styled after the Neo4j Browser)
- Force-directed graph of every agent/skill, sized by how often it's
  referenced elsewhere and colored by category
- A query bar for real commands: `best`, `neighbors <name>`, `open <name>`,
  `path a -> b`, `cat:<category>`, `type:agent`, `projects <name>`,
  `project:<label>`
- Click any node for its description, real file path, notes, and a 5-star
  rating you can add to on the spot
- A tag panel for filtering by real, multi-label use-case tags (a skill can
  be `react` *and* `testing` *and* `security` at once — categories only give
  you one bucket)
- Reveals the actual source file in Finder

**MCP server** (`graph-mcp-server/`) — 27 tools covering:
- Search & ranking: `search_ranked`, `find_skills`, `best_skills`,
  `related_by_connections`, `graph_neighbors`, `graph_path`
- Precise retrieval: `get_file_set` — combine type + category + tags + text
  to get back the exact, resolved file paths a task needs, not a ranked guess
- Real filesystem writes: `install_skill` / `uninstall_skill` copy or delete
  a skill's actual files into/from one of your real projects' `.claude/`
  folder, and re-scan usage immediately afterward
- Cataloging any repo: `add_repo` clones (or points at) any GitHub repo or
  local path and extracts its `.claude/skills` and `.claude/agents` into the
  catalog
- Durable annotations: `add_note`, `rate_skill`, `add_custom_edge`,
  `set_category`, `add_tags` — all stored in an overlay file that survives
  the next catalog regeneration

**Data layer**
- `build-graph.py` scans the repos listed in your `sources.json` and infers
  a category per node from name/description (language keywords, role
  suffixes, then topic keywords) — a stated heuristic, not an official
  taxonomy
- `scan-project-usage.py` scans a real directory tree (`~/code` by default)
  for every project with its own `.claude/agents` or `.claude/skills`, and
  records which catalog items each one actually has installed
- Everything you add by hand (notes, ratings, tags, category overrides,
  custom edges, imported repos) lives in a separate overlay file, merged in
  at read time — so it survives every regeneration instead of being
  overwritten

## Architecture

```
sources.json ──▶ build-graph.py ──▶ graph-data.json ─┐
                                                      ├─▶ applyOverlay() ─▶ app / MCP tools
                            overlay.json (your writes)┘
```

Three separate JS runtimes read the same graph: the Electron main process,
a browser-preview shim (`web-shim.js`, used when you open `index.html`
directly), and the MCP server (`graph-mcp-server/`). All three merge
`graph-data.json` with `overlay.json` the same way, so a note or rating
added from any of them shows up in the others on next load.

## Quick start

```bash
git clone <this-repo-url> project-graphx
cd project-graphx

# point the tool at your own repo(s)
cp sources.example.json sources.json
# edit sources.json — see sources.example.json for the format

python3 build-graph.py sources.json neo4j-graph-app/data/graph-data.json
python3 scan-project-usage.py neo4j-graph-app/data/graph-data.json   # optional — links real projects on disk

cd neo4j-graph-app
npm install
npm start
```

`sources.json` is a list of `{ repo, root, kind }` entries — `kind` is
`"agent"` (a folder of `<name>.md` files) or `"skill"` (a folder of
`<name>/SKILL.md` files). It's gitignored; only `sources.example.json` is
committed.

## Download

Prebuilt macOS (arm64) `.dmg` builds are on the
[Releases](../../releases) page. The packaged app ships with **no bundled
graph data** — on first launch it shows setup instructions (the same four
commands as Quick start above) instead of an empty canvas.

macOS Gatekeeper will block the unsigned build on first open — right-click
the app → **Open** once to allow it.

## MCP setup

```bash
cd graph-mcp-server
npm install
```

Add it to your `.mcp.json`:

```json
{
  "mcpServers": {
    "project-graphx": {
      "command": "node",
      "args": ["/absolute/path/to/project-graphx/graph-mcp-server/server.js"]
    }
  }
}
```

## Development

- `npm run regenerate-data` (from `neo4j-graph-app/`) re-runs the full
  pipeline: `build-graph.py` then `scan-project-usage.py`, writing straight
  to `data/graph-data.json`
- `npm run pack` (electron-packager) → `./make-dmg.sh` builds a
  distributable `.dmg` from the packaged `.app`
- A packaged build needs ad-hoc codesigning before it'll launch on your own
  machine:
  ```bash
  codesign --force --deep --sign - dist/project-graphx-darwin-arm64/project-graphx.app
  ```

## Privacy

Everything here runs locally. `scan-project-usage.py` only ever *reads* your
projects to check whether a `.claude/agents`/`.claude/skills` file exists —
it never writes outside the graph data file you point it at.
`install_skill`/`uninstall_skill` write real files, but only into projects
you explicitly name, never into the repos listed in `sources.json`. Nothing
in this repo makes a network call except `add_repo`, and only when you give
it a URL.

## License

[MIT](LICENSE)
