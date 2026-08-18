// Four files state this plugin's version, and nothing kept them in step. A bump
// that misses one is invisible: Claude Code reads plugin.json to decide whether
// a cached install is stale, the marketplace entry is what a user installs from,
// and the server advertises its own number over MCP — so a partial bump ships a
// plugin that reports one version and behaves like another.
//
// The MCP number is read from the running server rather than from the source
// file, because that is the one a client actually sees, and it travels through
// the bundle. A bundle rebuilt from stale source fails here.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { spawn } from "child_process";

const PLUGIN = resolve(import.meta.dir, "..");
const read = (p) => JSON.parse(readFileSync(join(PLUGIN, p), "utf-8"));

test("every manifest states the same version", () => {
  const declared = read("package.json").version;
  expect(read(".claude-plugin/plugin.json").version).toBe(declared);
  expect(read(".claude-plugin/marketplace.json").plugins[0].version).toBe(declared);
});

test("the running server advertises that version, through the shipped bundle", async () => {
  const declared = read("package.json").version;
  const proc = spawn(process.execPath, [join(PLUGIN, "server", "server.bundle.mjs")], {
    env: { ...process.env, GRAPH_DATA_DIR: "", CLAUDE_PLUGIN_ROOT: PLUGIN },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reply = await new Promise((res, rej) => {
    let buf = "";
    proc.stdout.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl !== -1) res(JSON.parse(buf.slice(0, nl)));
    });
    proc.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "v", version: "1" } },
    }) + "\n");
    setTimeout(() => rej(new Error("server did not answer initialize")), 15000);
  });
  proc.kill();
  expect(reply.result.serverInfo.version).toBe(declared);
});
