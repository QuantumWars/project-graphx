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

## 4. Show it, then offer to build

Show the config you wrote, then **ask whether to build now** and run it if they agree. Do not
simply end with an instruction to go and run `/skill-graph:build` — a config with no graph behind
it does nothing, and the user has no way to judge whether the sources were right until they see
what comes out of them.

Ask, rather than building unprompted, because the build reads every file under the configured
sources and walks every scan root. On a large tree with `scanRoots` set that is slow enough that
it should be a choice.

On yes, run the same two commands `/skill-graph:build` runs, and report the counts they print.
On no, say the one command to run later and stop.

## Do not also import the sources

`add_repo` is for repositories that are **not** configured sources. Never call it on a directory
already listed in `sources`.

Both paths reach the same files by different routes — the build writes them into `graph-data.json`,
`add_repo` stores them in `overlay.json`, and the two are merged at read time with no deduplication.
The result is every affected item appearing twice, and `get_node` then failing this way:

```json
{ "error": "ambiguous", "candidates": ["image-generation", "image-generation"] }
```

That error exists so the user can choose between candidates, but here both print the same string, so
there is no answer that resolves it. Every by-name lookup of a duplicated item becomes unanswerable.

`remove_repo("<label>")` undoes it completely if it has already happened.

Prefer the source path whenever both are possible. `add_repo` reads frontmatter only and its nodes
start with **zero** edges by design; the build scans body text and computes real cross-references
weighted by how often each name actually appears. Importing a source therefore costs you the edges
and gains nothing.
