#!/usr/bin/env python3
"""Extract agents+skills from any number of local .claude-style repos into a
nodes/edges JSON for the graph viewer. Stdlib only.

Usage:
  build-graph.py [sources.json] <output.json>

sources.json lists which repos to scan and where — see sources.example.json
for the format. Defaults to ./sources.json when only the output path is given."""
import os, re, json, sys

def load_roots(sources_path):
    if not os.path.isfile(sources_path):
        print(f"sources config not found: {sources_path}", file=sys.stderr)
        print("Copy sources.example.json to sources.json and point it at your own repo(s) first.", file=sys.stderr)
        sys.exit(1)
    with open(sources_path) as f:
        entries = json.load(f)
    return [(e["repo"], e["root"], e["kind"]) for e in entries]

# --- category inference: language/framework tokens win first, then role suffixes,
# then a description-keyword fallback. Heuristic, stated as such in the UI.
# No trailing-dash hacks needed ("go-", "java-") — real word-boundary matching
# (see _word_in below) means "go" can't match inside "django" and "java" can't
# match inside "javascript" without one. The old dash suffixes were a fragile
# workaround for the same problem: they happened to block SOME collisions
# (a following dash) but did nothing for others ("reactivity" still matched
# "react", "trusted" still matched "rust") and could false-negative on a
# legitimate plain-word mention in prose that had no trailing dash at all.
LANG_TOKENS = [
    "python","golang","go","rust","java","kotlin","swift","csharp","cpp","c++",
    "php","perl","ruby","typescript","javascript","dart","arkts","harmonyos",
    "django","laravel","quarkus","springboot","fsharp","angular","vue","nuxt",
    "react","android","ios",
]
ROLE_SUFFIX = [
    ("reviewer", "review"),
    ("build-resolver", "build"),
    ("tdd", "testing"),
    ("testing", "testing"),
    ("verification", "verification"),
    ("security", "security"),
    ("patterns", "patterns"),
]
KEYWORD_FALLBACK = [
    (["security","vuln","secret","auth","injection"], "security"),
    (["test","tdd","e2e","coverage"], "testing"),
    (["review","audit","lint","quality"], "review"),
    (["doc","readme","comment"], "docs"),
    (["deploy","docker","ci","cd","devops","infra","kubernetes","migration"], "devops"),
    (["database","postgres","sql","clickhouse","supabase"], "database"),
    # bare "design" removed: it's genuinely ambiguous English, not a
    # collision boundaries can fix — "Designs home network plans" is real
    # prose that has nothing to do with frontend work.
    (["frontend","react","ui","component","css","design system","ui design"], "frontend"),
    (["backend","api","server"], "backend"),
    (["research","market","investor","competitor"], "research"),
    (["writ","content","copy","marketing","social","seo","brand"], "content-marketing"),
    (["ml","eval","model","train","llm","agent","harness","orchestrat","loop","memory","instinct"], "agentic-ml"),
    (["accessib","a11y"], "accessibility"),
    (["video","audio","image","3d"], "media"),
]

# Word-boundary matching, LANG_TOKENS only. This is scoped deliberately
# narrow: LANG_TOKENS are real, complete technology names, so "react" should
# never match inside "reactivity", "rust" never inside "trusted", "go" never
# inside "django" — three confirmed real bugs, all the same shape (a short
# complete name is also a substring of an unrelated longer word).
#
# KEYWORD_FALLBACK is deliberately left on the ORIGINAL plain substring
# match. It's a carefully hand-tuned priority list using truncated stems on
# purpose ("vuln", "accessib", "orchestrat", "copywrit") to catch every
# inflected form via substring — tried word-boundary there too, and even
# with a suffix whitelist it broke forms the substring design intentionally
# relied on (e.g. "orchestrate" itself no longer matched "orchestrat") and
# measurably regressed category distribution catalog-wide (devops 50->6,
# frontend 27->3, general 18->45) — a much bigger, riskier blast radius than
# the one narrow, confirmed bug class this is actually fixing. Only "design"
# below was surgically fixed on its own merits (genuine word-sense
# ambiguity, not a boundary problem).
_WORD_RE_CACHE = {}
def _word_in_strict(tok, hay):
    rx = _WORD_RE_CACHE.get(tok)
    if rx is None:
        rx = re.compile(r"(?<![a-z0-9])" + re.escape(tok) + r"(?![a-z0-9])")
        _WORD_RE_CACHE[tok] = rx
    return rx.search(hay) is not None

def category_for(name, desc):
    hay = (name + " " + desc).lower()
    # Longest token first as a second line of defense (e.g. a hypothetical
    # token that's itself a whole word inside a longer compound token) — word
    # boundaries already do most of the real work here.
    for tok in sorted(LANG_TOKENS, key=len, reverse=True):
        if _word_in_strict(tok, hay):
            norm = tok.replace("c++", "cpp")
            if norm == "golang":
                norm = "go"
            return "language:" + norm
    for suffix, cat in ROLE_SUFFIX:
        if suffix in name.lower():
            return cat
    for kws, cat in KEYWORD_FALLBACK:
        if any(k in hay for k in kws):
            return cat
    return "general"

def read(p):
    try:
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return ""

def frontmatter(text):
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    fm = {}
    cur = None
    for line in parts[1].splitlines():
        if not line.strip():
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if m:
            cur = m.group(1)
            fm[cur] = m.group(2).strip()
        elif cur and line.startswith((" ", "\t", "-")):
            fm[cur] = (fm.get(cur, "") + " " + line.strip()).strip()
    return fm, parts[2]

args = sys.argv[1:]
if len(args) == 1:
    sources_path, out_path = "sources.json", args[0]
elif len(args) == 2:
    sources_path, out_path = args[0], args[1]
else:
    print("usage: build-graph.py [sources.json] <output.json>", file=sys.stderr)
    sys.exit(1)
ROOTS = load_roots(sources_path)

nodes = []
node_by_name = {}  # name -> list of node ids (names can collide across type/repo)
bodies = {}  # id -> body text (for edge extraction)

for repo, root, kind in ROOTS:
    if kind == "agent":
        files = sorted(f for f in os.listdir(root) if f.endswith(".md"))
        for f in files:
            path = os.path.join(root, f)
            text = read(path)
            fm, body = frontmatter(text)
            name = fm.get("name", f[:-3])
            desc = fm.get("description", "")
            tools_raw = fm.get("tools", "").strip("[]")
            tools = [t.strip() for t in re.split(r"[,\s]+", tools_raw) if t.strip()]
            nid = f"{repo}:agent:{name}"
            node = {
                "id": nid, "name": name, "type": "agent", "repo": repo,
                "description": desc, "tools": tools,
                "category": category_for(name, desc),
                "path": path,
            }
            nodes.append(node)
            node_by_name.setdefault(name, []).append(nid)
            bodies[nid] = body
    else:
        dirs = sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)))
        for d in dirs:
            path = os.path.join(root, d, "SKILL.md")
            if not os.path.isfile(path):
                continue
            text = read(path)
            fm, body = frontmatter(text)
            name = fm.get("name", d)
            desc = fm.get("description", "")
            nid = f"{repo}:skill:{name}"
            node = {
                "id": nid, "name": name, "type": "skill", "repo": repo,
                "description": desc, "tools": [],
                "category": category_for(name, desc),
                "path": path,
            }
            nodes.append(node)
            node_by_name.setdefault(name, []).append(nid)
            bodies[nid] = body

# --- edges: does node A's body mention node B's name (word-boundary, own-name excluded)?
# Names here are unique kebab-case slugs (low collision risk with prose), so a plain
# \bname\b match is a much stronger signal than the English-word collisions we hit
# auditing tool names. Still require min length 6 to avoid short-name noise.
#
# weight = how many times A's body actually says B's name — a real, counted
# signal (not a guess) for how strongly related the two are. One passing
# mention ("see also X") gets weight 1; a skill discussed repeatedly in the
# same file (intro + a worked example + a "gotchas" section) gets a higher
# weight. Used downstream to set edge length: stronger ties render shorter.
name_re = {}
for name in node_by_name:
    if len(name) >= 6:
        name_re[name] = re.compile(r"(?<![\w-])" + re.escape(name) + r"(?![\w-])")

edges = []
edge_seen = set()
for nid, body in bodies.items():
    src_name = nid.split(":", 2)[2]
    for name, rx in name_re.items():
        if name == src_name:
            continue
        count = len(rx.findall(body))
        if count > 0:
            for target_id in node_by_name[name]:
                if target_id == nid:
                    continue
                key = (nid, target_id)
                if key in edge_seen:
                    continue
                edge_seen.add(key)
                edges.append({"from": nid, "to": target_id, "weight": count})

print(f"nodes={len(nodes)} edges={len(edges)}", file=sys.stderr)
cat_counts = {}
for n in nodes:
    cat_counts[n["category"]] = cat_counts.get(n["category"], 0) + 1
for c, n in sorted(cat_counts.items(), key=lambda x: -x[1]):
    print(f"  {c}: {n}", file=sys.stderr)

# Absolute path to the repo root on THIS machine, at build time (the
# directory this script was run from). Node "path" fields above are relative
# to this. The packaged app can't derive this itself — packaging only
# bundles neo4j-graph-app/, not the sibling source repos sources.json points
# at, so __dirname inside the built .app no longer has any relationship to
# where the real source files live on disk.
out = {"nodes": nodes, "edges": edges, "sourceRoot": os.path.abspath(".")}
with open(out_path, "w") as f:
    json.dump(out, f)
