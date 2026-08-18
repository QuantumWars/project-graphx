// Every path this plugin reads or writes is resolved here, and nowhere else.
//
// The original tool was a single repo: graph-data.json, overlay.json,
// imported-repos/ and sources.json all sat at fixed offsets from the source
// tree, so `__dirname/../neo4j-graph-app/data/...` was a correct answer. As a
// plugin that assumption is false twice over. The plugin lives in
// ~/.claude/plugins/, which is wiped and rewritten on every reinstall — so
// nothing the user creates may be stored there. And it serves many projects
// at once, so there is no single data file to point at.
//
// So: code lives with the plugin, data lives with the project. Everything
// below is derived from exactly two questions — where is the plugin, and
// where is the project — each answered once, here.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

// --- plugin root -----------------------------------------------------------
// CLAUDE_PLUGIN_ROOT is set by Claude Code when it launches a plugin's MCP
// server, and is the answer whenever it is present.
//
// The fallback matters more than it looks. `__dirname` is correct when these
// modules run from source, but the shipped server is a single bundled file,
// and the bundler inlines __dirname as a STRING LITERAL fixed at build time —
// the absolute path on the machine that built it. On anyone else's machine
// that path does not exist, so trusting it would silently point buildScript()
// and scanScript() at nothing.
//
// So a candidate is only accepted if the plugin manifest is actually there.
// process.argv[1] is where node was really told to look, which survives
// bundling and relocation; __dirname is tried first because it is the correct
// answer when running from source, where argv[1] may be a test runner instead.
const PLUGIN_MARKER = path.join(".claude-plugin", "plugin.json");

function pluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return path.resolve(process.env.CLAUDE_PLUGIN_ROOT);
  const candidates = [path.resolve(__dirname, "..")];
  if (process.argv[1]) candidates.push(path.resolve(path.dirname(process.argv[1]), ".."));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, PLUGIN_MARKER))) return c;
  }
  // Neither candidate holds the manifest. candidates[0] is derived from
  // __dirname, which in the bundle is a literal frozen at build time — on
  // anyone else's machine it names a directory that does not exist, and the
  // eventual error quotes the build machine's filesystem instead of theirs.
  // Returning it anyway is still the best guess available, but it must not be
  // silent, or the next person debugging this starts from a path that was
  // never real for them.
  console.error(`skill-graph: could not locate the plugin root (no ${PLUGIN_MARKER} above ${candidates.join(" or ")}). Set CLAUDE_PLUGIN_ROOT if this is wrong.`);
  return candidates[0];
}

// --- project root ----------------------------------------------------------
// Four answers in descending order of how much we trust them:
//
//   1. GRAPH_PROJECT_DIR    — explicit, set by the user or by a test.
//   2. CLAUDE_PROJECT_DIR   — set by Claude Code in hook environments.
//   3. an upward walk       — nearest ancestor of cwd holding .claude/ or .git.
//   4. cwd                  — nothing found; the working directory is the
//                             honest last answer.
//
// The walk exists because neither environment variable is contractually
// guaranteed for a stdio MCP server, and silently writing a project's graph
// into whatever directory a shell happened to be in is the failure this
// avoids. It stops at the filesystem root, not after a fixed number of
// levels, so a deeply nested cwd still finds its project.
function projectRoot() {
  if (process.env.GRAPH_PROJECT_DIR) return path.resolve(process.env.GRAPH_PROJECT_DIR);
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);

  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, ".claude")) || fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit / — no marker anywhere above cwd
    dir = parent;
  }
  return process.cwd();
}

// --- derived locations -----------------------------------------------------
// Under .claude/ rather than a top-level dot-directory so the graph travels
// with the repository alongside the agents and skills it catalogues, and is
// visible in a diff rather than hidden in a home directory.
function dataDir() {
  return process.env.GRAPH_DATA_DIR
    ? path.resolve(process.env.GRAPH_DATA_DIR)
    : path.join(projectRoot(), ".claude", "graph");
}

const dataPath = () => path.join(dataDir(), "graph-data.json");
const overlayPath = () => path.join(dataDir(), "overlay.json");
const configPath = () => path.join(dataDir(), "config.json");
const importRoot = () => path.join(dataDir(), "imported-repos");

const buildScript = () => path.join(pluginRoot(), "scripts", "build-graph.py");
const scanScript = () => path.join(pluginRoot(), "scripts", "scan-project-usage.py");
const appDir = () => path.join(pluginRoot(), "app");

function ensureDataDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
  return dataDir();
}

// --- python interpreter ----------------------------------------------------
// The usage scanner is a Python 3 script, and the name of the interpreter is
// not the same everywhere. `python3` is correct on macOS and most Linux; a
// Windows install usually provides `python` and the `py` launcher instead and
// no `python3` at all. So the name is probed rather than assumed.
//
// The probe insists on major version 3. A machine where `python` is still
// Python 2 would otherwise pass a bare existence check and then fail inside
// the scanner on syntax, which reads as a broken plugin rather than a missing
// dependency.
//
// Probed once per process. The answer cannot change while we run, and every
// install would otherwise pay for up to three process spawns.
const PYTHON_CANDIDATES = [
  { cmd: "python3", args: [] },
  { cmd: "python", args: [] },
  { cmd: "py", args: ["-3"] }, // the Windows launcher, which has no `python3`
];

const PYTHON_PROBE = "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)";

let pythonCached; // undefined = never probed; null = probed, nothing usable

function pythonBin() {
  if (pythonCached !== undefined) return pythonCached;
  for (const c of PYTHON_CANDIDATES) {
    try {
      execFileSync(c.cmd, [...c.args, "-c", PYTHON_PROBE], { stdio: "ignore", windowsHide: true });
      pythonCached = c;
      return pythonCached;
    } catch {
      // Absent (ENOENT) or present but Python 2 (exit 1). Both mean "not this
      // one" and neither is worth reporting on its own — only the exhaustion
      // of every candidate is an error, and the caller raises that.
    }
  }
  pythonCached = null;
  return null;
}

// The names tried, for an error message that tells someone what to install
// rather than just that something was missing.
const pythonTried = () => PYTHON_CANDIDATES.map((c) => [c.cmd, ...c.args].join(" ")).join(", ");

// --- config ----------------------------------------------------------------
// `sources` says which trees hold agents and skills to catalogue. `scanRoots`
// says where to look for projects that might have installed them. Both are
// per-project, so both live with the project.
//
// The bare-array shape is the original sources.json format, still accepted so
// an existing repo can drop its file in unchanged and have it work.
const DEFAULT_CONFIG = {
  sources: [],
  scanRoots: [],
  scanExclude: ["/node_modules/"],
};

function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return { ...DEFAULT_CONFIG, exists: false, path: p };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const cfg = Array.isArray(raw) ? { sources: raw } : raw;
    return {
      sources: cfg.sources || [],
      // An empty scanRoots list means "scan nothing", which is a legitimate
      // choice — a user who only wants a catalogue and no usage overlay. It
      // must not be silently replaced by a default, so the fallback fires on
      // the key being absent, never on it being present and empty.
      scanRoots: cfg.scanRoots || [path.join(os.homedir(), "code")],
      scanExclude: cfg.scanExclude || DEFAULT_CONFIG.scanExclude,
      exists: true,
      path: p,
    };
  } catch (e) {
    return { ...DEFAULT_CONFIG, exists: true, path: p, error: `config.json is not valid JSON: ${e.message}` };
  }
}

function saveConfig(cfg) {
  ensureDataDir();
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  return configPath();
}

module.exports = {
  pluginRoot, projectRoot, dataDir, ensureDataDir,
  dataPath, overlayPath, configPath, importRoot,
  buildScript, scanScript, appDir,
  pythonBin, pythonTried,
  loadConfig, saveConfig, DEFAULT_CONFIG,
};
