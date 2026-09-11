# Offline browser acceptance checks

Run `python3 tools/install_test.py` for installer acceptance in a temporary
directory. It verifies a read-only dry run, an injected partial-copy failure,
preservation of settings/custom/downloaded models, entrypoint activation order,
and detection of corrupted installed assets. It never targets a real vault.

`offline_browser_test.cjs` loads the real plugin bundle and embedding adapter in
a fresh Playwright browser context. It supplies a synthetic vault adapter backed
only by repository files. Every external request is blocked and counted; the
test fails if any are attempted. It never opens an actual vault or a personal
browser profile and does not download models.

Requires Node.js, Playwright and Chromium/Chrome. With those installed:

```sh
node tools/offline_browser_test.cjs
node tools/offline_browser_test.cjs --gpu
node tools/offline_browser_test.cjs --force-fallback
node tools/offline_browser_test.cjs --safari-backend
node tools/offline_browser_test.cjs --missing-runtime
node tools/offline_browser_test.cjs --missing-model
```

Set `LC_PLAYWRIGHT_MODULE` to an existing Playwright module directory if it is
outside Node's module search path. Set `LC_BROWSER_EXECUTABLE` to an existing
Chrome/Chromium executable to use it instead of Playwright's managed Chromium.

Successful inference must return three finite, normalized 384-dimensional
vectors and rank the related bicycle passage above the unrelated cake passage.
The GPU run reports its actual backend: machines without GPU support may fall
back to WASM. The forced-fallback run injects a GPU initialization failure into
the worker fixture and requires WASM inference to succeed. Missing-file runs
require a local failure, never a network fallback. Each run has a 90-second
deadline.

The Safari-backend run overrides the worker's browser detection and requires
the standard ONNX WASM backend to load. It tests that branch's asset closure in
Chromium; it does not replace testing on native Safari/iOS.

This verifies inference, backend assets and failure handling with empty caches.
It does not emulate Obsidian's custom resource URL protocol or prove the native
settings UI works; retain a manual Obsidian pass before a public release.
