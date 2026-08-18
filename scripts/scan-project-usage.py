#!/usr/bin/env python3
"""Scan projects on this machine for which of the catalogued agents and skills
each one actually has installed in its own .claude/agents or .claude/skills —
real filesystem presence, not a guess.

Which trees get scanned, and what is excluded from them, come from the
project's own .claude/graph/config.json ("scanRoots", "scanExclude"). Nothing
here is hardcoded to one machine's layout: the original version scanned a
fixed ~/code and excluded one specific repo by name, which was correct for
exactly one user.

Writes usedBy: [projectLabel, ...] onto every node in graph-data.json.
Read-only against every project scanned — never writes anywhere but the
target JSON file.

A project that IS one of the configured sources is skipped. Otherwise the
catalogue counts itself as a user of everything in it: if
<project>/.claude/skills is a source, then <project> trivially "has" every
skill in the catalogue, every usage count is inflated by one, and every skill
looks used even when nothing uses it. The original version solved this by
hardcoding one repository's path into an exclude list, which was correct for
exactly one machine.

Usage:
  scan-project-usage.py <graph-data.json> --config <config.json> [--project-root DIR]
"""
import json, os, sys

DEFAULT_EXCLUDES = ["/node_modules/"]

def load_scan_config(config_path):
    if not config_path or not os.path.isfile(config_path):
        return [os.path.expanduser("~/code")], DEFAULT_EXCLUDES
    with open(config_path) as f:
        raw = json.load(f)
    if isinstance(raw, list):  # original bare-array sources.json format
        return [os.path.expanduser("~/code")], DEFAULT_EXCLUDES
    # An explicitly empty scanRoots means "scan nothing" and is honoured as
    # written; only an absent key falls back to a default.
    roots = raw["scanRoots"] if "scanRoots" in raw else [os.path.expanduser("~/code")]
    return [os.path.expanduser(r) for r in roots], raw.get("scanExclude", DEFAULT_EXCLUDES)

def source_owning_projects(config_path, project_root):
    """Project roots that own a configured source, and so must not be counted
    as users of their own catalogue. A source root of "<p>/.claude/skills"
    means <p> is a catalogue, not a consumer."""
    if not config_path or not os.path.isfile(config_path):
        return set()
    with open(config_path) as f:
        raw = json.load(f)
    entries = raw if isinstance(raw, list) else raw.get("sources", [])
    owners = set()
    for e in entries:
        root = e.get("root", "")
        root = root if os.path.isabs(root) else os.path.join(project_root, root)
        root = os.path.abspath(root)
        # Walk up from the source root to the project that contains its
        # .claude directory. A source may sit at any depth beneath it.
        cur = root
        while True:
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            if os.path.basename(cur) == ".claude":
                owners.add(parent)
                break
            cur = parent
    return owners

def as_posix(p):
    """Exclude patterns are written with forward slashes ("/node_modules/"),
    which is what a user types and what every config already on disk holds. On
    Windows os.walk yields backslash paths, so the literal substring test below
    would match nothing and every configured exclude would silently stop
    working — the quiet kind of failure, since the scan still succeeds and just
    reports more projects than asked for.

    Normalising one side is better than asking a config to be written twice.
    On POSIX os.sep is already "/", so this is a no-op there; it deliberately
    does not replace a literal backslash, which is a legal character in a POSIX
    filename."""
    return p.replace(os.sep, "/")

def find_project_roots(scan_roots, excludes, skip_roots=frozenset()):
    """Returns [(project_root, scan_root)], deduplicated. A project reachable
    from two overlapping scan roots is one project, listed once, attributed to
    the first scan root that found it."""
    found = {}
    for scan_root in scan_roots:
        if not os.path.isdir(scan_root):
            print(f"scan root does not exist, skipping: {scan_root}", file=sys.stderr)
            continue
        for dirpath, dirnames, filenames in os.walk(scan_root):
            # prune node_modules entirely so we don't even descend into it
            dirnames[:] = [d for d in dirnames if d != "node_modules"]
            if os.path.basename(dirpath) == ".claude":
                project_root = os.path.dirname(dirpath)
                if any(sub in (as_posix(project_root) + "/") for sub in excludes):
                    continue
                if os.path.abspath(project_root) in skip_roots:
                    continue
                found.setdefault(project_root, scan_root)
    return sorted(found.items())

def build_labels(pairs):
    """A project's label is its path relative to the scan root it came from.
    With more than one scan root those can collide (~/code/api and
    ~/work/api both label as "api"), and a collision would silently merge two
    different projects' usage into one node — so a colliding label is
    prefixed with its scan root's own name."""
    counts = {}
    for project_root, scan_root in pairs:
        rel = os.path.relpath(project_root, scan_root)
        counts[rel] = counts.get(rel, 0) + 1
    labels = {}
    for project_root, scan_root in pairs:
        rel = os.path.relpath(project_root, scan_root)
        if counts[rel] > 1:
            rel = os.path.join(os.path.basename(scan_root.rstrip("/")), rel)
        labels[project_root] = rel
    return labels

def install_filename(node):
    # Derived from the node's real source path, NOT its frontmatter `name` —
    # confirmed those diverge for real in practice: a skill directory whose
    # name does not match its own frontmatter `name:` field is common enough
    # to matter (e.g. a directory scientific-db-pubmed-database containing
    # `name: pubmed-database`).
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
    args = sys.argv[1:]
    config_path = None
    project_root = os.path.abspath(".")
    if "--config" in args:
        i = args.index("--config")
        config_path = args[i + 1]
        del args[i:i + 2]
    if "--project-root" in args:
        i = args.index("--project-root")
        project_root = os.path.abspath(args[i + 1])
        del args[i:i + 2]
    if len(args) != 1:
        print("usage: scan-project-usage.py <graph-data.json> --config <config.json>", file=sys.stderr)
        sys.exit(1)
    data_path = args[0]
    with open(data_path) as f:
        data = json.load(f)
    # idempotent: strip any project/claudemd nodes and usage/doc edges from a
    # prior run of this script before regenerating, so re-running never
    # duplicates them
    data["nodes"] = [n for n in data["nodes"] if n.get("type") not in ("project", "claudemd")]
    data["edges"] = [e for e in data["edges"] if e.get("kind") not in ("usage", "doc")]

    scan_roots, excludes = load_scan_config(config_path)
    skip = source_owning_projects(config_path, project_root)
    for s in sorted(skip):
        print(f"not counting the catalogue itself as a user: {s}", file=sys.stderr)
    pairs = find_project_roots(scan_roots, excludes, skip)
    labels = build_labels(pairs)
    roots = [project_root for project_root, _ in pairs]
    print(f"scanning {len(roots)} projects across {len(scan_roots)} scan root(s)", file=sys.stderr)

    coverage = {}  # nodeId -> [project labels]
    uses = {}  # project label -> [nodeId, ...]
    for node in data["nodes"]:
        filename = install_filename(node)
        used_by = []
        for root in roots:
            if scan(root, filename, node["type"]):
                used_by.append(labels[root])
                uses.setdefault(labels[root], []).append(node["id"])
        node["usedBy"] = used_by
        coverage[node["id"]] = used_by

    used_count = sum(1 for v in coverage.values() if v)
    print(f"{used_count} of {len(coverage)} nodes are installed in at least one project", file=sys.stderr)

    # project nodes + CLAUDE.md presence — real god-node candidates: a project
    # using hundreds of skills should visibly dwarf one using 3, not cap out at the
    # same node size as everything else.
    project_nodes = []
    usage_edges = []
    claudemd_nodes = []
    doc_edges = []
    for root in roots:
        label = labels[root]
        has_claude_md = os.path.isfile(os.path.join(root, "CLAUDE.md"))
        node_ids = uses.get(label, [])
        project_nodes.append({
            "id": f"project:{label}",
            "name": label,
            "type": "project",
            "repo": "local",
            "description": f"Real project on disk at {root}."
                + (" Has its own CLAUDE.md." if has_claude_md else " No CLAUDE.md found."),
            "tools": [],
            "category": "project",
            "path": root,  # absolute, unlike skill/agent paths which are relative to sourceRoot
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
                "description": f"Project instructions Claude Code reads for {root}.",
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
    data["scannedProjects"] = [labels[r] for r in roots]
    with open(data_path, "w") as f:
        json.dump(data, f)

if __name__ == "__main__":
    main()
