#!/usr/bin/env python3
"""What this repo has in its own .claude/ that the global catalogue does not.

Used by two callers with the same answer: /skill-graph:push, to know what it is
about to register, and the SessionStart hook, to remind you that something is
unregistered. They must agree, so there is one implementation and not two.

"Unpushed" is decided by comparing the repo's source ROOTS against the global
config's, not by comparing item names. A repo is registered as a whole
directory, so a repo with one registered root and a new skill inside it is
already covered — the next global build picks the skill up with no action from
anyone. Comparing names would nag forever about exactly that case.

Two different kinds of drift, which need different fixes and so are reported
separately. A root the global config has never heard of needs /skill-graph:push.
A root it knows, holding a file newer than the built graph, needs only a
rebuild — that is the ordinary case once a repo has been pushed once, and the
one the reminder exists for.

Prints JSON, so a caller can act on it, and exits 0 whether or not anything is
unpushed. It is a report, not a gate.

Usage:
  unpushed.py <repo-root> [--global-config PATH]
"""
import json, os, sys

INFRA = {t["kind"]: t for t in json.load(open(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "claude-infra.json")))["types"]}

# Directories that hold authored infrastructure but cannot become graph nodes,
# reported so that "nothing to push" never quietly means "I ignored these".
UNCATALOGUED = ["hooks"]

def global_config_path():
    d = os.environ.get("GRAPH_DATA_DIR")
    return os.path.join(d, "config.json") if d else None

def registered_roots(config_path):
    if not config_path or not os.path.isfile(config_path):
        return None  # no global catalogue at all — a different situation from an empty one
    try:
        with open(config_path) as f:
            raw = json.load(f)
    except (ValueError, OSError):
        return None
    entries = raw if isinstance(raw, list) else raw.get("sources", [])
    return {os.path.realpath(e["root"]) for e in entries if "root" in e}

def newest_mtime(root):
    """The most recently touched file anywhere under root, or 0 for an empty
    tree. Compared against the built graph's own mtime to decide staleness."""
    newest = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for f in filenames:
            try:
                newest = max(newest, os.path.getmtime(os.path.join(dirpath, f)))
            except OSError:
                pass
    return newest

def count(root, kind):
    spec = INFRA[kind]
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return 0
    if spec["layout"] == "flat":
        return sum(1 for n in names if n.endswith(".md"))
    return sum(1 for n in names if os.path.isfile(os.path.join(root, n, spec["entryFile"])))

def plural(n, word):
    return "%d %s%s" % (n, word, "" if n == 1 else "s")

def reminder(out):
    """The one line the session-start hook prints, or "" for silence.

    Lives here rather than in the hook so there is one implementation of what
    counts as drift and how it is worded. The hook shells out; it does not
    reimplement this in awk.

    Silent without a global catalogue: someone who has never run setup-global
    has not opted into any of this and must not be nagged toward it.
    """
    if not out.get("hasGlobalCatalogue"):
        return ""
    parts = []
    if out["unpushed"]:
        listed = ", ".join(plural(i["count"], i["kind"]) for i in out["unpushed"])
        parts.append("%s not in the global catalogue — /skill-graph:push" % listed)
    if out["stale"]:
        listed = ", ".join(plural(i["count"], i["kind"]) for i in out["stale"])
        parts.append("%s changed since the last global build — rebuild to see them" % listed)
    if not parts:
        return ""
    return "[skill-graph] " + "; ".join(parts) + "\n"

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    repo = os.path.realpath(args[0] if args else ".")
    cfg = None
    if "--global-config" in sys.argv:
        cfg = sys.argv[sys.argv.index("--global-config") + 1]
    else:
        cfg = global_config_path()

    known = registered_roots(cfg)
    graph = os.path.join(os.path.dirname(cfg), "graph-data.json") if cfg else None
    graph_mtime = os.path.getmtime(graph) if graph and os.path.isfile(graph) else 0
    out = {
        "repo": repo,
        "globalConfig": cfg,
        "hasGlobalCatalogue": known is not None,
        "unpushed": [],
        "stale": [],
        "registered": [],
        "uncatalogued": [],
    }
    for kind, spec in INFRA.items():
        root = os.path.join(repo, ".claude", spec["installDir"])
        if not os.path.isdir(root):
            continue
        n = count(root, kind)
        if n == 0:
            continue
        entry = {"kind": kind, "root": root, "count": n}
        if known is not None and os.path.realpath(root) in known:
            # Registered, so nothing to push — but a root registered months ago
            # says nothing about whether the graph has seen what is in it today.
            # This is the ordinary case after the first push, and the one the
            # reminder exists for: you add a skill, the root is already known,
            # and only a rebuild makes it visible.
            if graph_mtime and newest_mtime(root) > graph_mtime:
                out["stale"].append(entry)
            out["registered"].append(entry)
        else:
            out["unpushed"].append(entry)

    for d in UNCATALOGUED:
        p = os.path.join(repo, ".claude", d)
        if os.path.isdir(p):
            files = [f for f in os.listdir(p) if not f.startswith(".")]
            if files:
                out["uncatalogued"].append({"dir": d, "root": p, "count": len(files)})

    if "--reminder" in sys.argv:
        print(reminder(out), end="")
    else:
        print(json.dumps(out, indent=2))

main()
