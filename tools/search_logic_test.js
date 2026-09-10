// jsc test for the semantic search integration (v1.5.0). Loads the bundle via
// the smoke-test harness, then exercises the non-DOM parts of the search
// feature against a fake env: parameter building (filters), the synthetic
// centre item, and the real LookupList retrieval path (lookup_list_get_results
// -> pre_process -> similarity) with a stubbed embed model.
load("/Users/alex/Documents/dev/LocalConnections/tools/smoke_test.js");

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAIL: " + msg);
}
function drain() {
  if (typeof drainMicrotasks === "function") { for (var k = 0; k < 20; k++) drainMicrotasks(); return; }
  throw new Error("jsc drainMicrotasks() not available");
}

// --- fake env ------------------------------------------------------------------
var settings_store = {};
var fake_items = {};
function make_item(key, vec) {
  var item = {
    key: key,
    collection_key: "smart_sources",
    vec: vec,
    metadata: {},
    path: key,
    filter: function (f) { return CollectionItem.prototype.filter.call(this, f); },
    filter_and_score: function (params) {
      if (this.filter(params.filter) === false) return null;
      return Object.assign(similarity.call(this, params), { item: this });
    }
  };
  fake_items[key] = item;
  return item;
}
make_item("a/alpha.md", [1, 0, 0]);
make_item("a/beta.md", [0.9, 0.1, 0]);
make_item("b/gamma.md", [0, 1, 0]);
make_item("b/delta.md", [0, 0, 1]);
make_item("skip/omega.md", [1, 0.05, 0]);

var embed_calls = [];
var env = {
  settings: settings_store,
  config: { actions: { lookup_list_get_results: { action: lookup_list_get_results }, lookup_list_pre_process: { action: pre_process, pre_process: pre_process }, similarity: { action: similarity } } },
  opts: { items: {} },
  events: { emit: function () {}, on: function () { return function () {}; } },
  create_env_getter: function (obj) { obj.env = env; },
  smart_sources: {
    items: fake_items,
    embed_model: {
      is_loaded: true,
      embed: function (input) { embed_calls.push(input); return Promise.resolve({ vec: [1, 0, 0], embed_input: input.embed_input }); }
    }
  },
  smart_blocks: { items: {}, settings: { embed_blocks: true } },
  connections_lists: {
    settings: { exclude_filter: "skip/", include_filter: "", exclude_inlinks: true, exclude_outlinks: true, exclude_frontmatter_blocks: true },
    frontmatter_inclusions: [],
    frontmatter_exclusions: []
  }
};
env.lookup_lists = {
  env: env,
  item_type: LookupList,
  item_class_name: "LookupList",
  settings: {},
  results_collection_key: "smart_sources"
};
// CollectionItem resolves this.collection via env[collection_key]; LookupList.collection_key -> "lookup_lists"
assert(LookupList.collection_key === "lookup_lists", "LookupList collection key is " + LookupList.collection_key);

// --- settings defaults ------------------------------------------------------------
var s = lc_search_settings(env);
assert(s.results_collection_key === "smart_sources", "default results type is notes");
assert(s.results_limit === 10, "default limit 10");
assert(s.auto_submit === true && s.graph_follows_search === true && s.apply_filters === true, "default toggles");
assert(env.settings.lc_search === s, "settings persisted under env.settings.lc_search");

// --- params: filters applied --------------------------------------------------------
var p = lc_search_build_params(env, s, "my query");
assert(p.limit === 10 && p.results_collection_key === "smart_sources" && p.score_algo_key === "similarity", "base params");
assert(p.filter.exclude_key_includes_any && p.filter.exclude_key_includes_any.indexOf("skip/") >= 0, "exclude path filter applied: " + JSON.stringify(p.filter));
assert(Array.isArray(p.filter.exclude_key_starts_with_any) && p.filter.exclude_key_starts_with_any.length === 0, "no inlink/outlink exclusions without a centre note");
assert(!p.filter.exclude_key_ends_with_any, "frontmatter-block exclusion only for blocks");
var pb = lc_search_build_params(env, Object.assign({}, s, { results_collection_key: "smart_blocks", results_limit: "7" }), "q");
assert(pb.results_collection_key === "smart_blocks" && pb.limit === 7, "blocks + numeric limit coercion");
assert(pb.filter.exclude_key_ends_with_any && pb.filter.exclude_key_ends_with_any[0] === "---frontmatter---", "frontmatter blocks excluded for block results");
var pn = lc_search_build_params(env, Object.assign({}, s, { apply_filters: false }), "q");
assert(!pn.filter.exclude_key_includes_any, "filters off -> no path exclusions");
var pl = lc_search_build_params(env, Object.assign({}, s, { results_limit: 0 }), "q");
assert(pl.limit === 10, "limit 0 falls back to default");

// --- centre item -------------------------------------------------------------------
var c = lc_search_center_item(env, "my query", { vec: [1, 0, 0] });
assert(c.key === "lc-search://my query" && c.lc_label === "my query" && c.vec.length === 3, "centre item shape");
assert(c.collection_key === "" && c.data.connections, "centre item has no collection and empty connections state");
assert(lc_source_of(env, c) === null, "centre item resolves to no source note (no wikilink lookups)");

// --- retrieval through the real LookupList ------------------------------------------
var lookup = new env.lookup_lists.item_type(env, { key: "lc-search:test", query: "my query" });
var results;
lookup.actions.lookup_list_get_results(p).then(function (r) { results = r; }).catch(function (e) { results = e; });
// drain microtasks
drain();
if (results instanceof Error) throw results;
assert(Array.isArray(results), "results is array, got " + results);
assert(embed_calls.length === 1 && embed_calls[0].embed_input === "my query" && embed_calls[0].purpose === "query", "query embedded once with purpose=query");
var keys = results.map(function (r) { return r.item.key; });
assert(keys[0] === "a/alpha.md", "best match first, got " + keys.join(","));
assert(keys.indexOf("skip/omega.md") === -1, "excluded path filtered out: " + keys.join(","));
assert(keys.indexOf("b/delta.md") >= 0 || results.length <= 4, "orthogonal notes ranked last");
assert(results.every(function (r) { return typeof r.score === "number"; }), "every result has a numeric score");

// --- limit ---------------------------------------------------------------------------
var lookup2 = new env.lookup_lists.item_type(env, { key: "lc-search:test2", query: "q" });
var results2;
lookup2.actions.lookup_list_get_results(lc_search_build_params(env, Object.assign({}, s, { results_limit: 2 }), "q")).then(function (r) { results2 = r; });
drain();
assert(results2 && results2.length === 2, "limit honoured, got " + (results2 && results2.length));

// --- graph override -------------------------------------------------------------------
var fake_view = { env: env, lc_search_state: { results: results, center: c, query: "my query" } };
var ov = lc_search_graph_override(fake_view);
assert(ov && ov.to_item === c && ov.results === results && ov.lc_search === true && ov.lc_search_center === c, "graph override when results present");
env.settings.lc_search.graph_follows_search = false;
assert(lc_search_graph_override(fake_view) === null, "graph override off when setting disabled");
env.settings.lc_search.graph_follows_search = true;
fake_view.lc_search_state.results = [];
assert(lc_search_graph_override(fake_view) === null, "graph override off without results");

// --- command specs --------------------------------------------------------------------
assert(lc_search_focus_commands["lc-search-focus"].register_when({ plugin: { manifest: { id: "local-connections" } } }) === true, "focus command registers for this plugin");
assert(lc_search_selection_commands["lc-search-selection"].register_when({ plugin: { manifest: { id: "smart-connections" } } }) === false, "selection command not registered for other plugin ids");
assert(lc_search_sanitize("  a \n b  ") === "a b", "sanitize collapses whitespace");

print("SEARCH LOGIC TEST PASS: " + results.length + " results, order " + keys.join(" > "));
