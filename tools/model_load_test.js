// Embedding model load path: background load failures surface as error events,
// a dead worker is retried (with backoff) instead of failing forever, and
// "Test model" loads before embedding. No real worker, vault or network.
load("/Users/alex/Documents/dev/LocalConnections/tools/smoke_test.js");
var console = { log: function () {}, warn: function () {}, error: function () {} };
function assert(value, message) { if (!value) throw new Error("MODEL LOAD TEST FAIL: " + message); }
async function rejects(fn, message) {
  var error;
  try { await fn(); } catch (e) { error = e; }
  assert(error && error.message.includes(message), "expected '" + message + "', got '" + (error && error.message) + "'");
}

// Stub worker: answers every request synchronously according to worker_mode.
var worker_mode = "fail", workers = [];
Worker = function StubWorker() {
  var self = this;
  workers.push(this);
  this.messages = [];
  this.terminated = false;
  this.postMessage = function (msg) {
    self.messages.push(msg);
    if (worker_mode === "fail") return self.onmessage({ currentTarget: self, data: { id: msg.id, error: "Model files missing (404)" } });
    if (msg.method === "load") return self.onmessage({ currentTarget: self, data: { id: msg.id, result: { model_loaded: true, model_config_key: "wasm" }, model_config_key: "wasm" } });
    if (msg.method === "embed_batch") return self.onmessage({ currentTarget: self, data: { id: msg.id, result: msg.params.inputs.map(function () { return { vec: [1, 0], tokens: 1 }; }) } });
    if (msg.method === "count_tokens") return self.onmessage({ currentTarget: self, data: { id: msg.id, result: { tokens: 3 } } });
  };
  this.terminate = function () { self.terminated = true; };
};
lc_transformers_runtime_urls = function () { return { url: "app://runtime.js", asset_base: "app://runtime/" }; };
lc_prepare_transformers_worker_source = function () { return "// stub"; };

var events = [];
var model = {
  model_key: "TaylorAI/bge-micro-v2",
  data: {},
  env: { settings: {}, events: { emit: function (key, event) { events.push({ key: key, event: event }); } } }
};

var finished = false, failure = null;
(async function () {
  var adapter = new TransformersWorkerEmbeddingModelAdapter(model);

  // 1. Background load failure -> worker torn down, error event with the real cause.
  await adapter.load_background();
  assert(adapter.worker === null && adapter.state === "unloaded", "failed load tears the worker down");
  assert(workers.length === 1 && workers[0].terminated, "failed worker terminated");
  var load_failed = events.filter(function (e) { return e.key === "embed_model:load_failed"; });
  assert(load_failed.length === 1, "one load_failed event emitted, got " + load_failed.length);
  assert(load_failed[0].event.level === "error", "load_failed event is an error notice");
  assert(load_failed[0].event.details.includes("not installed locally"), "notice carries the install hint: " + load_failed[0].event.details);

  // 2. Same failure again within the dedupe window -> no second notice.
  await adapter.load_background();
  assert(events.filter(function (e) { return e.key === "embed_model:load_failed"; }).length === 1, "repeated identical failure deduplicated");

  // 3. Implicit use right after a failure -> real cause, no new worker (backoff).
  var before = workers.length;
  await rejects(function () { return adapter.embed_batch([{ embed_input: "x" }]); }, "not installed locally");
  assert(workers.length === before, "backoff: no worker spun up within 10s of a failure");
  await rejects(function () { return adapter.count_tokens("x"); }, "not installed locally");

  // 4. After the backoff window the model is available -> embed_batch reloads and succeeds.
  adapter._last_load_failure.at -= 60000;
  worker_mode = "ok";
  var out = await adapter.embed_batch([{ embed_input: "hello" }]);
  assert(workers.length === before + 1, "embed_batch reloaded the worker");
  assert(adapter.state === "loaded" && out.length === 1 && out[0].vec.length === 2, "embed_batch returns vectors after recovery");
  assert(adapter._last_load_failure === null, "successful load clears the failure record");

  // 5. Loaded worker is reused, not reloaded.
  var loaded_worker = adapter.worker;
  await adapter.embed_batch([{ embed_input: "again" }]);
  assert(adapter.worker === loaded_worker && workers.length === before + 1, "loaded worker reused");
  assert(loaded_worker.messages.filter(function (m) { return m.method === "load"; }).length === 1, "no duplicate load message");

  // 6. Worker crash -> next call reloads instead of throwing "worker not loaded".
  adapter._handle_worker_error({ currentTarget: adapter.worker, message: "worker crashed" });
  assert(adapter.worker === null, "crash tears the worker down");
  var count = await adapter.count_tokens("abc");
  assert(count.tokens === 3 && adapter.worker && workers.length === before + 2, "count_tokens reloaded after a crash");

  // 7. Empty batch never touches the worker.
  adapter._handle_worker_error({ currentTarget: adapter.worker, message: "worker crashed" });
  var n = workers.length;
  var empty = await adapter.embed_batch([]);
  assert(empty.length === 0 && workers.length === n, "empty batch is a no-op");

  // 8. Test model loads first, so a load error is reported as the real cause.
  var item = Object.create(EmbeddingModel.prototype);
  item.data = {}; item.debounce_save = function () {};
  var load_calls = 0;
  item._instance = {
    load: async function () { load_calls++; throw new Error("Model “x” is not installed locally."); },
    embed_batch: async function () { throw new Error("Transformers worker not loaded"); }
  };
  var result = await item.test_model();
  assert(load_calls === 1 && result.error.includes("not installed locally"), "test_model reports the load error: " + result.error);
  assert(item.data.test_passed === false, "test_passed false on load error");
  item._instance = {
    load: async function () { load_calls++; },
    embed_batch: async function (inputs) { return inputs.map(function () { return { vec: [1] }; }); }
  };
  result = await item.test_model();
  assert(load_calls === 2 && result.success === true && item.data.test_passed === true, "test_model passes after load");

  finished = true;
})().catch(function (error) { failure = error; });
if (typeof drainMicrotasks === "function") drainMicrotasks();
if (failure) throw failure;
assert(finished, "model load tests completed");
print("MODEL LOAD TEST PASS");
