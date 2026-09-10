# Local Connections — developing

## Repo layout

| Path | What it is |
|---|---|
| `local-connections/` | **The plugin. The source of truth.** `main.js`, `styles.css`, `manifest.json`, `README.md`, `d3.v7.min.js` |
| `tools/check.sh` | Runs the five jsc tests. Run after every edit |
| `tools/install.sh` | Verifies, then copies the five files into the vault (`-n` for a dry run) |
| `tools/modules.py` | Maps the ~380 modules inside `main.js` — the way to navigate 30k lines |
| `tools/*_test.js` | The jsc tests themselves |
| `tools/harness/` | Browser harness for the vault graph (real bundle + real d3, fake env); see *Testing the vault graph* |

## The loop

```bash
tools/check.sh          # 5 jsc tests, ~2s
tools/install.sh        # checks, then copies to the vault
```

Then toggle Local Connections off and on in Obsidian → Settings → Community
plugins, and watch the developer console (⌥⌘I).

`check.sh` catches **top-level** evaluation errors — a `ReferenceError` from a
symbol you renamed or deleted — plus the retrieval, blocks-gate and
notice/min-length logic. It does **not** touch the UI. Anything that only runs
inside a handler needs a manual pass:

- open the Connections view, switch notes
- run a search; change results type (Notes ⇄ Blocks) in both dropdowns
- open settings (whole tab renders, inline "Local Connections engine" section at the end)
- open the hamburger menu; switch Graph style (Classic ⇄ Force graph)
- ⌘-click a result row and a graph node (both insert a link)
- open the vault graph (orbit ribbon icon); hover a hub, click a hub, click a
  note, change the cluster count and the neighbour count; switch Layout
  (Springs ⇄ PCA ⇄ Neighbours) and Names (Nearest note ⇄ Keywords) in the
  toolbar and in Settings → Vault graph → *Vault visualisation*

## Finding code

The bundle is esbuild output, so every module is preceded by its path as a
comment (`// node_modules/obsidian-smart-env/src/components/env_stats.js`). A
module body runs from its header to the next header. That makes the comment
lines both the map and the safe cut boundaries.

```bash
tools/modules.py -s                 # biggest sections first
tools/modules.py smart-blocks       # sections matching a path
tools/modules.py "local connections"  # this fork's own appended sections
```

**Everything this fork added is prefixed `lc_` / `LC_`.**
`grep -n 'lc_' local-connections/main.js` is the fastest way to see fork code.
The fork's own appended code sits in six banner sections at the end of the file
— the embedded visualizer (~6,200 lines, mostly its d3) plus the Local
Connections code:

| Section | What lives there |
|---|---|
| `// ===== Embedded Smart Connections Visualizer =====` | the SCV bundle + its d3, in an IIFE (~6,200 lines with d3) |
| `// ===== Local Connections: visualizer graph component + renderer selection =====` | graph component, node click / ⌘-click, wikilinks |
| `// ===== Local Connections settings UI / local models =====` | local ONNX model files, settings cleanup |
| `// ===== Local Connections semantic search =====` | search panel, graph-follows-search |
| `// ===== Local Connections blocks on demand =====` | `lc_embed_blocks` gate |
| `// ===== Local Connections: vault graph =====` | `LcVaultGraphView`, the chunked k-means / kNN, the canvas renderer (adapted from Smart Vault Visualizer, MIT notice at the top of the section) |
| `// ===== Local Connections: native notices =====` | `lc_register_native_notices`, the replacement for upstream's `event_logs` |

The other ~60 fork changes are small in-place edits scattered through upstream
code. There is no generated index of them any more; `git log -p` on
`local-connections/main.js` is the record, and `tools/modules.py` is how you
find your way around the file.

## Invariants — these will bite you

Lifted from the retired scripts' docstrings, because these are the constraints
that are invisible in the code itself.

1. **Never put view state under a settings path containing `connections_lists`.**
   Writing there triggers a full connections-view re-render, which destroys the
   graph mid-slider-drag. That is why visualizer settings live at
   `env.settings.visualizer` and search settings at `env.settings.lc_search`.
2. **The local-model worker code assumes transformers.js 4.2.0's hub loader**:
   it resolves `env.localModelPath + model_id + file` first and treats a 404
   `Response` as "not found". If the pinned runtime is bumped, re-verify
   `env.fetch` / `localModelPath` / 404 semantics against that release's
   `src/utils/hub.js`.
3. **Every *functional* reader of the "Embed blocks" toggle must call
   `lc_embed_blocks(env)`**, not the raw setting — 11 call sites. The two
   settings dropdowns deliberately read the raw toggle so "Blocks" stays
   selectable.
4. **Connections filters must go into `params.filter`** (consumed by
   `CollectionItem.filter`). Nothing reads the legacy
   `env.settings.smart_view_filter` object; settings saved there silently do
   nothing, which is the bug v1.4.1 fixed.
5. **`env.is_pro` is never set** in this bundle. Don't reintroduce a check on it
   — that is the gate v1.4.1 removed.
6. **The d3 loader must assign `window.d3`**, not a CommonJS export, or the
   classic graph silently never renders.
7. **CSS specificity beats SVG attributes, and the classic renderer injects its
   own stylesheet on first render** — its `.connections-graph { block-size: auto }`
   outranks the visualizer's box height. Fork rules need enough specificity to
   win; see the comments around the `.lc-visualizer-graph` rules.
8. **Force-graph reset (↻ in the gear menu) must restore fork defaults, not SCV
   stock.** Stock is Blocks-only + a 50% threshold, which blanks the graph when
   results are notes.
9. **Declarations are referenced by name from config objects far below them**
   (`components`, `actions`, `items`, `collections`). Before deleting any
   `var X = class …`, grep the name and confirm the count drops to zero.
10. **The actions config literal (`smart_env_config3`) is evaluated before the
    appended fork sections run.** A `var` spec defined in an appended section
    and referenced from that literal is still `undefined` at that point
    (function declarations are hoisted, `var` initialisers are not) — the two
    semantic-search commands silently never registered for this reason
    (v1.5.0–v1.8.0). Register from the section instead, after the literal
    exists: `smart_env_config3.actions.my_action = { … }` (see the end of the
    vault-graph section). `tools/vault_graph_logic_test.js` asserts the specs
    are present.
11. **Never `setTimeout`-yield inside the vault graph's compute loops** —
    `lc_vault_yield()` uses a `MessageChannel` because `setTimeout(0)` is
    clamped to 4 ms and throttled to ≥1 s in background windows, which turned a
    30 ms clustering into a 6 s one. The layout waits on `requestAnimationFrame`
    on purpose (it should pause with a hidden window).

## Awkward spots

- **The embedding worker is JS inside a string literal** —
  `var transformers_v4_worker_default = "…"` (one ~13,400-character line; grep
  for the name). It is turned into a `Blob` and run as a Worker. Edits need
  `\n` and `\"` escaping by hand, and mistakes surface only at embed time in the
  worker's own console. The `env.fetch` override for `lc-local/<folder>` models
  lives in here.
- **Component CSS is inlined as string literals too** (esbuild's CSS loader):
  16 lines in the file exceed 1,000 characters and they are all of this shape,
  e.g. `style_default2`, `env_stats_default`, `source_inspector_default`. Fine
  to edit, just long.
- **`local-connections/styles.css`** is what survives of the upstream stylesheet
  (trimmed to the components that still render in v1.6.0) plus four appended
  fork sections, marked `/* ===== … ===== */`. Plain CSS; edit freely. The
  upstream part still carries `/* Imported from: … */` markers naming the
  component each block came from — those are the safe cut boundaries if a
  component is ever removed.

## Testing the vault graph

`check.sh` covers the k-means / kNN / grouping logic. The canvas renderer and
its mouse handling only run in a browser, so `tools/harness/index.html` loads
the real `main.js` and the real `d3.v7.min.js` with a fake env (N synthetic
notes in G groups; `?n=2500&g=12`) and stubbed Obsidian DOM helpers, then
renders `LcVaultGraphView` full-page. Serve it with a plain static server —
no Node on this Mac, and the pyenv `python3` shim fails from the app's launcher,
so use the system one:

```bash
cd tools/harness && /usr/bin/python3 -m http.server 8765 --bind 127.0.0.1
```

`.claude/launch.json` attaches the app's Browser pane to that URL
(`vault-graph-harness`). `window.view.lc_graph.debug` exposes the hit-test and
the current zoom transform. Caveat: while the Browser pane is hidden its
`requestAnimationFrame` and d3 timers are paused, so the layout only advances
when a screenshot forces a frame; synthetic `MouseEvent`s dispatched on the
canvas still exercise the handlers. The harness stubs `module`/`exports`, so
d3's UMD takes the CommonJS branch — the page mirrors it onto `window.d3` (the
same gotcha as invariant 6).

## Releasing a version

Three places, by hand (the scripts used to do this):

1. `local-connections/manifest.json` — `"version"`.
2. `local-connections/README.md` — add a changelog line at the top.
3. `local-connections/main.js` — the `/*! local-connections vX.Y.Z … */` banner
   on line 1. It was stale from v1.1.0 to v1.7.0; brought back in step at
   v1.8.0, keep it there.

(There used to be a fourth: the in-app release notes string. The
`ReleaseNotesView` was removed in v1.6.0 — the README is the changelog now.)




