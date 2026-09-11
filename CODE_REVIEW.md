# Efficiency, security and privacy review — 11 September 2026

Reviewed the local plugin bundle, with emphasis on file access, model imports,
HTML construction, diagnostic logging, search and graph lifecycle, network entry
points, and the graph's computation loops. This was a static code review backed
by synthetic regression tests, not a penetration test or a live network capture.
No real vault data was accessed for this review.

| Finding | Impact and implemented change |
| --- | --- |
| ONNX fallback path bypass | A modified local-model registry could supply traversal paths in `onnx_files`, bypassing validation of the worker's original request. Fallbacks now accept only simple ONNX filenames before any filesystem operation. |
| Model metadata inserted as HTML | Model display names, provider names and model keys were interpolated into settings markup without escaping. They now render as escaped text. |
| Model config allocation before size checks | Import parsed config files before the total-copy limit applied. Each config is now limited to 1 MB before reading and must contain a JSON object. The tokenizer vocabulary file is copied normally; this limit applies to configuration metadata only. |
| Sensitive diagnostic dumps | Removed whole app/environment/plugin, prompt/recent-file, malformed-record and graph-object dumps. Invalid search content now returns zero matches without dereferencing null or logging the content. Ordinary error diagnostics remain; some can include note paths. |
| Unbounded HTML template cache | Unique markup could be retained for the entire plugin session. The cache now holds at most 128 templates, each at most 16,384 characters; larger markup still renders without being cached. |
| Force-graph lifecycle leaks | Replacing a simulation now stops the previous one. Removing the sidebar graph disposes it and clears its retained reference. Superseded scheduled renders and disposed async updates cannot restart it. |

Larger changes left for discussion:

1. **Bundle the embedding runtime for offline operation.** The worker imports
   Transformers.js 4.2.0 from jsDelivr, even for imported local model files.
   Built-in models also permit remote model downloads. The plugin's embedding
   code passes notes and queries to a local worker, and no explicit telemetry or
   cloud embedding request was found, but remote runtime code processes that
   plaintext. Version pinning is not an integrity check. Bundling the runtime,
   its WASM/backend dependencies and a verified asset manifest would remove this
   runtime CDN dependency; it needs packaging changes and GPU/WASM/offline tests.
   Imported model files alone do not make the plugin fully offline.
2. **Scale whole-vault neighbour search.** `lc_vault_knn` compares every pair:
   `n * (n - 1) / 2`, with work proportional to vector dimensions. At 10,000
   notes that is 49,995,000 vector comparisons. Chunking yields to the UI but
   does not reduce the computation. Moving computation to a worker and evaluating
   an approximate neighbour index would be a larger project requiring speed,
   memory, cancellation and result-quality comparisons on representative vaults.

Validation: `tools/check.sh` passes all six suites. The new regression suite
covers malicious fallback paths and valid sidecars, metadata escaping, oversized
and malformed configs, null/content logging, cache eviction, and graph disposal
and async cancellation. `git diff --check` passes. No live Obsidian UI pass,
model-download/inference integration test, dependency vulnerability audit or
external-media traffic capture was performed. Markdown previews still delegate
to Obsidian's renderer; this review does not establish a no-network guarantee
for rendered note content.
