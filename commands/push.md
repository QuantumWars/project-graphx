---
description: Register this repo's .claude infrastructure with the global catalogue, and rebuild it
---

Register the current repository's own `.claude/` skills, agents, commands and output styles as
sources in the **global** catalogue, then rebuild it so they are visible from every project.

The repository keeps its files. Nothing is copied anywhere — a source is a directory the global
build reads in place, so a skill edited here is the skill the catalogue reports tomorrow.

## 1. Check there is a global catalogue to push to

```bash
echo "${GRAPH_DATA_DIR:-<unset>}"
```

If it is unset there is no global catalogue and nothing to push to. Say so and stop: the fix is
`/skill-graph:setup-global`, not this command. Do not create one here — choosing that location,
and merging `settings.json`, is that command's job and it asks the user first.

## 2. See what is unregistered

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/unpushed.py" "$PWD"
```

Read the JSON. Four fields matter:

- `unpushed` — roots the global config has never heard of. These are what this command registers.
- `stale` — roots it knows, holding a file newer than the built graph. Nothing to register; step 4
  alone fixes these.
- `registered` — already known and current. Report the counts; do nothing.
- `uncatalogued` — real infrastructure that cannot become a node, today only `.claude/hooks`.
  Report it so "nothing to push" never quietly means "I skipped these".

If `unpushed` and `stale` are both empty, say so and stop. Do not rebuild for nothing.

## 3. Add each unpushed root to the global config

Read `$GRAPH_DATA_DIR/config.json`, append one entry per unpushed root, write it back. Merge —
never write the file whole. It holds every other repo's registration, and replacing it silently
un-registers all of them.

Each entry takes the `kind` and `root` straight from the JSON, and `repo` is this repository's
directory name:

```json
{ "repo": "<dirname of $PWD>", "root": "<absolute root from unpushed>", "kind": "<kind>" }
```

The root must be **absolute**. A relative root resolves against whichever project the build runs
from, so in a shared catalogue it points somewhere different every time.

Before writing, show the user the entries you are about to add and confirm.

Two things to tell them, because both surprise people afterwards:

- A repo that owns a source stops being counted as a *project*. The scan skips it deliberately —
  otherwise a repo cataloguing its own skills reports itself as a user of every one of them — so
  after this it disappears from `projects_using` and from the installed-where picture.
- If the name of any item here collides with one already in the catalogue, both keep their own id
  (`repo:kind:name`) and lookups by bare name become ambiguous. `get_node` will list the candidates.

## 4. Rebuild the global catalogue

Absolute paths on both sides. This is the global graph, not this project's.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/build-graph.py" \
  "$GRAPH_DATA_DIR/config.json" "$GRAPH_DATA_DIR/graph-data.json" --project-root "$GRAPH_DATA_DIR"

python3 "${CLAUDE_PLUGIN_ROOT}/scripts/scan-project-usage.py" \
  "$GRAPH_DATA_DIR/graph-data.json" --config "$GRAPH_DATA_DIR/config.json" --project-root "$GRAPH_DATA_DIR"
```

Report the counts both scripts print, and name any root skipped for not existing.

## 5. Say what is now live, and what is not

The MCP server reads the graph file per call, so the new items are queryable in this session
without a restart. Confirm it rather than asserting it:

```
find_skills("<one item you just registered>")
```

If that returns nothing, the build wrote somewhere other than where the server reads. Report that
instead of the success message — it means `GRAPH_DATA_DIR` differs between this shell and the
server, and no amount of rebuilding will fix it from here.
