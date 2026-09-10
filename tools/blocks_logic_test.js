// jsc test for "blocks on demand" (v1.5.2): the effective embed_blocks helper
// and the gated block parser, against fake env/source objects.
load("/Users/alex/Documents/dev/LocalConnections/tools/smoke_test.js");

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAIL: " + msg);
}

// --- lc_embed_blocks -------------------------------------------------------------
function env_with(settings) { return { settings: settings }; }
assert(lc_embed_blocks(env_with({})) === false, "nothing configured -> no blocks");
assert(lc_embed_blocks(env_with({ smart_blocks: { embed_blocks: true } })) === false, "toggle on but both consumers on notes -> no blocks");
assert(lc_embed_blocks(env_with({ smart_blocks: { embed_blocks: true }, connections_lists: { results_collection_key: "smart_sources" }, lc_search: { results_collection_key: "smart_sources" } })) === false, "explicit notes/notes -> no blocks");
assert(lc_embed_blocks(env_with({ smart_blocks: { embed_blocks: true }, connections_lists: { results_collection_key: "smart_blocks" } })) === true, "connections on blocks -> blocks");
assert(lc_embed_blocks(env_with({ smart_blocks: { embed_blocks: true }, lc_search: { results_collection_key: "smart_blocks" } })) === true, "search on blocks -> blocks");
assert(lc_embed_blocks(env_with({ lc_search: { results_collection_key: "smart_blocks" } })) === true, "toggle absent (upstream default true) + search on blocks -> blocks");
assert(lc_embed_blocks(env_with({ smart_blocks: { embed_blocks: false }, lc_search: { results_collection_key: "smart_blocks" } })) === false, "toggle off forbids blocks even when a consumer wants them");
assert(lc_embed_blocks(undefined) === false, "no env -> false");

// --- parse_blocks gating ------------------------------------------------------------
var saved = [];
function FakeBlock(env, data) {
  this.env = env; this.data = data || {}; this.key = this.data.key; this.lines = this.data.lines; this.size = this.data.size;
  this.deleted = false; this._queue_embed = false;
}
FakeBlock.prototype.queue_save = function () { saved.push(this.key); };
FakeBlock.prototype.queue_embed = function () { this._queue_embed = true; };
function make_source(env) {
  var store = {};
  var src = {
    env: env,
    key: "note.md",
    data: { blocks_data: {} },
    block_collection: {
      item_type: FakeBlock,
      get: function (k) { return store[k]; },
      set: function (b) { store[b.key] = b; }
    },
    get blocks() { return Object.keys(this.data.blocks_data || {}).map(function (sk) { return store["note.md" + sk]; }).filter(Boolean); },
    replace_blocks: function (obj) {
      var next = {};
      for (var sk in obj) next[sk] = { key: "note.md" + sk, lines: obj[sk] };
      this.data.blocks_data = next;
    },
    queue_save: function () { saved.push("source"); },
    _store: store
  };
  return src;
}
var content = "# Alpha\n\nfirst paragraph of the note with some text\n\n## Beta\n\nsecond section text here\n";

// blocks mode: parser creates blocks
var env_blocks = env_with({ smart_blocks: { embed_blocks: true }, lc_search: { results_collection_key: "smart_blocks" } });
var s1 = make_source(env_blocks);
parse_blocks(s1, content);
var created = Object.keys(s1._store);
assert(created.length >= 2, "blocks mode creates block items, got " + created.length + ": " + created.join(","));
assert(Object.keys(s1.data.blocks_data).length === created.length, "blocks_data mirrors created blocks");
assert(s1.blocks.every(function (b) { return b._queue_embed === true; }), "new blocks queued for embedding");

// notes mode on the same note: existing blocks are purged, nothing created
saved = [];
var env_notes = env_with({ smart_blocks: { embed_blocks: true }, lc_search: { results_collection_key: "smart_sources" } });
s1.env = env_notes;
var before = s1.blocks.slice();
parse_blocks(s1, content);
assert(before.length >= 2 && before.every(function (b) { return b.deleted === true; }), "notes mode marks existing blocks deleted");
assert(Object.keys(s1.data.blocks_data).length === 0, "notes mode leaves empty blocks_data");
assert(saved.indexOf("source") >= 0, "source queued for save (task/code ranges + empty blocks)");
assert(Array.isArray(s1.data.task_lines) && s1.data.codeblock_ranges !== undefined, "task lines and code-block ranges still recorded");

// fresh note in notes mode: no blocks at all
var s2 = make_source(env_notes);
parse_blocks(s2, content);
assert(Object.keys(s2._store).length === 0, "notes mode creates no block items on a fresh note");

// --- listener wiring -----------------------------------------------------------------
var events = {};
var fake_env = { settings: { smart_blocks: { embed_blocks: true }, lc_search: { results_collection_key: "smart_sources" } }, events: { on: function (k, cb) { events[k] = cb; } }, smart_sources: { items: { "a.md": { key: "a.md" }, "b.md": { key: "b.md" } }, queued: [], queue_source_re_import: function (s) { this.queued.push(s.key); }, run_re_import: function () { this.ran = true; return Promise.resolve(); } } };
var plugin = { env: fake_env };
lc_blocks_register_listener(plugin);
assert(typeof events["settings:changed"] === "function", "listener registered");
events["settings:changed"]({ path_string: "connections_lists.results_limit" });
assert(fake_env.smart_sources.queued.length === 0, "unrelated setting change does nothing");
fake_env.settings.lc_search.results_collection_key = "smart_blocks";
events["settings:changed"]({ path_string: "lc_search.results_collection_key" });
assert(fake_env.smart_sources.queued.length === 2 && fake_env.smart_sources.ran === true, "switching to blocks re-imports every note");
events["settings:changed"]({ path_string: "lc_search.results_collection_key" });
assert(fake_env.smart_sources.queued.length === 2, "no duplicate re-import when the effective value did not change");
lc_blocks_register_listener(plugin);
assert(plugin._lc_blocks_listening === true, "listener registered once");

print("BLOCKS LOGIC TEST PASS");
