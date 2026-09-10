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
