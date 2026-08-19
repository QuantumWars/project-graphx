---
description: Set up one shared catalogue that every project sees, instead of a separate graph per project.
allowed-tools: Bash, Read, Write, Edit, Glob
---

Point every project at a single shared graph, so a skill catalogued once is visible everywhere and
a note written in one project is readable from another.

## Decide this first, out loud

The default is one graph **per project**, and that is the right default for most people: two projects
never see each other's data, and nothing follows you between unrelated repos. Going global trades
that away deliberately. Say so before changing anything, and get an explicit yes.

Going global means:

- Every project on this machine reads and writes the **same** `graph-data.json` and `overlay.json`.
- Per-project graphs already built are not deleted, but they stop being read. They are still on disk
  at `<project>/.claude/graph/` and become live again if the setting is removed.
- Notes, ratings and tags become machine-wide rather than belonging to one repo.
- One build serves everything, so `/skill-graph:build` from any project rebuilds the shared graph.

If the user only wants "the same skills visible everywhere" and does **not** want shared notes, stop
here and use `/skill-graph:setup` instead with **absolute** source roots — relative roots resolve
against the project, absolute ones do not, so several projects can catalogue the same folders while
keeping separate graphs. That needs no settings change and no restart.

## 1. Choose where the shared graph lives

Ask. Offer `~/.claude/graph` as the default, and say plainly what it means: this is machine-wide
state living in the home directory rather than travelling with any repository. If the user keeps
agent data inside projects as a rule, this is the deliberate exception, and it is worth them saying
yes to rather than discovering later.

Anywhere writable works — a Dropbox folder, a synced directory, a path already under backup.

## 2. Find every source on the machine

Sources here must be **absolute paths**, because this config is read from every project and a
relative root would resolve somewhere different each time.

Search the user's code directories for `**/.claude/agents`, `**/.claude/skills`, and any `agents/`
or `skills/` folder belonging to a plugin, pruning `node_modules`. Show what you found with counts
and let the user cut the list before writing it — a machine-wide search finds vendored copies and
abandoned experiments as readily as the real thing.

Watch for the same skill existing in more than one root. That is legitimate and still imports, but
it makes by-name lookups ambiguous, and the answer comes back as ids. Say which names collide.

**Say what this costs the usage numbers, before building.** A project is never counted as a user of
its own catalogue — otherwise a repo cataloguing its own `.claude/skills` would report itself as a
user of every skill in it, and every number would be inflated by one. That rule is right per-project.
Machine-wide it bites: most source roots you find here *are* directories inside projects that the
scan also walks, so for most items the only copy on disk is the excluded one, and `usedBy` comes back
empty. On this machine the first global build catalogued 572 nodes from 15 sources and scanned 41
projects, and 5 items had a recorded user.

That is the rule working, not a fault, and `projects_using` is honest when it says nothing — absent
means "no copy found outside its own catalogue", never "unused". But someone who went global
expecting a machine-wide picture of what is installed where will read those empty answers as a
broken build. Tell them the number will be small and why, rather than letting them find it.

## 3. Write the config

```json
{
  "sources": [
    { "repo": "<label>", "root": "/absolute/path/to/.claude/agents", "kind": "agent" },
    { "repo": "<label>", "root": "/absolute/path/to/.claude/skills", "kind": "skill" }
  ],
  "scanRoots": ["~/code"],
  "scanExclude": ["/node_modules/", "/imported-repos/"]
}
```

Write it to `<chosen-dir>/config.json`, creating the directory.

## 4. Point Claude Code at it

`GRAPH_DATA_DIR` is what makes every project use the shared directory. Set it in
`~/.claude/settings.json`:

```json
{ "env": { "GRAPH_DATA_DIR": "/absolute/chosen/dir" } }
```

**Read the file and merge.** It almost certainly holds `model`, `hooks`, `enabledPlugins` and more;
replacing it would silently drop all of that, and a malformed `settings.json` disables every setting
in it rather than failing loudly. If `env` already exists, add the one key to it.

Use an absolute path — `~` is not expanded in this value.

## 5. Build it

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/build-graph.py" \
  <chosen-dir>/config.json <chosen-dir>/graph-data.json --project-root <chosen-dir>

python3 "${CLAUDE_PLUGIN_ROOT}/scripts/scan-project-usage.py" \
  <chosen-dir>/graph-data.json --config <chosen-dir>/config.json --project-root <chosen-dir>
```

Report the counts both scripts print, and name any root skipped for not existing.

## 6. Say what has and has not taken effect yet

This is the step to get right, because the change is half-applied at this point and it looks finished.

The graph exists and is correct. But the MCP server for **this** session was launched before
`GRAPH_DATA_DIR` was set and cannot see it — environment is read at process start. So the tools in
this session still answer from the old per-project graph.

Tell the user to restart Claude Code, and that the setting takes effect for every project from then
on. Do not claim it is working until it has been checked.

## 7. Check it, next session

After a restart, confirm rather than assume:

```
best_skills
```

The count should match what the build printed in step 5, from any project. If it still shows the old
per-project numbers, the environment variable did not reach the server — verify it is in the `env`
block of `~/.claude/settings.json`, spelled `GRAPH_DATA_DIR`, with an absolute path.

## Undoing it

Remove `GRAPH_DATA_DIR` from `~/.claude/settings.json` and restart. Every project returns to its own
`.claude/graph/`, which was never deleted. The shared directory stays where it is and can be deleted
by hand if it is not wanted.
