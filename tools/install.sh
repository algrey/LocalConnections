#!/bin/bash
# Copy the plugin into the Obsidian vault, after verifying it.
#
#   tools/install.sh        install
#   tools/install.sh -n     dry run: show what would change, copy nothing
#
# Copies only the five plugin files. Never touches the vault copy's data.json
# (plugin settings) or models/ (local embedding model folders, which can be
# hundreds of MB), and never deletes anything.
#
# After installing, toggle Local Connections off and on in Obsidian
# (Settings -> Community plugins) to load the new bundle.
set -u

DRY=0
[ "${1:-}" = "-n" ] && DRY=1

SRC="$(cd "$(dirname "$0")/../local-connections" && pwd)"
DEST="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/AlexNotes/.obsidian/plugins/local-connections"
FILES="main.js styles.css manifest.json README.md d3.v7.min.js"

if [ ! -d "$DEST" ]; then
  echo "FAIL: vault plugin folder not found:" >&2
  echo "  $DEST" >&2
  exit 1
fi

if ! "$(dirname "$0")/check.sh"; then
  echo "Refusing to install a bundle that fails its checks." >&2
  exit 1
fi

echo
for f in $FILES; do
  if [ ! -f "$SRC/$f" ]; then
    echo "FAIL: missing $SRC/$f" >&2
    exit 1
  fi
  if cmp -s "$SRC/$f" "$DEST/$f"; then
    printf '  %-16s unchanged\n' "$f"
  elif [ "$DRY" -eq 1 ]; then
    printf '  %-16s WOULD UPDATE\n' "$f"
  else
    cp "$SRC/$f" "$DEST/$f"
    printf '  %-16s updated\n' "$f"
  fi
done

echo
if [ "$DRY" -eq 1 ]; then
  echo "Dry run — nothing copied."
else
  echo "Installed to $DEST"
  echo "Now toggle Local Connections off/on in Obsidian to load it."
fi
