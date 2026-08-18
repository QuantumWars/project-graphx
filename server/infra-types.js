// The same table build-graph.py and scan-project-usage.py read, loaded from the
// same file rather than restated here. A second copy is exactly how install and
// install-detection come to disagree about where a thing lives, and that
// disagreement is silent: the copy lands, the scan does not see it, and the
// graph reports the item as installed nowhere.
//
// Read from disk at runtime, not inlined at bundle time, so a stale bundle
// cannot ship an old table alongside a new claude-infra.json.
const fs = require("fs");
const path = require("path");
const paths = require("./paths.js");

let cached;

function table() {
  if (cached) return cached;
  const file = path.join(paths.pluginRoot(), "scripts", "claude-infra.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  cached = new Map(raw.types.map((t) => [t.kind, t]));
  return cached;
}

const kinds = () => [...table().keys()];
const spec = (kind) => table().get(kind) || null;

// Where one catalogued node belongs inside a project's own .claude/. The name
// on disk comes from the node's real path, never from its frontmatter `name`:
// a skill directory whose name differs from its own `name:` field is common,
// and the directory is what Claude Code actually resolves.
function installPathFor(node, projectPath) {
  const s = spec(node.type);
  if (!s) return null;
  if (s.layout === "flat") {
    return path.join(projectPath, ".claude", s.installDir, path.basename(node.path));
  }
  return path.join(projectPath, ".claude", s.installDir, path.basename(path.dirname(node.path)));
}

module.exports = { kinds, spec, installPathFor };
