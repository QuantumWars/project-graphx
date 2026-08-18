#!/usr/bin/env python3
"""Extract agents+skills from any number of local .claude-style repos into a
nodes/edges JSON for the graph viewer. Stdlib only.

Usage:
  build-graph.py <config.json> <output.json> [--project-root DIR]

config.json is the plugin's per-project config (.claude/graph/config.json). It
may be an object with a "sources" key, or — for the original standalone
format — a bare array of source entries.

Each source root is resolved against --project-root, not against the current
working directory. As a plugin this script is invoked from wherever the caller
happens to be, so a relative root like ".claude/skills" only has one stable
meaning: relative to the project the graph belongs to."""
import os, re, json, sys

def load_roots(config_path, project_root):
    if not os.path.isfile(config_path):
        print(f"graph config not found: {config_path}", file=sys.stderr)
        print("Run /skill-graph:setup to create one.", file=sys.stderr)
        sys.exit(1)
    with open(config_path) as f:
        raw = json.load(f)
    entries = raw if isinstance(raw, list) else raw.get("sources", [])
    if not entries:
        print(f"no sources configured in {config_path} — nothing to catalogue.", file=sys.stderr)
        print('Add entries under "sources", e.g. {"repo":"my-repo","root":".claude/skills","kind":"skill"}', file=sys.stderr)
        sys.exit(1)
    roots = []
    for e in entries:
        root = e["root"]
        root = root if os.path.isabs(root) else os.path.join(project_root, root)
        if not os.path.isdir(root):
            print(f"source root does not exist, skipping: {root}", file=sys.stderr)
            continue
        roots.append((e["repo"], root, e["kind"]))
    if not roots:
        print("every configured source root is missing on disk — nothing to catalogue.", file=sys.stderr)
        sys.exit(1)
    return roots

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
    "react","android","ios","swiftui","flutter",
]
# Tokens whose category is another token's. "swiftui" is Swift; "flutter" is
# the Dart framework. Without these the word boundary blocks the shorter name
# ("swift" cannot match inside "swiftui") and the skill loses its language.
LANG_ALIAS = {"golang": "go", "c++": "cpp", "swiftui": "swift", "flutter": "dart"}
ROLE_SUFFIX = [
    ("reviewer", "review"),
    ("build-resolver", "build"),
    ("tdd", "testing"),
    ("testing", "testing"),
    ("verification", "verification"),
    ("security", "security"),
    ("patterns", "patterns"),
]
# Substring matching is right for the truncated stems below ("vuln",
# "accessib", "orchestrat") — it is how they catch every inflected form. It is
# wrong for these, which are complete words that also sit inside unrelated
# ones: "ci" inside "specialist", "ui" inside "build", "ml" inside "yaml",
# "api" inside "rapid". Each was found by diffing real categories, not
# imagined. They alone get word-boundary treatment.
BOUNDED_KEYWORDS = {"ci", "cd", "ui", "ml", "api", "3d", "e2e"}

KEYWORD_FALLBACK = [
    (["security","vuln","secret","auth","injection"], "security"),
    (["test","tdd","e2e","coverage"], "testing"),
    (["review","audit","lint","quality"], "review"),
    (["docs","documentation","docstring","readme","comment"], "docs"),
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
    """Word-boundary match. A trailing DIGIT is allowed so a version-suffixed
    name still resolves — "nuxt4" is Nuxt, "react18" is React — while a
    trailing letter still blocks, which is the rule that stops "react"
    matching "reactivity"."""
    rx = _WORD_RE_CACHE.get(tok)
    if rx is None:
        rx = re.compile(r"(?<![a-z0-9])" + re.escape(tok) + r"(?![a-z])")
        _WORD_RE_CACHE[tok] = rx
    return rx.search(hay) is not None

def _kw_in(kw, hay):
    return _word_in_strict(kw, hay) if kw in BOUNDED_KEYWORDS else kw in hay

def _lang_of(hay):
    # Longest token first as a second line of defense (e.g. a hypothetical
    # token that's itself a whole word inside a longer compound token) — word
    # boundaries already do most of the real work here.
    for tok in sorted(LANG_TOKENS, key=len, reverse=True):
        if _word_in_strict(tok, hay):
            return "language:" + LANG_ALIAS.get(tok, tok)
    return None

def category_for(name, desc):
    """One principle, applied twice: what a thing is CALLED is evidence about
    what it is; what its description happens to mention is not.

    The original matched every rule against name+description together, so a
    single passing mention decided the category. The confirmed case: the
    `accessibility` skill says it generates ARIA "for Web and Native platforms
    (iOS/Android)" — an aside about coverage — and was filed under
    language:android. The same shape hits anything whose description names a
    platform, a framework or a tool it merely supports.

    So both tiers read the name first. Only when the name says nothing at all
    does the description get a vote, and a language read out of a description
    is a last resort, below every role signal — a description mentioning
    Python is weaker evidence than a description saying the thing is a test
    harness."""
    lname = name.lower()
    hay = lname + " " + desc.lower()

    lang = _lang_of(lname)
    if lang:
        return lang
    for suffix, cat in ROLE_SUFFIX:
        if suffix in lname:
            return cat
    for haystack in (lname, hay):
        for kws, cat in KEYWORD_FALLBACK:
            if any(_kw_in(k, haystack) for k in kws):
                return cat
    return _lang_of(hay) or "general"

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
PROJECT_ROOT = os.path.abspath(".")
if "--project-root" in args:
    i = args.index("--project-root")
    PROJECT_ROOT = os.path.abspath(args[i + 1])
    del args[i:i + 2]
if len(args) != 2:
    print("usage: build-graph.py <config.json> <output.json> [--project-root DIR]", file=sys.stderr)
    sys.exit(1)
config_path, out_path = args
ROOTS = load_roots(config_path, PROJECT_ROOT)
os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)

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

# Absolute path to the project root on THIS machine, at build time. Node
# "path" fields above are relative to this. Neither the packaged desktop app
# nor the MCP server can derive it themselves — both are installed outside the
# project, so their own __dirname says nothing about where the catalogued
# source files actually live.
out = {"nodes": nodes, "edges": edges, "sourceRoot": PROJECT_ROOT}
with open(out_path, "w") as f:
    json.dump(out, f)
