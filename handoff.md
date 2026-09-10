# Handoff — improving the vault graph and the embeddings behind it

Written 2026-09-10 at **v1.9.2** (commit `8b8d57e`). Read `DEVELOPING.md` first
for the repo layout, the dev loop and the invariants; this file is only about
the vault graph and what to build on it next. Line numbers are for v1.9.2 and
will drift — search for the function names instead.

## 1. Where things stand

The vault graph (v1.9.0–v1.9.2) is a whole-vault semantic map in its own tab:
every embedded note is a node, k-means clusters over the embeddings become
hubs, and three link layers (cluster spokes, top-k neighbours, wikilinks) are
drawn on a canvas with the local `d3.v7.min.js`. Alex has confirmed it working
in Obsidian, including hub-click zoom and the settle-phase behaviour.

Everything lives in one banner section of `local-connections/main.js`,
`// ===== Local Connections: vault graph =====` (~line 30297, ~1,300 lines),
placed before the native-notices section. The section header reproduces the
MIT notice for the canvas renderer, adapted from `clusters_visualizer.js` of
Smart Vault Visualizer v1.0.44 (© 2024 Mossy1022). The clustering is our own.

| Piece | Where | Notes |
|---|---|---|
| Settings + defaults | `LC_VAULT_GRAPH_DEFAULTS`, `LC_VAULT_GRAPH_SETTINGS_CONFIG`, `lc_vault_graph_settings(env)` | stored at `env.settings.lc_vault_graph` — never under `connections_lists.*` (invariant 1) |
| Vector maths | `lc_vault_unit_vec`, `lc_vault_dot` (4× unrolled), `lc_vault_yield` (MessageChannel), `lc_vault_ticker` | ticker = budgeted yield + progress + cancel (`throw "cancelled"`) |
| Clustering | `lc_vault_kmeans(vecs, k, {tick, seed, max_iter})` | spherical k-means, k-means++ seeding, Float32 unit vectors; empty clusters are dropped later |
| Neighbours | `lc_vault_knn(vecs, k, {tick})` | symmetric top-k, each pair compared once (`j > i`), returns `{source, target, score}` by index |
| Data | `lc_vault_graph_collect_notes(env)`, `lc_vault_graph_build_clusters(notes, result)` | notes = every `smart_sources` item with a `vec`; cluster named after the member nearest its centroid |
| View | `LcVaultGraphView` (`view_type` `lc-vault-graph`, opens in a root tab, icon `orbit`) | `rebuild({keep_notes, keep_clusters})` is the pipeline; stages are cached on `view.lc_data = {notes, clusters, knn, knn_k, wikilinks}` |
| Chrome | `lc_vault_graph_build_ui`, `lc_vault_graph_sync_controls`, `lc_vault_graph_set_status`, `lc_vault_graph_show_empty` | toolbar writes settings through `write()` which mutes the view's own `settings:changed` listener |
| Canvas | `lc_vault_graph_mount(view, build_id)` | nodes/links, forces (`const simulation = …`), `select_links`, zoom/drag/hover, `highlight`, `draw`, `fit_to`, settle loop + `auto_fit`; returns a handle `view.lc_graph` with `apply_links / set_pinned / set_query / fit / destroy / debug` |
| Clicks | `lc_vault_graph_open_note` | click → new tab + focus; ⌘-click → copy link (`fileManager.generateMarkdownLink(file, "")`) |
| Registration | `smart_env_config3.actions.lc_vault_graph_open = …` at the end of the section | assigned *after* the config literal (invariant 10); also fixes the search commands |
| Settings tab | `lc_vault_graph_render_settings` | called from `render_plugin_settings` between search and blocks |
| CSS | `styles.css`, `/* ===== local connections: vault graph ===== */` | `.lc-vault-graph-empty[hidden]{display:none}` is load-bearing (v1.9.1) |
| Tests | `tools/vault_graph_logic_test.js` (in `check.sh`) | k-means grouping, kNN symmetry, cluster naming, config wiring |
| Harness | `tools/harness/index.html` + `.claude/launch.json` | real bundle + real d3, fake env; see DEVELOPING.md *Testing the vault graph* |

Measured (harness, 64-dim vectors, with yields): 2,500 notes → k-means 0.85 s
(k = 35), kNN 2.0 s. Real vectors are 384-dim (768 for DenseOn), so expect
~6–12× that; kNN is O(n²·d) and is the only expensive stage.

## 2. What the embeddings actually contain (read before tuning anything)

`source_get_embed_input_markdown` (~line 7067) builds a note's embedding text as

    "Folder > Subfolder > Note title:\n" + content

cut to `max_tokens × 3.7` characters (~1,900 chars for every built-in model,
all 512 tokens), and the worker then truncates to `max_tokens` tokens. Two
consequences that shape everything the graph shows:

- **A long note is represented by its first ~1,200–1,500 words only.**
  Blocks (`lc_embed_blocks(env)`, Settings → Embedding → *Embed blocks*) are
  the existing fix: each heading section gets its own vector.
- **The folder path is part of the text.** Notes in a folder are pulled
  toward each other by the breadcrumbs, and very short notes embed mostly
  their path. Folder names are a real tuning lever; so are exclusions.

Built-in models (`transformers_models` table ~line 12943): bge-micro-v2
(default, 384-d, mean pooling), arctic-embed-xs/s (CLS, query prefix),
multilingual-e5-small (`query: `/`passage: `), granite-97m (CLS),
**DenseOn (768-d, CLS, `query: `/`document: `, English)**. Local model files
(v1.4 feature, `lc_sync_local_transformers_models`) accept any ONNX export
with pooling/prefix set per model. The worker takes `dtype` (`'auto'` today)
and `use_gpu`; the worker source is a string literal (`transformers_v4_worker_default`).

## 3. Future work, in the order I would do it

Each item is self-contained. Bump the version, add a README changelog line,
and run `tools/check.sh` → `tools/install.sh` as usual.

### 3.1 Layout by projection instead of springs (biggest visible win)

Today distance on screen is spring equilibrium, not semantic distance. Replace
(or seed) the force layout with a 2-D projection of the vectors so that
"near on screen" means "similar".

- Cheapest honest option: **PCA to 2-D** (power iteration on the d×d
  covariance, or on the n×d matrix directly: two dominant components via
  Gram–Schmidt-deflated power iteration; ~40 lines, no library). Use it as the
  initial `x/y` of every note (scaled to ~`ring_r`), keep the hubs at the
  mean of their members, and keep the force sim with weaker charge and no
  `forceX/Y` so it only untangles overlaps. Cheap and deterministic.
- Better separation: a small **UMAP/t-SNE-lite** (e.g. a stochastic
  neighbour embedding driven by the kNN graph we already compute — `data.knn`
  is exactly the input UMAP wants). Do it in chunks with `lc_vault_ticker`
  like the other stages; 200 iterations over n·k edges is fine.
- Hook: `lc_vault_graph_mount` where nodes get their initial `x/y` (the
  `rand()` scatter around the hub). Add a settings key `layout:
  "force" | "pca" | "knn"` and a toolbar select; the mount already rebuilds on
  `apply_settings_change`.
- Keep the physics toggle (`set_pinned`) — a projected layout should probably
  start pinned.

### 3.2 Blocks as nodes / mean-of-blocks per note

- **Mean-of-blocks**: when `lc_embed_blocks(env)` is on, a note's vector for
  the graph = normalised mean of its block vectors (`env.smart_blocks.items`
  whose `source_key === note.key`) instead of the head-only source vector.
  Change only `lc_vault_graph_collect_notes`. Consider a toggle "Whole-note
  vector: source | mean of blocks".
- **Blocks as nodes**: a mode that clusters block vectors; node label =
  `heading`, hub label = nearest block's note + heading. Much bigger n (kNN
  cost!) — cap or require `neighbours = 0` above some n. Draw a thin
  same-note link between blocks of one note. `lc_collect_note_links` already
  maps blocks to their note for wikilinks.

### 3.3 Tags / aliases / frontmatter into the embedding text

Prepend `#tags` and `aliases` (from `app.metadataCache.getFileCache(file)`)
to the text in `source_get_embed_input_markdown`, before the content. This
lets Alex's own taxonomy steer the vectors. Gate it behind a setting because
it changes every embedding (needs *Reset embeddings*, Settings → Embedding).
Also worth a setting: **strip the breadcrumbs** (see §2) for vaults whose
folders are administrative rather than topical.

### 3.4 Cluster naming from keywords

At higher cluster counts the nearest-centroid note name can mislead. Add a
TF-IDF over member titles (and first heading) — top 2–3 terms as the hub
label, nearest note as the tooltip. Only `lc_vault_graph_build_clusters` and
the hub label drawing in `draw` change. Titles are already in
`note.label`; tokenise on non-letters, drop stop words, weight by 1/df across
clusters.

### 3.5 Hierarchical clusters

Two levels: k coarse hubs, each split into ~√(members) sub-hubs when zoomed
past ~1.5×. Run `lc_vault_kmeans` per cluster on its members (cheap). Draw
sub-hubs only at `transform.k ≥ 1.5` (the visualizer's original code had this
"center nodes appear when zoomed" idea; see the `expandThreshold` in the
source we adapted). Needs a second `hub_of` map and per-level spokes.

### 3.6 Precision / model settings surfaced

- A `dtype` setting (`auto | fp32 | q8`) passed to the worker's `load`
  params (`params.dtype || 'auto'` in the worker string). fp32 is cleaner for
  DenseOn at a speed cost. Setting change must re-load the model, not
  re-embed.
- Show the active model, dims and token limit in the vault graph status line
  so it's obvious which space the map is in.

### 3.7 Smaller items

- **Persist the layout** per vault (node positions keyed by note key in
  `env.settings.lc_vault_graph.positions` or a JSON in `.smart-env/`) so a
  reopen doesn't reshuffle; invalidate when the note set changes by > 10 %.
- **Select a cluster → list its notes** in a side panel with the connections
  list rows (`connections_list_item_v3` component) — quick way to act on a
  cluster.
- **Search box → semantic search**: reuse `lc_search_*` to embed the query
  and highlight the top-k notes on the map (today Find is substring on
  names).
- **Wikilink strength**: today a single blue line; weight by link count and
  draw arrows for direction if useful.
- **Mobile**: the plugin is off on mobile by default; the canvas code is
  touch-agnostic (d3 zoom/drag handle touch) but untested.
- **kNN speed**: if it ever matters, block the inner loop (compute a 64×64
  tile of dots per yield) or move it into a Worker — vectors are
  `Float32Array`s and transfer cheaply. Not needed below ~3k notes.

## 4. Gotchas specific to this feature (not in DEVELOPING.md yet)

- **Anything positioned over the canvas must be `pointer-events: none` or
  really hidden.** v1.9.0 shipped an invisible `display:flex` overlay that
  ate every click (author class rule beats UA `[hidden]`).
- **d3-zoom / d3-drag stop immediate propagation** on wheel and mousedown. A
  separate listener on the canvas for those events never fires; hook into
  the zoom handler (`event.sourceEvent` present = user gesture) and the drag
  `start` handler instead. `settled` (ends auto-fit) works that way now.
- **`View.open()` re-renders on every open.** `render_view` returns early
  when a graph already exists unless `params.reason === "refresh"`; keep that
  or the ribbon click recomputes everything.
- **Settings writes from the toolbar** go through `write()` which sets
  `view.lc_self_write` so the view's own `settings:changed` listener doesn't
  rebuild twice; the settings tab path (no flag) drives
  `apply_settings_change(path)` which redoes only the dependent stage.
- **Two builds can race** only through `build_id`; every await in the
  pipeline is followed by `is_cancelled(build_id)`. Keep that pattern when
  adding stages.
- **Harness caching**: Chromium cached `main.js` between runs once; check
  `lc_vault_graph_mount.toString()` contains your edit, or
  `fetch('main.js', {cache: 'reload'})`, before trusting a "still broken"
  probe. In the hidden Browser pane rAF and d3 timers pause — screenshots
  force frames; use synthetic `MouseEvent`/`WheelEvent` on the canvas.
- **Colours on canvas** come from computed CSS variables
  (`lc_vault_graph_theme`) because canvas can't use `var()`; the palette is
  `LC_VAULT_GRAPH_PALETTE` (Tableau 10). Fonts: `--font-interface`, falling
  back to `sans-serif` if it still contains `var(`.

## 5. Verification checklist for any change here

1. `tools/check.sh` (extend `tools/vault_graph_logic_test.js` for new pure
   functions — it runs the async pipeline under jsc's `drainMicrotasks`).
2. Harness: `cd tools/harness && /usr/bin/python3 -m http.server 8765 --bind 127.0.0.1`,
   open `?n=2500&g=12` for perf, `?n=300&g=5` for interaction; check
   `document.elementFromPoint` at the canvas centre is the canvas.
3. `tools/install.sh`, toggle the plugin, open the graph: hover a hub, click a
   hub (zoom transition), click a note (new tab), ⌘-click (clipboard),
   ⌘-hover (preview), change clusters and neighbours, refresh after an embed.
