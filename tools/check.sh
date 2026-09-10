#!/bin/bash
# Verify local-connections/main.js: evaluates cleanly and the patched logic
# paths still behave. Run after every edit to main.js.
#
#   tools/check.sh
#
# These tests catch top-level evaluation errors (ReferenceError from a deleted
# or renamed symbol) and the retrieval / blocks / notice logic. They do NOT
# exercise the UI: anything that only runs inside a handler still needs a manual
# pass in Obsidian (open Connections view, switch notes, run a search, change
# results type, open settings, open the hamburger menu, Cmd-click a row).
set -u

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -x "$JSC" ]; then
  echo "FAIL: jsc not found at $JSC" >&2
  exit 1
fi

fail=0
for t in smoke_test search_logic_test blocks_logic_test unembedded_notice_test vault_graph_logic_test; do
  printf '%-24s ' "$t"
  if out=$("$JSC" "$DIR/$t.js" 2>&1); then
    echo "ok"
  else
    echo "FAIL"
    echo "$out" | sed 's/^/    /'
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo
  echo "All checks passed. main.js: $(wc -c < "$DIR/../local-connections/main.js" | tr -d ' ') bytes, $(wc -l < "$DIR/../local-connections/main.js" | tr -d ' ') lines."
else
  echo
  echo "Checks failed — do not install." >&2
fi
exit "$fail"
