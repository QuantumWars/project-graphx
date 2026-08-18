#!/bin/sh
# Session-start reminder: does this repo hold .claude infrastructure the global
# catalogue has not seen, or has seen but not rebuilt since it changed?
#
# Session start rather than on-write, deliberately. A PostToolUse hook only sees
# what Claude wrote, so a skill added by hand, pulled from git, or copied from
# another repo would never trigger it — and those are most of them. Checking the
# directory catches every route in.
#
# What counts as drift, and how it is worded, live in unpushed.py. This file
# finds an interpreter and prints what that says; it does not decide anything,
# so the /skill-graph:push report and this reminder can never disagree.
#
# Exits 0 in every path, including failure. A reminder that can break a session
# start is worse than no reminder.
set -u

[ -n "${GRAPH_DATA_DIR:-}" ] || exit 0

SCRIPT="${CLAUDE_PLUGIN_ROOT:-}/scripts/unpushed.py"
[ -f "$SCRIPT" ] || exit 0

# Same probe order the MCP server uses, for the same reason: `python3` does not
# exist on a stock Windows install.
for c in python3 python; do
  if "$c" -c "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)" >/dev/null 2>&1; then
    "$c" "$SCRIPT" "${CLAUDE_PROJECT_DIR:-$PWD}" --reminder 2>/dev/null
    exit 0
  fi
done
if py -3 -c "" >/dev/null 2>&1; then
  py -3 "$SCRIPT" "${CLAUDE_PROJECT_DIR:-$PWD}" --reminder 2>/dev/null
fi
exit 0
