// Vault graph logic: the fork's own k-means++ / nearest-neighbour code and the
// cluster grouping that feeds the canvas. Loads the bundle through the smoke
// harness (top-level `function`s are globals in jsc), then runs the async
// pipeline on synthetic vectors. jsc has no setTimeout: lc_vault_yield falls
// back to a resolved promise, and jsc drains microtasks before exiting.
load("/Users/alex/Documents/dev/LocalConnections/tools/smoke_test.js");

function assert(cond, msg) { if (!cond) throw new Error("VAULT GRAPH TEST FAIL: " + msg); }

// three well-separated directions in 8-d, with small deterministic jitter
function make_vec(base, i) {
  var v = new Array(8).fill(0);
  v[base] = 1;
  v[(base + 3) % 8] = 0.15 * ((i % 5) - 2) / 2;
  v[(base + 5) % 8] = 0.1 * ((i % 3) - 1);
  return v;
}
var raw = [];
var expected = [];
for (var i = 0; i < 30; i++) { raw.push(make_vec(i % 3 === 0 ? 0 : i % 3 === 1 ? 2 : 6, i)); expected.push(i % 3); }

var units = raw.map(function (v) { return lc_vault_unit_vec(v); });
assert(units.every(Boolean), "unit vectors");
assert(Math.abs(lc_vault_dot(units[0], units[0]) - 1) < 1e-5, "unit norm");
assert(lc_vault_unit_vec([0, 0, 0]) === null, "zero vector -> null");

assert(lc_vault_graph_auto_k(1) === 1, "auto_k(1)");
assert(lc_vault_graph_auto_k(8) === 2, "auto_k(8) = 2");
assert(lc_vault_graph_auto_k(200) === 10, "auto_k(200) = 10");
assert(lc_vault_graph_auto_k(100000) === 40, "auto_k cap");
assert(lc_vault_graph_neighbours({ neighbours: "7" }) === 5, "neighbours clamp");
assert(lc_vault_graph_neighbours({}) === 2, "neighbours default");
assert(lc_vault_graph_threshold({ link_threshold: 2 }) === 1, "threshold clamp");
assert(lc_vault_graph_note_label("a/b/Some Note.md") === "Some Note", "note label");

var done = false;
var failure = null;
(async function () {
  var ticks = 0;
  var tick = async function () { ticks++; };
  var km = await lc_vault_kmeans(units, 3, { tick: tick, seed: 7 });
  assert(km.centers.length === 3, "3 centers");
  assert(km.assign.length === 30, "assign length");
  assert(ticks > 0, "kmeans ticked");
  // every expected group maps to exactly one cluster id
  var map = {};
  for (var i = 0; i < 30; i++) {
    var e = expected[i], c = km.assign[i];
    if (map[e] === undefined) map[e] = c;
    assert(map[e] === c, "group " + e + " split across clusters at " + i);
    assert(km.sims[i] > 0.9, "member close to its centroid: " + km.sims[i]);
  }
  assert(new Set(Object.values(map)).size === 3, "groups map to distinct clusters");

  // k larger than n is clamped; k=1 works
  var one = await lc_vault_kmeans(units.slice(0, 4), 1, {});
  assert(one.centers.length === 1 && one.assign.every(function (a) { return a === 0; }), "k=1");
  var big = await lc_vault_kmeans(units.slice(0, 4), 9, {});
  assert(big.centers.length === 4, "k clamped to n");
  var none = await lc_vault_kmeans([], 3, {});
  assert(none.centers.length === 0 && none.assign.length === 0, "empty input");

  // cluster grouping + naming
  var notes = units.map(function (u, i) { return { id: "n" + i + ".md", label: "n" + i, unit: u, item: {} }; });
  var clusters = lc_vault_graph_build_clusters(notes, km);
  assert(clusters.length === 3, "3 non-empty clusters");
  var total = clusters.reduce(function (a, c) { return a + c.members.length; }, 0);
  assert(total === 30, "all notes grouped");
  clusters.forEach(function (c) {
    assert(c.center_note && c.members.indexOf(c.center_note) >= 0, "center note is a member");
    assert(c.name === c.center_note.label, "cluster named after its center note");
  });

  // nearest neighbours: each note's neighbours are in its own group
  var knn = await lc_vault_knn(units, 2, { tick: tick });
  assert(knn.length > 0 && knn.length <= 60, "knn link count " + knn.length);
  var seen = {};
  knn.forEach(function (l) {
    assert(l.source < l.target, "undirected pair ordered");
    var key = l.source + "-" + l.target;
    assert(!seen[key], "pair listed once");
    seen[key] = true;
    assert(expected[l.source] === expected[l.target], "neighbour link stays inside its group");
    assert(l.score > 0.9, "neighbour score");
  });
  var per_node = {};
  knn.forEach(function (l) { per_node[l.source] = (per_node[l.source] || 0) + 1; per_node[l.target] = (per_node[l.target] || 0) + 1; });
  for (var i = 0; i < 30; i++) assert(per_node[i] >= 2, "every note has at least its 2 neighbours: " + i);
  assert((await lc_vault_knn(units, 0, {})).length === 0, "k=0 -> no links");
  assert((await lc_vault_knn([units[0]], 2, {})).length === 0, "single note -> no links");

  // v1.10.0: settings accessors default to the original behaviour
  assert(LC_VAULT_GRAPH_DEFAULTS.layout === "force" && LC_VAULT_GRAPH_DEFAULTS.cluster_naming === "centroid", "new settings default to the original behaviour");
  assert(lc_vault_graph_layout({}) === "force" && lc_vault_graph_layout({ layout: "bogus" }) === "force", "layout default/clamp");
  assert(lc_vault_graph_layout({ layout: "pca" }) === "pca" && lc_vault_graph_layout({ layout: "knn" }) === "knn", "layout values");
  assert(lc_vault_graph_naming({}) === "centroid" && lc_vault_graph_naming({ cluster_naming: "x" }) === "centroid", "naming default/clamp");
  assert(lc_vault_graph_naming({ cluster_naming: "keywords" }) === "keywords", "naming value");
  assert(LC_VAULT_GRAPH_SETTINGS_CONFIG.layout.group === "Vault visualisation" && LC_VAULT_GRAPH_SETTINGS_CONFIG.cluster_naming.group === "Vault visualisation", "new settings sit in the Vault visualisation group");
  var layout_options = LC_VAULT_GRAPH_SETTINGS_CONFIG.layout.options_callback({});
  assert(layout_options.length === 3 && layout_options[0].value === "force", "layout dropdown options");
  assert(LC_VAULT_GRAPH_SETTINGS_CONFIG.cluster_naming.options_callback({}).length === 2, "naming dropdown options");

  // v1.10.0: PCA to 2-D separates the three groups and explains most of the variance
  var pca_ticks = 0;
  var pca = await lc_vault_pca2(units, { tick: async function () { pca_ticks++; } });
  assert(pca.x.length === 30 && pca.y.length === 30 && pca_ticks > 0, "pca shape / ticked");
  assert(pca.explained[0] >= pca.explained[1] - 0.01 && pca.explained[0] + pca.explained[1] > 0.8, "pca explains most variance: " + pca.explained);
  function group_centroids(px, py) {
    var c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var i = 0; i < 30; i++) { c[expected[i]][0] += px[i]; c[expected[i]][1] += py[i]; c[expected[i]][2]++; }
    return c.map(function (g) { return [g[0] / g[2], g[1] / g[2]]; });
  }
  function separation(px, py) {
    var cs = group_centroids(px, py);
    var within = 0;
    for (var i = 0; i < 30; i++) { var g = cs[expected[i]]; within = Math.max(within, Math.hypot(px[i] - g[0], py[i] - g[1])); }
    var between = Infinity;
    for (var a = 0; a < 3; a++) for (var b = a + 1; b < 3; b++) between = Math.min(between, Math.hypot(cs[a][0] - cs[b][0], cs[a][1] - cs[b][1]));
    return { within: within, between: between };
  }
  var sep = separation(pca.x, pca.y);
  assert(sep.between > 2 * sep.within, "pca separates the groups: " + JSON.stringify(sep));
  var mean_x = 0; for (var i = 0; i < 30; i++) mean_x += pca.x[i];
  assert(Math.abs(mean_x / 30) < 1e-4, "pca is centred");
  var pca_again = await lc_vault_pca2(units, {});
  assert(Math.abs(Math.abs(pca_again.x[3]) - Math.abs(pca.x[3])) < 1e-4, "pca is deterministic");
  var tiny = await lc_vault_pca2([units[0]], {});
  assert(tiny.x.length === 1 && tiny.x[0] === 0, "pca single vector");

  // v1.10.0: the neighbour embedding keeps the groups apart and honours the clusters' centre notes
  var edges = lc_vault_graph_embed_edges(notes, knn, clusters);
  assert(edges.length === knn.length + 30 - 3, "embed edges = knn + one spoke per non-centre member");
  assert(edges.every(function (e) { return e.weight > 0 && e.weight <= 1; }), "edge weights in (0, 1]");
  var emb_ticks = 0;
  var emb = await lc_vault_knn_embed(pca, edges, { epochs: 60, tick: async function () { emb_ticks++; } });
  assert(emb.x.length === 30 && emb_ticks === 60, "embedding shape / one tick per epoch");
  assert(Array.prototype.every.call(emb.x, Number.isFinite) && Array.prototype.every.call(emb.y, Number.isFinite), "embedding is finite");
  var sep2 = separation(emb.x, emb.y);
  assert(sep2.between > 2 * sep2.within, "embedding separates the groups: " + JSON.stringify(sep2));
  var emb_none = await lc_vault_knn_embed({ x: new Float32Array(1), y: new Float32Array(1) }, [], {});
  assert(emb_none.x.length === 1, "embedding single point");

  // v1.10.0: keyword names — TF-IDF over member titles, nearest note kept
  var titled = [
    { members: [{ label: "Cooking pasta" }, { label: "Pasta sauce recipes" }, { label: "The pasta night" }, { label: "Meeting notes" }], center_note: { label: "Cooking pasta" }, index: 0 },
    { members: [{ label: "Cycling routes" }, { label: "Cycling the coast" }, { label: "Bike repair" }, { label: "Meeting notes" }, { label: "Cycling 2024" }], center_note: { label: "Bike repair" }, index: 1 },
    { members: [{ label: "Meeting notes" }], center_note: { label: "Meeting notes" }, index: 2 }
  ];
  lc_vault_graph_name_clusters(titled, "keywords");
  assert(titled[0].keywords[0] === "pasta" && titled[0].name.indexOf("pasta") === 0, "pasta cluster named by its keyword: " + titled[0].name);
  assert(titled[1].keywords[0] === "Cycling", "cycling cluster keeps the display form: " + titled[1].name);
  assert(titled[1].keywords.indexOf("Meeting") < 0 && titled[0].keywords.indexOf("Meeting") < 0, "a term in every cluster and one title is not a keyword");
  var noisy = [
    { members: [{ label: "Meeting pasta" }, { label: "Meeting pasta sauce" }, { label: "Meeting pasta night" }, { label: "Meeting pasta again" }], center_note: { label: "Meeting pasta" }, index: 0 },
    { members: [{ label: "Meeting cycling" }, { label: "Meeting cycling coast" }, { label: "Meeting cycling hills" }, { label: "Meeting cycling again" }], center_note: { label: "Meeting cycling" }, index: 1 }
  ];
  lc_vault_graph_name_clusters(noisy, "keywords");
  assert(noisy[0].name === "pasta" && noisy[1].name === "cycling", "a term in every title of every cluster does not fill a slot: " + noisy[0].name + " / " + noisy[1].name);
  assert(titled[2].name === "Meeting notes" && titled[2].keywords.length === 0, "a term in every cluster is skipped even for a tiny cluster, which falls back to its nearest note: " + titled[2].name);
  lc_vault_graph_name_clusters(titled, "centroid");
  assert(titled[0].name === "Cooking pasta" && titled[1].name === "Bike repair" && titled[0].keywords.length === 0, "centroid naming restores the nearest-note names");
  var split = [
    { members: [{ label: "Garden pruning" }, { label: "Garden beds" }, { label: "Garden one" }, { label: "Garden two" }], center_note: { label: "Garden pruning" }, index: 0 },
    { members: [{ label: "Garden shed" }, { label: "Garden tools" }, { label: "Garden three" }, { label: "Garden four" }], center_note: { label: "Garden shed" }, index: 1 },
    { members: [{ label: "Kitchen sink" }, { label: "Kitchen table" }, { label: "Kitchen one" }, { label: "Kitchen two" }], center_note: { label: "Kitchen sink" }, index: 2 }
  ];
  lc_vault_graph_name_clusters(split, "keywords");
  assert(split[0].name === "Garden (Garden pruning)" && split[1].name === "Garden (Garden shed)", "duplicate keyword names get the nearest note: " + split[0].name + " / " + split[1].name);
  var reordered = [
    { members: [{ label: "Tax return" }, { label: "Tax return again" }, { label: "Tax one" }, { label: "Tax two" }], center_note: { label: "Tax one" }, index: 0 },
    { members: [{ label: "Return of tax" }, { label: "Return tax later" }, { label: "Return one" }, { label: "Return two" }], center_note: { label: "Return one" }, index: 1 },
    { members: [{ label: "Kitchen sink" }, { label: "Kitchen table" }, { label: "Kitchen one" }, { label: "Kitchen two" }], center_note: { label: "Kitchen sink" }, index: 2 }
  ];
  lc_vault_graph_name_clusters(reordered, "keywords");
  assert(reordered[0].name === "Tax · return (Tax one)" && reordered[1].name === "Return · tax (Return one)", "the same keywords in another order count as a duplicate: " + reordered[0].name + " / " + reordered[1].name);
  var empty_titles = [{ members: [{ label: "123" }, { label: "of the" }], center_note: { label: "123" }, index: 4 }];
  lc_vault_graph_name_clusters(empty_titles, "keywords");
  assert(empty_titles[0].name === "123", "keywords fall back to the nearest note");
  var terms = lc_vault_graph_title_terms("Alex\u2019s Über-notes 2024 on the ONNX runtime");
  assert(terms.has("alex") && terms.has("über") && terms.has("onnx") && terms.has("runtime") && !terms.has("2024") && !terms.has("the") && !terms.has("on"), "title tokeniser: " + JSON.stringify(Array.from(terms.keys())));
  assert(lc_vault_graph_build_clusters(notes, km, "keywords").every(function (c) { return c.center_note && typeof c.name === "string" && c.name.length; }), "build_clusters accepts a naming mode");

  // the ticker cancels
  var cancelled = false;
  var t = lc_vault_ticker({ is_cancelled: function () { return true; } });
  try { await t(0); } catch (e) { cancelled = String(e.message) === "cancelled"; }
  assert(cancelled, "ticker throws when cancelled");

  // registration wiring: the appended specs reached the actions config
  assert(typeof smart_env_config3.actions.lc_vault_graph_open.commands === "object", "vault graph command spec registered");
  assert(typeof smart_env_config3.actions.lc_vault_graph_open.ribbon_icons === "object", "vault graph ribbon spec registered");
  assert(typeof smart_env_config3.actions.lc_search_focus.commands === "object", "search focus command spec registered");
  assert(typeof smart_env_config3.actions.lc_search_selection.commands === "object", "search selection command spec registered");
  assert(LcVaultGraphView.view_type === "lc-vault-graph", "view type");
  done = true;
})().catch(function (e) { failure = e; });

// jsc's shell drains the microtask queue on request; the async body above is
// microtask-only (lc_vault_yield resolves immediately without setTimeout), so
// after draining it has either finished or recorded a failure.
if (typeof drainMicrotasks === "function") drainMicrotasks();
if (failure) throw failure;
assert(done, "async body did not complete");
print("VAULT GRAPH TEST PASS");
