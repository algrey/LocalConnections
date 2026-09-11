// Security/privacy boundaries and graph lifecycle, using synthetic data only.
load("/Users/alex/Documents/dev/LocalConnections/tools/smoke_test.js");
var console = { log: function () {}, warn: function () {}, error: function () {} };
var setTimeout = function () { return 1; };
var clearTimeout = function () {};
var setInterval = function () { return 1; };
var clearInterval = function () {};
function assert(value, message) {
  if (!value) throw new Error("REVIEW TEST FAIL: " + message);
}

var finished = false;
var failure = null;
(async function () {
  var payload = '<img src="https://invalid.example/pixel" onerror="alert(1)">';
  var html = build_html7({ display_name: payload, data: { provider_key: payload, model_key: payload } }, {});
  assert(!html.includes(payload) && html.includes("&lt;img"), "model metadata is escaped");

  // The fallback is settings-controlled, independently of the validated request.
  var paths = [];
  var env = {
    plugin: { manifest: { dir: ".obsidian/plugins/local-connections" }, app: { vault: { adapter: {
      exists: async function (path) { paths.push(path); return !path.endsWith("model.onnx_data"); },
      readBinary: async function (path) { paths.push(path); return new ArrayBuffer(4); }
    } } } },
    settings: { lc_local_models: { demo: { onnx_files: [] } } }
  };
  var entry = env.settings.lc_local_models.demo;
  for (var bad of ["../../../private.onnx", "..\\..\\private.onnx", "/tmp/private.onnx", "%2e%2e%2fprivate.onnx", 42, null]) {
    entry.onnx_files = [bad];
    paths.length = 0;
    assert(await lc_read_local_model_file(env, "demo/onnx/model.onnx_data") === null, "reject unsafe fallback " + bad);
    assert(paths.length === 1, "unsafe fallback never reaches the filesystem");
  }
  entry.onnx_files = ["model_q8.onnx"];
  assert(lc_resolve_onnx_fallback(entry, "onnx/model.onnx_data") === "onnx/model_q8.onnx_data", "external data suffix preserved");
  assert(lc_resolve_onnx_fallback(entry, "onnx/model.onnx.data") === "onnx/model_q8.onnx.data", "dot data suffix preserved");
  assert((await lc_read_local_model_file(env, "demo/onnx/model.onnx_data")).byteLength === 4, "valid fallback reads model data");

  var read = false;
  try {
    await lc_read_json_file({ size: 1024 * 1024 + 1, text: async function () { read = true; return "{}"; } });
    assert(false, "oversized metadata rejected");
  } catch (error) { assert(error.message.includes("1 MB"), "size error"); }
  assert(!read, "size checked before reading");
  for (var raw of ["null", "[]", "42", '"text"']) {
    try {
      await lc_read_json_file({ size: raw.length, text: async function () { return raw; } });
      assert(false, "non-object metadata rejected");
    } catch (error) { assert(error.message.includes("JSON object"), "shape error"); }
  }
  assert((await lc_read_json_file({ size: 17, text: async function () { return '{"hidden_size":384}'; } })).hidden_size === 384, "valid model config");

  var warnings = [];
  var old_warn = console.warn;
  console.warn = function () { warnings.push(Array.from(arguments)); };
  try {
    for (var content of [null, { secret: payload }]) {
      assert(await SmartSource.prototype.search.call({ collection: {}, read: async function () { return content; } }, { keywords: ["note"] }) === 0, "invalid search content returns no matches");
    }
    assert(!JSON.stringify(warnings).includes(payload), "invalid content not logged");
  } finally { console.warn = old_warn; }

  var old_create = document.createElement;
  var created = 0;
  document.createElement = function () {
    created++;
    var template = { innerHTML: "" };
    template.content = { cloneNode: function () { return template.innerHTML; } };
    return template;
  };
  try {
    var target = { replaceChildren: function (value) { this.value = value; } };
    replace_html(target, "<b>cached</b>");
    replace_html(target, "<b>cached</b>");
    assert(created === 1 && target.value === "<b>cached</b>", "small repeated markup cached");
    for (var i = 0; i < 128; i++) replace_html(target, "<b>" + i + "</b>");
    var before = created;
    replace_html(target, "<b>cached</b>");
    assert(created === before + 1, "old markup evicted");
    var large = "x".repeat(16385);
    before = created;
    replace_html(target, large);
    replace_html(target, large);
    assert(created === before + 2, "large markup not retained");
  } finally { document.createElement = old_create; }

  // A pending retrieval must not revive the simulation after removal.
  var resume;
  var pending = new Promise(function (resolve) { resume = resolve; });
  var view = { updateConnections: function () { return pending; } };
  var update = LC_VISUALIZER.ScGraphItemView.prototype.updateVisualization.call(view);
  view.lc_disposed = true;
  resume();
  await update; // Would access absent graph state without the cancellation guard.
  var stopped = 0;
  var simulation_view = { simulation: { stop: function () { stopped++; } }, simulationTickHandler: function () {}, avoidLabelCollisions: function () {} };
  try {
    LC_VISUALIZER.ScGraphItemView.prototype.initializeSimulation.call(simulation_view, 300, 300);
    assert(stopped === 1, "reinitializing stops the previous simulation");
  } finally { simulation_view.simulation.stop(); }

  var original_view = LC_VISUALIZER.ScGraphItemView;
  var original_frame = window.requestAnimationFrame;
  var frames = [], disposers = [], starts = 0, stops = 0;
  LC_VISUALIZER.ScGraphItemView = function () {
    this.initializeVariables = function () { starts++; };
    this.setupSettingsMenu = this.setupSVG = this.addEventListeners = function () {};
    this.updateVisualization = async function () {};
    this.simulation = { stop: function () { stops++; } };
  };
  window.requestAnimationFrame = function (callback) { frames.push(callback); };
  try {
    var renderer = {
      create_doc_fragment: function () { return { firstElementChild: {
        isConnected: true, clientWidth: 300, clientHeight: 300,
        createEl: function () { return { addEventListener: function () {} }; }
      } }; },
      attach_disposer: function (container, dispose) { disposers.push(dispose); }
    };
    var list = { env: env, item: { key: "synthetic.md", vec: [1, 0] } };
    await lc_render_visualizer_graph.call(renderer, list);
    var first = list._lc_visualizer_view;
    await lc_render_visualizer_graph.call(renderer, list);
    var second = list._lc_visualizer_view;
    assert(first.lc_disposed && stops === 1, "replacement disposes previous graph");
    frames.forEach(function (callback) { callback(); });
    assert(starts === 1, "superseded scheduled render does not start");
    disposers[0]();
    assert(list._lc_visualizer_view === second, "old cleanup preserves current graph");
    disposers[1]();
    assert(second.lc_disposed && list._lc_visualizer_view === null && stops === 3, "removal stops and releases current graph");
  } finally {
    LC_VISUALIZER.ScGraphItemView = original_view;
    window.requestAnimationFrame = original_frame;
  }
  finished = true;
})().catch(function (error) { failure = error; });
if (typeof drainMicrotasks === "function") drainMicrotasks();
if (failure) throw failure;
assert(finished, "async checks completed");
print("REVIEW TEST PASS");
