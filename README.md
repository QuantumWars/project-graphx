# Skill Graph

A Claude Code plugin that turns the skills, agents, commands and output styles you already have
into a graph you can
query — from a session, in your browser, or in a desktop app.

It catalogues every agent and skill in the folders you point it at, counts which of them actually
mention which others, scans your machine for projects that really have each one installed, and
exposes all of it as MCP tools. Everything it knows comes from reading real files.

![The graph](.github/assets/screenshot-graph.png)

Click any node for what references it, what it references, which projects have it installed,
and your own notes, ratings and tags:

![A node in detail](.github/assets/screenshot-detail.png)

## Install

```
/plugin marketplace add QuantumWars/project-graphx
/plugin install skill-graph
```

Then, in any project you want a graph for:

```
/skill-graph:setup     # say where your skills and agents live — then offers to build
/skill-graph:build     # rescan, whenever the sources change
/skill-graph:view      # look at it, in your browser
```

`/skill-graph:setup` asks before building rather than just doing it, because a build with
`scanRoots` set walks every scan root. Say yes and you go straight from nothing to a graph.

Each project gets its own graph. If you would rather have **one catalogue shared by every project**,
run `/skill-graph:setup-global` instead — see [One graph, or one per project](#one-graph-or-one-per-project).

`/skill-graph:view` needs no download — it serves the viewer from `node`, which the plugin
already requires. `/skill-graph:app` opens the same viewer as a native desktop window
instead, at the cost of a one-time ~280 MB Electron install.

## Requirements

| For | You need | Notes |
| --- | --- | --- |
| The MCP tools | `node` 18+ | The server ships pre-bundled. No `npm install`. |
| `install_skill` / `uninstall_skill` | Python 3.6+ | For the usage re-scan. Located by probing `python3`, then `python`, then `py -3`. |
| `/skill-graph:build` | `python3` 3.6+ | Standard library only, but the command names `python3` literally. On macOS it comes with the Xcode command line tools. |
| `/skill-graph:view` | nothing more | Same `node` as above. |
| `add_repo` | `git` | Only for importing an external repo's skills. |
| `/skill-graph:app` | `npm` + ~280 MB | One-time Electron install, on first launch only. Optional. |
| Running the tests | `bun` | Contributors only. |

**On Windows, the MCP tools work; the two slash commands do not.** `install_skill` and
`uninstall_skill` find the interpreter by probing `python3`, then `python`, then `py -3`, so
they run on a stock Windows Python. `install_skill` also checks for it *before* it copies
anything, and undoes the copy if the usage scan fails afterwards — either way the project is
left as it was found, never half-applied.

`/skill-graph:build` and `/skill-graph:setup-global` are shell snippets that still say
`python3` literally, so on Windows run their two scripts by hand with whichever name works,
or use WSL.

The desktop app's packaging script targets **macOS arm64 only**. On other platforms use
`/skill-graph:view`, or run it unpackaged with `npm start` from `app/`.

## One graph, or one per project

By default the data directory is `<project>/.claude/graph`, so two projects never see each other's
graphs. That is usually what you want, and it is why nothing follows you between unrelated repos.

`GRAPH_DATA_DIR` overrides it. Set it and every project reads and writes the same directory:

```
dataDir = GRAPH_DATA_DIR  or  <project>/.claude/graph
```

`/skill-graph:setup-global` does that end to end — picks the location, finds every source on the
machine, writes the config with absolute roots, sets the variable in `~/.claude/settings.json`, and
builds. It takes effect on the next restart, because an MCP server reads its environment at process
start.

Sharing the directory shares the overlay too, so notes, ratings and tags become machine-wide rather
than per-repo. If you want the same *skills* everywhere but not the same *notes*, do not set the
variable — give each project a normal config whose source roots are **absolute**. Relative roots
resolve against the project; absolute ones do not, so several projects can catalogue the same
folders and still keep their own graphs.

Per-project graphs are never deleted by going global. Remove the variable and they are live again.

## Where things live

Code ships with the plugin. Data belongs to the project:

```
<your project>/.claude/graph/
├── config.json        what to catalogue, what to scan   (you own this — commit it)
├── graph-data.json    the built graph                   (regenerated wholesale)
├── overlay.json       your notes, ratings, tags, edges  (survives rebuilds)
└── imported-repos/    shallow clones from add_repo
```

No graph data is ever written into the plugin directory, which is wiped on every reinstall. Two
projects on the same machine get two independent graphs and never see each other's.

The one exception is Electron itself: `/skill-graph:app` installs it under the plugin's `app/`,
so a plugin update means downloading it again. `/skill-graph:view` has nothing to reinstall,
which is the main reason it is the default.

`graph-data.json` is rebuilt from scratch by every `/skill-graph:build`. Never edit it by hand —
your edit will vanish. Everything you add through the tools goes to `overlay.json`, which builds
never touch.

## Configuring

`.claude/graph/config.json`:

```json
{
  "sources": [
    { "repo": "my-project", "root": ".claude/agents", "kind": "agent" },
    { "repo": "my-project", "root": ".claude/skills", "kind": "skill" }
  ],
  "scanRoots": ["~/code"],
  "scanExclude": ["/node_modules/"]
}
```

- **sources** — directories of `.claude` infrastructure to catalogue. Four kinds, listed in
  `scripts/claude-infra.json`, which the build, the usage scan and the MCP server all read so they
  cannot disagree about where a thing lives:

  | `kind` | directory | on disk |
  | --- | --- | --- |
  | `skill` | `skills` | `<name>/SKILL.md` |
  | `agent` | `agents` | `<name>.md` |
  | `command` | `commands` | `<name>.md` |
  | `output-style` | `output-styles` | `<name>.md` |

  A command's frontmatter carries no `name:`, so its filename is its name — which is also how
  Claude Code addresses it. Relative paths resolve against the project root. A missing root is
  skipped with a warning; an unrecognised `kind` is an error, because it used to be walked as a
  skill and produced an empty catalogue instead of a complaint.

  `.claude/hooks` is not catalogued: hook scripts carry no frontmatter, so there is no name or
  description to put in a graph. `/skill-graph:push` reports them rather than passing over them
  silently.
- **scanRoots** — trees searched for projects that have those skills installed. This is what fills
  in "who actually uses this". `[]` means scan nothing, and is honoured as written.
- **scanExclude** — drop any path containing one of these substrings.

A project that owns a configured source is never counted as a user of its own catalogue. Without
that, a repo cataloguing its own `.claude/skills` would report itself as a user of every skill in
it, and every usage number would be inflated by one.

## What the tools tell you, and what they don't

**Edges are counted mentions.** An edge exists because one file's text contains another node's name.
That is a real, reproducible measurement — it is not a curated statement that two things belong
together. A skill named after a common word collects edges by coincidence.

**Usage is a filesystem fact.** `usedBy` comes from checking whether the file is actually there.
Absent means "not found under your scan roots", never "unused".

**Categories are a guess.** They come from a keyword heuristic at build time, which reads the name
first and only falls back to the description when the name says nothing — a thing named
`python-testing` is Python, a thing that merely *mentions* Python in passing is not. It is still a
heuristic: it will file some things oddly and it says `general` when it cannot tell. Tags are
hand-applied and mean what someone decided. Prefer tags.

**Imported repos have no edges.** `add_repo` extracts frontmatter only; cross-references are not
computed for imports. Zero connections on an imported skill is a statement about the importer, not
about the skill. This is also why importing a directory you already configured as a source is worse
than useless, and why it is refused — see below.

## When two things share a name

Two unrelated repos may each hold a `code-reviewer`, and both belong in the graph. So a lookup by
name can be genuinely ambiguous, and the answer names the ids instead:

```json
{ "error": "ambiguous", "candidates": ["myproj:agent:code-reviewer", "import:other:agent:code-reviewer"] }
```

Every tool that takes a node also accepts an id, so a candidate from that list can be passed straight
back to resolve the tie — including `install_skill` and `uninstall_skill`, where picking the wrong one
copies or deletes real files.

**`add_repo` refuses a directory the build already catalogues.** Both routes would reach the same
files — the build writes them to `graph-data.json`, an import stores them in `overlay.json`, and the
two are merged at read time — so every item under it would appear twice under one name, and no id
could tell them apart because they *are* the same file. It stops before writing anything, naming the
file that is already in the graph and ending "Nothing was imported."

Two different repos that happen to share a skill name are fine and still import; the check is on
paths, not names.

## The graph is a snapshot

It reflects the last build. Add a skill by hand, change a source, or install something outside these
tools, and it is stale until you build again. `install_skill` and `uninstall_skill` re-scan
themselves; nothing else does.

## Development

```bash
bun install --frozen-lockfile   # exactly the versions CI and the bundle were built from
bun test                        # unit + end-to-end
bun run bundle                  # rebuild server/server.bundle.mjs after editing server/
```

`bun.lock` pins what the committed bundle is compiled from, and `app/package-lock.json` pins the
Electron the desktop app was tested against. CI installs with `--frozen-lockfile`, so a dependency
bumped without updating the lockfile fails the run instead of quietly shipping.

The viewer can be run directly, which is the fastest way to iterate on `app/`:

```bash
node server/viewer-server.js --data-dir <project>/.claude/graph
```

**Re-bundle after any change under `server/`.** `.mcp.json` runs the bundle, not the source, so an
un-bundled edit is an edit that does not ship. The end-to-end suite launches the bundle exactly as
Claude Code does and will fail if it is stale, and CI rebuilds it and fails if the committed copy
differs.

`bun run bundle` also runs `scripts/normalize-bundle.js`, which replaces the `__dirname` literal the
bundler freezes in at build time with a runtime expression. Without it the artifact would carry the
absolute path of whoever built it, and two machines would never produce the same bytes — which is
what makes the CI comparison possible at all.

## Licence

MIT — see [LICENSE](LICENSE).
