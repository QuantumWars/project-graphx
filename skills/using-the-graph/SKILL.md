---
name: using-the-graph
description: Use when choosing which skills or agents to install in a project, when asked what a skill does or what relates to it, when auditing which catalogued skills a project actually uses, or when importing another repo's skills. Queries the skill-graph MCP tools instead of guessing from filenames.
---

# Using the skill graph

The `skill-graph` MCP server answers questions about the agents and skills catalogued for this
project from data built by scanning real files. Prefer it to reading directories: a `.claude/skills`
listing gives you names, and the graph gives you what each one is, what references it, and who
already uses it.

## First, is there a graph?

Every tool fails with the same message when the project has no graph yet: *No graph found at
`<path>`*. That is a first-run state, not a fault. Tell the user to run `/skill-graph:setup` and then
`/skill-graph:build`. Do not fall back to guessing from filenames without saying that is what you
are doing.

## Which tool answers which question

| The question | The tool |
| --- | --- |
| "what should I install for X" | `search_ranked`, then `get_file_set` to narrow |
| "what is this skill" | `get_node` |
| "what is important here" | `best_skills` |
| "what else relates to this" | `graph_neighbors`, `related_by_connections` |
| "how are these two connected" | `graph_path` |
| "who already uses this" | `projects_using` |
| "what does this project have" | `project_installed_skills` |
| "what categories/tags exist" | `list_categories`, `list_tags` |

`find_skills` is a fuzzy name/description match; `search_ranked` also weighs how connected and how
used each hit is. Reach for `search_ranked` when the user described a *need*, and `find_skills` when
they named a *thing*.

## What the numbers mean, and do not mean

An edge exists because one file's text mentions another node's name — a real, counted occurrence,
not a curated relationship. High degree means "widely mentioned", which is usually but not always
"important": a skill named after a common word accumulates edges by coincidence. Say "referenced by
N others" rather than "the most important", because the first is what was measured.

`usedBy` and `usesCount` come from a filesystem scan of the configured scan roots. Absent means "not
found under those roots" — never "unused". If `scanRoots` is empty, every one of these numbers is
zero and reporting them as usage would be wrong.

Categories are assigned by a keyword heuristic at build time and are frequently rough. Tags are
hand-applied and mean what someone decided they mean. Trust tags over categories, and say which one
you filtered on.

Imported repos (`add_repo`) start with **zero** edges — cross-references are not computed for them.
An imported skill showing no connections has not been shown to be unconnected.

## Writes are real

`install_skill` and `uninstall_skill` copy and delete real files in a project's `.claude/`.
`uninstall_skill` is a recursive delete and is not reversible. Confirm the target project and the
exact node with the user before either, and quote the path the tool reports back.

`rate_skill`, `add_note`, `add_tags`, `set_category` and `add_custom_edge` write to
`.claude/graph/overlay.json`. That file survives a rebuild; `graph-data.json` does not. Never edit
`graph-data.json` by hand — the next `/skill-graph:build` overwrites it whole.

## Rebuilding

The graph is a snapshot. After adding a skill by hand, changing a source, or installing into a
project outside these tools, it is stale until `/skill-graph:build` runs again. `install_skill` and
`uninstall_skill` re-scan by themselves; nothing else does. If a user reports a mismatch between the
graph and disk, check the build is current before investigating anything else.
