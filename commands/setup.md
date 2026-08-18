---
description: Create this project's skill-graph config — which folders hold skills and agents, and which trees to scan for projects using them.
allowed-tools: Bash, Read, Write, Glob
---

Create `.claude/graph/config.json` for the current project. Do not invent its contents — find them.

## 1. Find the sources

A **source** is a directory that holds agents or skills. Look for these, in the project and anywhere it vendors other repos:

- `.claude/agents/` and `.claude/skills/` — the project's own
- any `agents/` or `skills/` directory belonging to a plugin or a vendored catalogue in this repo

Use Glob for `**/.claude/agents`, `**/.claude/skills`, `**/skills/*/SKILL.md`, `**/agents/*.md`, and prune `node_modules`. Report what you found with counts before writing anything.

Each source becomes one entry:

```json
{ "repo": "<label shown in the graph>", "root": "<path relative to project root>", "kind": "agent" | "skill" }
```

`kind` is `agent` for a directory of `*.md` files, `skill` for a directory of `<name>/SKILL.md` directories. A repo with both needs two entries.

## 2. Choose the scan roots

`scanRoots` are the trees searched for **projects that have installed** these skills — that is what fills in "who actually uses this". Each is a directory holding many repos, e.g. `~/code`. Ask the user which to use rather than guessing; `[]` is a legitimate answer meaning "catalogue only, do not scan".

`scanExclude` drops paths whose text contains any listed substring. Always keep `/node_modules/`. Add the source trees themselves if they are study material rather than projects — otherwise the catalogue counts itself as a user of everything in it.

## 3. Write it

```json
{
  "sources": [ ... ],
  "scanRoots": ["~/code"],
  "scanExclude": ["/node_modules/"]
}
```

Write to `.claude/graph/config.json`, creating the directory. If a config already exists, show the user the difference and confirm before overwriting.

Then tell them to run `/skill-graph:build`. Do not run it yourself — the user should see the config first.
