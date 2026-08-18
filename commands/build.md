---
description: Scan the configured sources and build (or rebuild) this project's skill graph.
allowed-tools: Bash, Read
---

Build the graph for the current project.

Both scripts live with the plugin and write into the project. Run them from the project root:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/build-graph.py" \
  .claude/graph/config.json \
  .claude/graph/graph-data.json \
  --project-root "$PWD"

python3 "${CLAUDE_PLUGIN_ROOT}/scripts/scan-project-usage.py" \
  .claude/graph/graph-data.json \
  --config .claude/graph/config.json \
  --project-root "$PWD"
```

The first catalogues every agent and skill in the configured sources and computes the real cross-references between them. The second walks the scan roots and records which projects have each one actually installed on disk. The second is optional — skip it if `scanRoots` is empty.

Both print their counts to stderr. **Report those counts to the user**, and say plainly if a source root or scan root was skipped because it does not exist — a graph built from three of four configured sources is not a complete graph, and the user should hear that rather than read a success message.

If `config.json` does not exist, stop and tell the user to run `/skill-graph:setup` first.

After a successful build the MCP tools (`best_skills`, `find_skills`, `get_node`, and the rest) read the new data on their next call. No restart is needed.
