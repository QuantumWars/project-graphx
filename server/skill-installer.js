// Installs/removes a real skill or agent's files into/from one of the scanned
// projects on disk. Source files come from the catalogued source trees, which
// are read-only here and never modified — only ever copied FROM. The write
// target is always some project's own .claude/ folder.
//
// After either operation, re-runs scan-project-usage.py so the graph's
// usedBy/usesCount fields reflect the change immediately — otherwise a
// just-installed skill would still show "not found in any scanned project"
// until the next unrelated regen.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const paths = require("./paths.js");

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

// The scanner is a plugin-owned script but writes a project-owned file, so it
// is addressed absolutely on both sides — there is no working directory from
// which both are reachable by a relative path.
//
// The interpreter is whatever paths.pythonBin() found, not the literal
// "python3": that name does not exist on a normal Windows install, and this
// was the whole of the platform dependency.
function rescan() {
  const py = paths.pythonBin();
  if (!py) throw new Error(noPythonMessage());
  execFileSync(py.cmd, [...py.args, paths.scanScript(), paths.dataPath(), "--config", paths.configPath(), "--project-root", paths.projectRoot()], {
    cwd: paths.projectRoot(),
    windowsHide: true,
  });
}

const noPythonMessage = () =>
  `no Python 3 interpreter found (tried: ${paths.pythonTried()}). The usage scan needs one; install Python 3 or put it on PATH.`;

// Directories the install created and this uninstall has just emptied — the
// .claude/skills (or .claude/agents) folder, and .claude itself. Left behind,
// they are litter in someone else's repository that no diff will ever show,
// because git does not track an empty directory.
//
// Emptiness is decided by reading the directory, never by catching rmdir's
// error: a non-empty rmdir reports ENOTEMPTY on POSIX but can report EPERM on
// Windows, so a fix written around the error code would behave differently on
// the two platforms. A directory listing means the same thing everywhere.
//
// Two hard limits. It stops at the project root, so it can never walk up into
// a parent repository. And it stops at the first directory that still holds
// anything, so a project with a second installed skill keeps its folder.
//
// Best effort throughout: failing to remove an empty directory is untidy,
// while failing the uninstall over it would be wrong.
function pruneEmptyParents(startPath, projectPath) {
  let dir = path.dirname(startPath);
  while (isInside(projectPath, dir)) {
    try {
      if (fs.readdirSync(dir).length > 0) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

// Strictly below `parent`. path.relative is the portable containment test: a
// string prefix comparison would separate on the wrong character on Windows,
// and would also call /a/bc a child of /a/b.
function isInside(parent, dir) {
  const rel = path.relative(parent, dir);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
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

  // A configured source's node.path is relative to sourceRoot; an imported
  // node's path (from add_repo) is already absolute — its own clone lives
  // outside sourceRoot entirely.
  const srcAbs = path.isAbsolute(node.path) ? node.path : path.join(g.data.sourceRoot, node.path);
  if (!fs.existsSync(srcAbs)) return { error: `source not found on disk: ${srcAbs}` };
  const destAbs = installPathFor(node, proj.path);
  if (fs.existsSync(destAbs)) return { error: `already installed at ${destAbs}` };

  // Checked before the first write, not after the copy. The scan is not
  // optional decoration — without it the graph disagrees with the disk — so an
  // install that cannot finish must not start. Doing this afterwards is what
  // left a half-applied state on every machine without a `python3`.
  if (!paths.pythonBin()) return { error: noPythonMessage() };

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  if (node.type === "agent") {
    fs.copyFileSync(srcAbs, destAbs);
  } else {
    fs.cpSync(path.dirname(srcAbs), destAbs, { recursive: true });
  }

  // The interpreter existed a moment ago, so this is the scan itself failing.
  // Undoing the copy is possible precisely because we refused to start when
  // destAbs already existed: everything at that path is ours to remove, and
  // removing it puts the project back exactly where it was.
  try {
    rescan();
  } catch (e) {
    fs.rmSync(destAbs, { recursive: true, force: true });
    pruneEmptyParents(destAbs, proj.path);
    return { error: `installed files were removed again: the usage scan failed (${e.message})` };
  }
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
  pruneEmptyParents(targetAbs, proj.path);

  // A delete cannot be rolled back, so unlike install this reports rather than
  // repairs. The files really are gone; it is only the graph that is now stale,
  // and saying so beats an exception that makes the removal look like it failed.
  try {
    rescan();
  } catch (e) {
    return { ok: true, removed: node.name, type: node.type, project: proj.name, from: targetAbs, warning: `removed, but the usage scan failed, so the graph is stale until the next build (${e.message})` };
  }
  return { ok: true, removed: node.name, type: node.type, project: proj.name, from: targetAbs };
}

module.exports = { installSkill, uninstallSkill, resolveProject, installPathFor, pruneEmptyParents };
