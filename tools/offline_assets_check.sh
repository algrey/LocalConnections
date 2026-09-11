#!/bin/bash
# Verify every immutable runtime/model asset listed by offline-assets.json.
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/../local-connections" && pwd)}"
MANIFEST="$ROOT/offline-assets.json"
if [ ! -f "$MANIFEST" ]; then
  echo "FAIL: missing $MANIFEST" >&2
  exit 1
fi
/usr/bin/python3 - "$ROOT" "$MANIFEST" <<'PY'
import hashlib, json, os, sys
root, manifest_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as f:
    manifest = json.load(f)
files = {}
files.update(manifest.get("runtime", {}).get("files", {}))
files.update(manifest.get("runtime", {}).get("license_files", {}))
for model_name, model in manifest.get("models", {}).items():
    files.update({os.path.join("bundled-models", model_name, path): digest
                  for path, digest in model.get("files", {}).items()})
required = {
    "runtime/transformers-4.2.0.js", "runtime/ort-wasm-simd-threaded.asyncify.mjs",
    "runtime/ort-wasm-simd-threaded.asyncify.wasm", "runtime/ort-wasm-simd-threaded.jsep.mjs",
    "runtime/ort-wasm-simd-threaded.jsep.wasm", "runtime/LICENSE-APACHE-2.0.txt",
    "runtime/ort-wasm-simd-threaded.mjs", "runtime/ort-wasm-simd-threaded.wasm",
    "runtime/LICENSE-MIT-ONNXRUNTIME.txt", "runtime/NOTICE.txt",
    "bundled-models/snowflake-arctic-embed-xs/LICENSE-APACHE-2.0.txt",
    "bundled-models/snowflake-arctic-embed-xs/LICENSE.txt",
    "bundled-models/snowflake-arctic-embed-xs/config.json",
    "bundled-models/snowflake-arctic-embed-xs/tokenizer.json",
    "bundled-models/snowflake-arctic-embed-xs/tokenizer_config.json",
    "bundled-models/snowflake-arctic-embed-xs/onnx/model_quantized.onnx"
}
if not required.issubset(files):
    raise SystemExit("FAIL: asset manifest omits required files: " + ", ".join(sorted(required - files.keys())))
failed = False
for rel, expected in files.items():
    path = os.path.realpath(os.path.join(root, rel))
    if not path.startswith(os.path.realpath(root) + os.sep) or not isinstance(expected, str) or not expected.startswith("sha256:"):
        raise SystemExit("FAIL: invalid asset manifest path/hash")
    if not os.path.isfile(path):
        print(f"FAIL: missing bundled asset {rel}", file=sys.stderr)
        failed = True
        continue
    digest = hashlib.sha256()
    with open(path, "rb") as asset:
        for chunk in iter(lambda: asset.read(1024 * 1024), b""):
            digest.update(chunk)
    actual = "sha256:" + digest.hexdigest()
    if actual != expected:
        print(f"FAIL: checksum mismatch {rel}\n  expected {expected}\n  actual   {actual}", file=sys.stderr)
        failed = True
if failed:
    sys.exit(1)
print(f"Offline assets verified: {len(files)} files")
PY
