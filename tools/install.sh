#!/bin/bash
# Verify and install the complete plugin; preserve settings and user model stores.
# Set LC_INSTALL_DEST for a temporary/test target. -n is a read-only dry run.
set -euo pipefail
DRY=0
[ "${1:-}" = "-n" ] && DRY=1
SRC="$(cd "$(dirname "$0")/../local-connections" && pwd)"
DEST="${LC_INSTALL_DEST:-$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/AlexNotes/.obsidian/plugins/local-connections}"
if [ ! -d "$DEST" ]; then
  echo "FAIL: plugin destination folder not found: $DEST" >&2
  exit 1
fi
"$(dirname "$0")/check.sh"
DEST="$(cd "$DEST" && pwd -P)"
assets=$("$(dirname "$0")/offline_assets_check.sh" "$SRC" --list)
plugin_files=(styles.css README.md d3.v7.min.js manifest.json main.js)

# Preflight before the first copy. A synced or linked child of the plugin
# directory must not redirect a temporary file or replacement elsewhere.
check_target() {
  local rel="$1" path="$DEST/$1"
  if [ -e "$path" ] && [ ! -f "$path" ]; then
    echo "FAIL: expected a regular file at $rel" >&2
    return 1
  fi
  while [ "$path" != "$DEST" ]; do
    if [ -L "$path" ]; then
      echo "FAIL: symlink in install path: $rel" >&2
      return 1
    fi
    path="${path%/*}"
  done
}
while IFS= read -r asset; do check_target "$asset"; done <<< "$assets"
for file in offline-assets.json "${plugin_files[@]}"; do check_target "$file"; done

# A failed/interrupted copy must never truncate a file in the live installation.
LC_INSTALL_TEMP=""
trap '[ -z "$LC_INSTALL_TEMP" ] || rm -f "$LC_INSTALL_TEMP"' EXIT
copy_file() {
  local rel="$1" source target
  source="$SRC/$rel"
  target="$DEST/$rel"
  if [ ! -f "$source" ]; then
    echo "FAIL: missing $source" >&2
    return 1
  fi
  if cmp -s "$source" "$target"; then
    printf '  %s unchanged\n' "$rel"
  elif [ "$DRY" -eq 1 ]; then
    printf '  %s WOULD UPDATE\n' "$rel"
  else
    mkdir -p "$(dirname "$target")"
    LC_INSTALL_TEMP="$(mktemp "$target.lc-install.XXXXXX")"
    cp "$source" "$LC_INSTALL_TEMP"
    cmp -s "$source" "$LC_INSTALL_TEMP"
    mv -f "$LC_INSTALL_TEMP" "$target"
    LC_INSTALL_TEMP=""
    printf '  %s updated\n' "$rel"
  fi
}

# Finish and verify the immutable assets before activating the new main.js.
while IFS= read -r asset; do copy_file "$asset"; done <<< "$assets"
copy_file offline-assets.json
if [ "$DRY" -eq 0 ]; then
  "$(dirname "$0")/offline_assets_check.sh" "$DEST"
fi
for file in "${plugin_files[@]}"; do
  copy_file "$file"
done
if [ "$DRY" -eq 1 ]; then
  echo "Dry run — nothing copied."
else
  echo "Installed to $DEST"
  echo "Toggle Local Connections off/on in Obsidian to load it."
fi
