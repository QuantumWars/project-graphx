// Installs/removes a real skill or agent's files into/from one of your real
// scanned projects on disk. Source files come from the repos listed in
// sources.json (read-only, never modified — only ever copied FROM); the
// write target is always a project's own .claude/ folder, never a source
// repo itself.
//
// After either operation, re-runs scan-project-usage.py so the graph's
// usedBy/usesCount fields reflect the change immediately — otherwise a
// just-installed skill would still show "not found in any scanned project"
// until the next unrelated regen.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function resolveProject(g, label) {
  const q = label.trim().toLowerCase();
  const exact = g.data.nodes.find((n) => n.type === "project" && n.name.toLowerCase() === q);
  if (exact) return exact;
  const sub = g.data.nodes.filter((n) => n.type === "project" && n.name.toLowerCase().includes(q));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1) return { ambiguous: sub.map((n) => n.name) };
  return null;
}

// Real, on-disk install path for a node inside a project's .claude/ — same
// filename convention scan-project-usage.py already uses to detect whether
// something is installed, so install/uninstall and the scanner never disagree
// about what "installed" means.
function installPathFor(node, projectPath) {
  if (node.type === "agent") {
    return path.join(projectPath, ".claude", "agents", path.basename(node.path));
  }
  const skillDirName = path.basename(path.dirname(node.path));
  return path.join(projectPath, ".claude", "skills", skillDirName);
}

function rescan(dataPath) {
  execFileSync("python3", ["scan-project-usage.py", dataPath], { cwd: path.join(__dirname, "..") });
}

function installSkill(g, q, skillName, projectLabel) {
  const r = q.resolveNode(g, skillName);
  if (r.notFound) return { error: `no node matches "${skillName}"` };
  if (r.ambiguous) return { error: "ambiguous", candidates: r.ambiguous };
  const node = r.node;
  if (node.type !== "agent" && node.type !== "skill") return { error: `"${node.name}" is a ${node.type}, not an agent or skill — nothing to install` };

  const proj = resolveProject(g, projectLabel);
  if (!proj) return { error: `no scanned project matches "${projectLabel}"` };
  if (proj.ambiguous) return { error: "ambiguous project", candidates: proj.ambiguous };

  // A sources.json-scanned node's path is relative to sourceRoot; an
  // imported node's path (from add_repo) is already absolute — its own
  // clone lives outside sourceRoot entirely.
  const srcAbs = path.isAbsolute(node.path) ? node.path : path.join(g.data.sourceRoot, node.path);
  if (!fs.existsSync(srcAbs)) return { error: `source not found on disk: ${srcAbs}` };
  const destAbs = installPathFor(node, proj.path);
  if (fs.existsSync(destAbs)) return { error: `already installed at ${destAbs}` };

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  if (node.type === "agent") {
    fs.copyFileSync(srcAbs, destAbs);
  } else {
    fs.cpSync(path.dirname(srcAbs), destAbs, { recursive: true });
  }
  rescan(q.DATA_PATH);
  return { ok: true, installed: node.name, type: node.type, project: proj.name, at: destAbs };
}

function uninstallSkill(g, q, skillName, projectLabel) {
  const r = q.resolveNode(g, skillName);
  if (r.notFound) return { error: `no node matches "${skillName}"` };
  if (r.ambiguous) return { error: "ambiguous", candidates: r.ambiguous };
  const node = r.node;

  const proj = resolveProject(g, projectLabel);
  if (!proj) return { error: `no scanned project matches "${projectLabel}"` };
  if (proj.ambiguous) return { error: "ambiguous project", candidates: proj.ambiguous };

  const targetAbs = installPathFor(node, proj.path);
  if (!fs.existsSync(targetAbs)) return { error: `not installed at ${targetAbs}` };

  fs.rmSync(targetAbs, { recursive: true, force: true });
  rescan(q.DATA_PATH);
  return { ok: true, removed: node.name, type: node.type, project: proj.name, from: targetAbs };
}

module.exports = { installSkill, uninstallSkill, resolveProject, installPathFor };
