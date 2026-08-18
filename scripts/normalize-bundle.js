#!/usr/bin/env node
// Post-processes server/server.bundle.mjs after `bun build`.
//
// The bundler resolves CommonJS `__dirname` at build time and writes it in as a
// string literal — the absolute path of whoever ran the build. That has two
// consequences, and neither is acceptable in a published artifact:
//
//   1. It ships the author's home directory to every user, and any error that
//      quotes it names a filesystem the reader does not have.
//   2. It makes the bundle non-deterministic. Two machines building identical
//      sources produce different bytes, so no CI job can check that the
//      committed bundle matches the sources it claims to be built from — and
//      that check is the only thing standing between an un-bundled edit and a
//      release that silently does nothing.
//
// The bundle is ESM, so the real directory is available at runtime from
// import.meta.url. Substituting it fixes both: the literal is gone, and the
// value is now correct on the machine actually running the code rather than on
// the one that built it.
//
// paths.js is the only consumer (`path.resolve(__dirname, "..")`, one of the
// candidates for the plugin root). It guards every candidate with an existsSync
// check on the plugin manifest, so even if this expression is wrong on some
// platform the fallback to process.argv[1] still finds the real root.
"use strict";

const fs = require("fs");
const path = require("path");

const BUNDLE = path.join(__dirname, "..", "server", "server.bundle.mjs");

// pathname is percent-encoded and carries a leading slash before a Windows
// drive letter; both are undone here so the result is a real filesystem path.
const RUNTIME_DIRNAME =
  'decodeURIComponent(new URL(".", import.meta.url).pathname).replace(/^\\/([A-Za-z]:)/, "$1").replace(/\\/$/, "")';

const FROZEN = /var __dirname = "(?:[^"\\]|\\.)*";/g;

const src = fs.readFileSync(BUNDLE, "utf-8");
const matches = src.match(FROZEN) || [];

if (matches.length === 0) {
  // Not an error to be silent about: if the bundler stops emitting the literal,
  // this script is dead weight and should be removed rather than left passing.
  console.error("normalize-bundle: no frozen __dirname literal found — check whether the bundler still emits one.");
  process.exit(1);
}

const out = src.replace(FROZEN, `var __dirname = ${RUNTIME_DIRNAME};`);
fs.writeFileSync(BUNDLE, out);

console.log(`normalize-bundle: replaced ${matches.length} frozen __dirname literal(s) with a runtime expression.`);
