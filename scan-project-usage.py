#!/usr/bin/env python3
"""Scan every real project on this machine for which of the catalogued
agents and skills (see build-graph.py / sources.json) it actually has
installed in its own .claude/agents or .claude/skills — real filesystem
presence, not a guess.

Excludes: node_modules-nested .claude dirs (npm package internals, not
projects), and anything under this tool's own directory tree — that's the
study material the catalog was BUILT from (this repo, and whatever source
repos sources.json points at inside it), not one of the user's own projects
using it.

Writes usedBy: [projectLabel, ...] onto every node in graph-data.json.
Read-only against every project scanned — never writes anywhere but the
target JSON file.

Usage: scan-project-usage.py <graph-data.json> [code-root]
code-root defaults to ~/code.
"""
import json, os, sys

CODE_ROOT = os.path.expanduser(sys.argv[2]) if len(sys.argv) > 2 else os.path.expanduser("~/code")
SELF_ROOT = os.path.dirname(os.path.abspath(__file__))

def find_project_roots(code_root):
    roots = []
    for dirpath, dirnames, filenames in os.walk(code_root):
        # prune node_modules entirely so we don't even descend into it
        dirnames[:] = [d for d in dirnames if d != "node_modules"]
        if os.path.basename(dirpath) == ".claude":
            project_root = os.path.dirname(dirpath)
            abs_root = os.path.abspath(project_root)
            if abs_root == SELF_ROOT or abs_root.startswith(SELF_ROOT + os.sep):
                continue
            if os.sep + "node_modules" + os.sep in (project_root + os.sep):
                continue
            roots.append(project_root)
    return sorted(roots)

def label_for(project_root, code_root):
    rel = os.path.relpath(project_root, code_root)
    return rel

def install_filename(node):
    # Derived from the node's real source path, NOT its frontmatter `name` —
    # the two can diverge for real (a skill directory name that doesn't match
    # its own `name:` field inside SKILL.md).
    # Claude Code discovers skills/agents by directory/file name on disk, so
    # that's the only name that actually determines whether an install works.
    parts = node["path"].split("/")
    if node["type"] == "agent":
        return parts[-1]  # "code-reviewer.md"
    return parts[-2]  # skills/<this>/SKILL.md

def scan(project_root, filename, node_type):
    if node_type == "agent":
        return os.path.isfile(os.path.join(project_root, ".claude", "agents", filename))
    else:
        return os.path.isfile(os.path.join(project_root, ".claude", "skills", filename, "SKILL.md"))

def main():
    data_path = sys.argv[1]
    with open(data_path) as f:
        data = json.load(f)
    # idempotent: strip any project/claudemd nodes and usage/doc edges from a
    # prior run of this script before regenerating, so re-running never
    # duplicates them
    data["nodes"] = [n for n in data["nodes"] if n.get("type") not in ("project", "claudemd")]
    data["edges"] = [e for e in data["edges"] if e.get("kind") not in ("usage", "doc")]

    roots = find_project_roots(CODE_ROOT)
    print(f"scanning {len(roots)} projects", file=sys.stderr)

    coverage = {}  # nodeId -> [project labels]
    uses = {}  # project label -> [nodeId, ...]
    for node in data["nodes"]:
        filename = install_filename(node)
        used_by = []
        for root in roots:
            if scan(root, filename, node["type"]):
                used_by.append(label_for(root, CODE_ROOT))
                uses.setdefault(label_for(root, CODE_ROOT), []).append(node["id"])
        node["usedBy"] = used_by
        coverage[node["id"]] = used_by

    used_count = sum(1 for v in coverage.values() if v)
    print(f"{used_count} of {len(coverage)} nodes are installed in at least one project", file=sys.stderr)

    # project nodes + CLAUDE.md presence — real god-node candidates: a project
    # using 300+ skills should visibly dwarf one using 3, not cap out at the
    # same node size as everything else.
    project_nodes = []
    usage_edges = []
    claudemd_nodes = []
    doc_edges = []
    for root in roots:
        label = label_for(root, CODE_ROOT)
        has_claude_md = os.path.isfile(os.path.join(root, "CLAUDE.md"))
        node_ids = uses.get(label, [])
        project_nodes.append({
            "id": f"project:{label}",
            "name": label,
            "type": "project",
            "repo": "local",
            "description": f"Real project on disk at ~/code/{label}."
                + (" Has its own CLAUDE.md." if has_claude_md else " No CLAUDE.md found."),
            "tools": [],
            "category": "project",
            "path": root,  # absolute, unlike skill/agent paths which are relative to the repo root
            "hasClaudeMd": has_claude_md,
            "usesCount": len(node_ids),
        })
        for nid in node_ids:
            usage_edges.append({"from": f"project:{label}", "to": nid, "weight": 1, "kind": "usage"})
        # CLAUDE.md is a real, individually significant file (it's what
        # actually governs how Claude Code behaves in that project) — it gets
        # its own node rather than staying a boolean flag on the project, so
        # it can be seen, sized, and clicked into on its own.
        if has_claude_md:
            claudemd_id = f"claudemd:{label}"
            claudemd_nodes.append({
                "id": claudemd_id,
                "name": f"{label}/CLAUDE.md",
                "type": "claudemd",
                "repo": "local",
                "description": f"Project instructions Claude Code reads for ~/code/{label}.",
                "tools": [],
                "category": "project",
                "path": os.path.join(root, "CLAUDE.md"),
            })
            doc_edges.append({"from": f"project:{label}", "to": claudemd_id, "weight": 1, "kind": "doc"})

    print(f"{len(project_nodes)} project nodes, {len(usage_edges)} usage edges, "
          f"{len(claudemd_nodes)} CLAUDE.md nodes", file=sys.stderr)

    data["nodes"].extend(project_nodes)
    data["nodes"].extend(claudemd_nodes)
    data["edges"].extend(usage_edges)
    data["edges"].extend(doc_edges)
    data["scannedProjects"] = [label_for(r, CODE_ROOT) for r in roots]
    with open(data_path, "w") as f:
        json.dump(data, f)

if __name__ == "__main__":
    main()
