// Settings tab model logic: one embedding configuration is kept and re-pointed
// by "Use", the model list covers the bundled model, every installed folder and
// a selected-but-missing model, and the intro describes the product. No DOM,
// vault or worker.
load("/Users/alex/Documents/dev/LocalConnections/tools/smoke_test.js");
var console = { log: function () {}, warn: function () {}, error: function () {} };
function assert(value, message) { if (!value) throw new Error("SETTINGS MODELS TEST FAIL: " + message); }
var BUNDLED = "Snowflake/snowflake-arctic-embed-xs";

function make_config(key, model_key) {
  var item = { key: key, deleted: false, data: { provider_key: "transformers", model_key: model_key }, changed: [], saved: 0 };
  item.settings = item.data;
  item.model_changed = function (k, v) { item.changed.push(v); item.data[k] = v; };
  item.debounce_save = function () { item.saved++; };
  item.delete = function () { item.deleted = true; };
  return item;
}
function make_env(configs, default_key, registry) {
  var models = {
    collection_key: "embedding_models",
    settings: { default_model_key: default_key },
    items: configs,
    saves: 0,
    filter: function (fn) { return this.items.filter(fn); },
    new_model: function (data) { var c = make_config("transformers#new", data.model_key || BUNDLED); this.items.push(c); return c; },
    process_save_queue: function () { this.saves++; }
  };
  Object.defineProperty(models, "default", { get: function () { var k = this.settings.default_model_key; return this.items.find(function (m) { return m.key === k && !m.deleted; }) || null; } });
  return { settings: { lc_local_models: registry || {} }, embedding_models: models };
}

// 1. prune keeps only the default configuration
var a = make_config("transformers#a", "lc-local/downloaded-TaylorAI-bge-micro-v2-2");
var b = make_config("transformers#b", BUNDLED);
var env = make_env([a, b], "transformers#b", {
  "downloaded-TaylorAI-bge-micro-v2": { name: "TaylorAI/bge-micro-v2", storage_dir: "downloaded-models", source_model_key: "TaylorAI/bge-micro-v2", dims: 384, max_tokens: 512, pooling: "mean", bytes: 18355750 },
  "downloaded-TaylorAI-bge-micro-v2-2": { name: "TaylorAI/bge-micro-v2", storage_dir: "downloaded-models", source_model_key: "TaylorAI/bge-micro-v2", dims: 384, max_tokens: 512, pooling: "mean", bytes: 18355750 }
});
assert(lc_prune_embedding_configs(env) === 1, "one extra configuration pruned");
assert(a.deleted && !b.deleted, "the non-default configuration was deleted");
assert(env.embedding_models.saves === 1, "save queue processed after pruning");
assert(lc_prune_embedding_configs(env) === 0, "nothing to prune the second time");

// 2. rows: bundled first (current), then installed folders
var rows = lc_model_rows(env);
assert(rows.length === 3, "bundled + two installed rows, got " + rows.length);
assert(rows[0].kind === "bundled" && rows[0].current, "bundled model is current and listed first");
assert(rows[1].kind === "local" && rows[2].kind === "local", "installed models follow");
assert(rows[1].details.indexOf("folder: downloaded-TaylorAI-bge-micro-v2") !== -1, "details name the folder");
assert(rows[1].details.indexOf("downloaded") !== -1, "details say it was downloaded");
assert(rows[1].editable && !rows[0].editable, "only installed folders have an editable profile");
assert(rows[0].profile.pooling === "cls", "bundled profile comes from the model table");

// 3. Use re-points the single configuration; no new configuration is created
lc_use_model_key(env, "lc-local/downloaded-TaylorAI-bge-micro-v2");
assert(env.embedding_models.items.length === 2, "no configuration added by Use");
assert(b.data.model_key === "lc-local/downloaded-TaylorAI-bge-micro-v2", "default configuration re-pointed");
assert(b.changed[0] === "lc-local/downloaded-TaylorAI-bge-micro-v2" && b.saved === 1, "model_changed + save called");
rows = lc_model_rows(env);
assert(rows[0].kind === "local" && rows[0].folder === "downloaded-TaylorAI-bge-micro-v2" && rows[0].current, "installed model is now current and first");
assert(!rows.some(function (r) { return r.kind === "bundled" && r.current; }), "bundled model no longer current");
assert(rows.filter(function (r) { return r.current; }).length === 1, "exactly one current row");
// lc_use_local_model is the same path
lc_use_local_model(env, "downloaded-TaylorAI-bge-micro-v2-2");
assert(b.data.model_key === "lc-local/downloaded-TaylorAI-bge-micro-v2-2", "lc_use_local_model re-points the configuration");

// 4. a public key resolves to its downloaded folder
lc_use_model_key(env, "TaylorAI/bge-micro-v2");
rows = lc_model_rows(env);
var current = rows.filter(function (r) { return r.current; });
assert(current.length === 1 && current[0].kind === "local" && current[0].folder === "downloaded-TaylorAI-bge-micro-v2", "public key shown as the downloaded folder that serves it");

// 5. a selected model with no files is flagged
var env2 = make_env([make_config("transformers#c", "Xenova/multilingual-e5-small")], "transformers#c", {});
rows = lc_model_rows(env2);
assert(rows.length === 2, "bundled + missing rows");
assert(rows[0].kind === "missing" && rows[0].current && rows[0].missing && !rows[0].editable, "missing model row is current, flagged, read-only");
assert(rows[0].name === "Multilingual E5 Small" || rows[0].name.indexOf("e5") !== -1, "missing row uses the model's display name, got " + rows[0].name);
assert(rows[1].kind === "bundled" && !rows[1].current, "bundled row follows, not current");

// 6. no configuration at all: one is created and re-pointed
var env3 = make_env([], undefined, {});
lc_use_model_key(env3, BUNDLED);
assert(env3.embedding_models.items.length === 1 && env3.embedding_models.settings.default_model_key === "transformers#new", "configuration created when none exists");

// 7. settings intro
var texts = [];
lc_render_settings_intro({ createDiv: function () { return { createEl: function (tag, o) { texts.push(o.text); return {}; } }; } });
assert(texts[0] === "Local Connections", "intro title");
["runs on this computer", "mobile", "side panel", "graph", "list", "search", "link", "cursor", "vault graph", "colour-coded"].forEach(function (needle) {
  assert(texts[1].toLowerCase().indexOf(needle) !== -1, "intro mentions " + needle);
});
print("settings models test ok");
