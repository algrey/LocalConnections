// Switching the embedding model while the embed queue is running: the worker
// of the old model is unloaded, the in-flight batch rejects with "Message
// adapter unloaded", and the model-change handler restarts the queue. The run
// must stop quietly (no error notice) and every item must end up embedded with
// the new model, whether the restart lands during the old run or after it.
// Drives the real EmbeddingsVectorAdapter with a fake collection; no worker.
load("/Users/alex/Documents/dev/LocalConnections/tools/smoke_test.js");
var logs = [];
var console = { log: function () {}, warn: function () { logs.push("warn " + [].slice.call(arguments).join(" ")); }, error: function () { logs.push("error " + [].slice.call(arguments).join(" ")); } };
var setTimeout = function (fn) { Promise.resolve().then(fn); return 1; };
var clearTimeout = function () {};
function assert(v, m) { if (!v) throw new Error("EMBED SWITCH TEST FAIL: " + m); }
function tick() { return new Promise(function (r) { Promise.resolve().then(r); }); }

function scenario(name, switch_when) {
  var items = [], events = [], calls = [], mode = "A", switched = null;
  var collection;
  function make_item(i) {
    var item = { key: "note" + i, collection_key: "smart_sources", read_hash: "h" + i, data: {}, vec: null };
    item.get_embed_input = async function () { return "text " + i; };
    item.queue_save = function () {};
    Object.defineProperty(item, "collection", { get: function () { return collection; } });
    return item;
  }
  for (var i = 0; i < 10; i++) items.push(make_item(i));
  var model = {
    is_loaded: true, batch_size: 2,
    load: async function () { model.is_loaded = true; },
    embed_batch: async function (entities) {
      calls.push(mode + ":" + entities.map(function (e) { return e.key; }).join(","));
      if (mode === "A" && calls.length === 2) {
        mode = "A-dead";
        if (switch_when === "during") switched = do_switch();
        throw new Error("Message adapter unloaded");
      }
      if (mode === "A-dead") throw new Error("Message adapter unloaded");
      return entities.map(function () { return { vec: [1, 0], tokens: 1 }; });
    }
  };
  var embeddings = {
    defer_vector_saves: false,
    prepare_vector_file: async function () { return null; },
    get_active_file_info: function () { return { file: "mf_" + mode, dims: 2, value_count: 0 }; },
    has_current_vector_ref: function (item) { return Boolean(item.vec); },
    reserve_vector_capacity: async function () {},
    clear_save_timeout: function () {},
    save_dirty_files: async function () {},
    embed_batch: async function (group_items) { var r = await collection.embed_model.embed_batch(group_items); group_items.forEach(function (it, i) { it.vec = r[i].vec; }); return r; }
  };
  collection = {
    collection_key: "smart_sources", block_collection: null, embed_model_key: "modelA", embeddings: embeddings,
    _embed_queue: [], _embed_queue_ready: false,
    get embed_queue() { if (this._embed_queue_ready) return this._embed_queue; this._embed_queue = items.filter(function (it) { return !it.vec; }); this._embed_queue_ready = true; return this._embed_queue; },
    mark_embed_queue_dirty: function () { this._embed_queue_ready = false; this._embed_queue = []; },
    embed_model: model,
    process_save_queue: async function () {},
    emit_event: function (k, p) { events.push(k + (p && p.level ? "/" + p.level : "")); },
    env: { events: { emit: function (k) { events.push(k); } } }
  };
  var adapter = new EmbeddingsVectorAdapter(collection);
  async function do_switch() {
    // what handle_embedding_model_change does: wait for the interrupted run, reload vectors, restart
    collection.mark_embed_queue_dirty();
    await Promise.allSettled([adapter._process_embed_queue_promise]);
    await tick();
    mode = "B"; collection.embed_model_key = "modelB";
    collection.mark_embed_queue_dirty();
    await adapter.process_embed_queue();
  }
  return (async function () {
    await adapter.process_embed_queue();
    if (switch_when === "after") switched = do_switch();
    await switched;
    for (var j = 0; j < 20; j++) await tick();
    var embedded = items.filter(function (it) { return it.vec; }).length;
    assert(embedded === 10, name + ": all items embedded after the switch, got " + embedded);
    assert(!events.some(function (e) { return e.indexOf("/error") !== -1; }), name + ": no error notice for the interrupted run, events " + JSON.stringify(events));
    assert(calls.every(function (c, i) { return i < 2 ? c.indexOf("A:") === 0 : c.indexOf("B:") === 0; }), name + ": remaining batches use the new model, calls " + JSON.stringify(calls));
    assert(!adapter.is_queue_halted && !adapter._embed_run_error && !adapter._process_embed_queue_promise, name + ": adapter idle and clean");
    assert(!logs.some(function (l) { return l.indexOf("error") === 0; }), name + ": nothing logged as an error, logs " + JSON.stringify(logs));
  })();
}
var finished = false;
scenario("switch during run", "during").then(function () { return scenario("switch after halt", "after"); }).then(function () { finished = true; print("embed switch test ok"); }).catch(function (e) { print(e.stack || String(e)); throw e; });
