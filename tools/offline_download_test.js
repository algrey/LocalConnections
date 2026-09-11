// Synthetic download/install contract tests. No vault or network is used.
load("/Users/alex/Documents/dev/LocalConnections/tools/smoke_test.js");
var console = { log: function () {}, warn: function () {}, error: function () {} };
function assert(value, message) { if (!value) throw new Error("OFFLINE DOWNLOAD TEST FAIL: " + message); }
async function rejects(fn, message) {
  var error;
  try { await fn(); } catch (e) { error = e; }
  assert(error && error.message.includes(message), "expected " + message + ", got " + error?.message);
}
function ascii(text) { return Uint8Array.from(text.split(""), function (c) { return c.charCodeAt(0); }); }
TextDecoder = function () { this.decode = function (buffer) { return Array.from(new Uint8Array(buffer), function (n) { return String.fromCharCode(n); }).join(""); }; };
// JSC has no WebCrypto. Substitute only the digest primitive; the actual
// production validation must reject mismatches from this boundary.
var digest_wrong = false;
crypto = { subtle: { digest: async function () { return new Uint8Array(32).fill(digest_wrong ? 1 : 0).buffer; } } };
var model_id = "Snowflake/snowflake-arctic-embed-s", zero_hash = "0".repeat(64);
var production_catalog = LC_DOWNLOAD_MODELS;
var fixture = {
  "config.json": ascii('{"hidden_size":384}'),
  "tokenizer.json": new Uint8Array(1024 * 1024 + 17), // Valid tokenizer files can exceed 1 MB.
  "tokenizer_config.json": ascii('{}'),
  "onnx/model_quantized.onnx": new Uint8Array(8)
};
var test_spec = { name: "fixture-arctic-s", revision: "fixture-revision-123", pooling: "cls", onnx_file: "onnx/model_quantized.onnx", files: {} };
for (var rel in fixture) test_spec.files[rel] = [fixture[rel].byteLength, zero_hash];
LC_DOWNLOAD_MODELS = {}; LC_DOWNLOAD_MODELS[model_id] = test_spec;
var fetch_calls = [], read_count = 0, canceled = 0, network_mode = "normal";
fetch = async function (url, options) {
  fetch_calls.push(String(url));
  assert(options.credentials === "omit" && options.referrerPolicy === "no-referrer", "downloads omit credentials and referrer");
  var rel = String(url).split("/resolve/")[1].split("?")[0].split("/").slice(1).join("/");
  if (network_mode === "missing") return { ok: false, status: 404 };
  var data = fixture[rel], read = false;
  return { ok: true, headers: { get: function () { return network_mode === "headerless-overflow" ? null : String(data.byteLength + (network_mode === "large-header" ? 1 : 0)); } },
    arrayBuffer: async function () { throw new Error("unbounded response allocation must never be used"); },
    body: { cancel: async function () { canceled++; }, getReader: function () { return {
      read: async function () {
        read_count++;
        if (read) return { done: true }; read = true;
        var value = network_mode === "headerless-overflow" ? new Uint8Array(data.byteLength + 1) : network_mode === "truncated" ? data.slice(1) : data;
        return { done: false, value: value };
      }, cancel: async function () { canceled++; }, releaseLock: function () {}
    }; } }
  };
};
function make_adapter(options) {
  options = options || {};
  var disk = new Map(options.seed || []), writes = [], renames = [], removed = [];
  return {
    disk: disk, writes: writes, renames: renames, removed: removed,
    exists: async function (path) { return disk.has(path); },
    mkdir: async function (path) { disk.set(path, "directory"); },
    writeBinary: async function (path, data) {
      disk.set(path, data.slice(0)); writes.push(path);
      if (options.write_fail) throw new Error("write failed");
    },
    rename: async function (from, to) {
      if (options.rename_fail) throw new Error("rename failed");
      assert(!disk.has(to), "rename never overwrites existing folder");
      for (var item of Array.from(disk.entries())) {
        if (item[0] === from || item[0].startsWith(from + "/")) { disk.set(to + item[0].slice(from.length), item[1]); disk.delete(item[0]); }
      }
      renames.push({ from: from, to: to });
    },
    rmdir: async function (path) { for (var key of Array.from(disk.keys())) if (key === path || key.startsWith(path + "/")) disk.delete(key); removed.push(path); }
  };
}
function make_env(adapter, registry, active) {
  return {
    plugin: { manifest: { dir: ".obsidian/plugins/local-connections" }, app: { vault: { adapter: adapter } } },
    settings: { lc_local_models: registry || {} },
    embedding_models: { filter: function (fn) { return (active || []).filter(fn); } }
  };
}
var finished = false, failure = null;
(async function () {
  var adapter = make_adapter(), env = make_env(adapter);
  var result = await lc_download_supported_model(env, model_id);
  assert(result.bytes === Object.values(fixture).reduce(function (n, file) { return n + file.byteLength; }, 0), "all bytes installed, including large tokenizer");
  assert(fetch_calls.length === 4 && fetch_calls.every(function (url) { return url.includes("/resolve/fixture-revision-123/"); }), "every download uses pinned revision");
  var installed = env.settings.lc_local_models[result.name];
  assert(installed.source_model_key === model_id, "public model key retained");
  assert(lc_local_model_key_for_public(env, model_id) === "lc-local/" + result.name, "public selection resolves installed transport");
  var local_profile = lc_local_model_entry_to_profile(result.name, installed);
  assert(JSON.stringify(local_profile.semantic_profile) === JSON.stringify(Object.assign({ embedding_space_id: transformers_models[model_id].semantic_profile.embedding_space_id }, transformers_models[model_id].semantic_profile)), "retrieval identity, pooling and prefixes match public model");
  var edited = Object.assign({}, installed, { query_prefix: "custom: " });
  assert(lc_local_model_entry_to_profile(result.name, edited).semantic_profile.embedding_space_id !== local_profile.semantic_profile.embedding_space_id, "edited local profile gets a distinct embedding space");
  assert(installed.storage_dir === "downloaded-models" && adapter.renames.length === 1, "staged install uses isolated storage");
  assert(!Array.from(adapter.disk.keys()).some(function (key) { return key.includes(".staging-"); }), "successful install leaves no staging files");

  var changed = [], saved = 0;
  var model_items = [
    { data: { model_key: model_id }, model_changed: function () { throw new Error("public semantics must remain unchanged"); } },
    { data: { model_key: "lc-local/" + result.name }, model_changed: function (field, key) { changed.push(key); }, debounce_save: function () { saved++; } }
  ];
  env.embedding_models.filter = function (fn) { return model_items.filter(fn); };
  var original_prefix = installed.query_prefix;
  lc_update_local_model_profile(env, result.name, { query_prefix: "custom: " });
  assert(changed.length === 1 && changed[0] === "lc-local/" + result.name && saved === 1, "profile edit invalidates and saves only local-key model configuration");
  assert(transformers_models["lc-local/" + result.name].semantic_profile.embedding_space_id !== local_profile.semantic_profile.embedding_space_id, "profile edit publishes changed embedding space");
  lc_update_local_model_profile(env, result.name, { query_prefix: original_prefix });

  var dest = ".obsidian/plugins/local-connections/downloaded-models/" + result.name;
  var seed = [[dest, "directory"], [dest + "/custom.onnx", "original"]];
  for (var option of ["write_fail", "rename_fail"]) {
    var options = { seed: seed }; options[option] = true;
    adapter = make_adapter(options); env = make_env(adapter);
    await rejects(function () { return lc_download_supported_model(env, model_id); }, option === "write_fail" ? "write failed" : "rename failed");
    assert(!Object.keys(env.settings.lc_local_models).length && adapter.renames.length === 0, "failure leaves registry unchanged");
    assert(adapter.disk.get(dest + "/custom.onnx") === "original", "failure preserves existing model bytes");
    assert(!Array.from(adapter.disk.keys()).some(function (key) { return key.includes(".staging-"); }), "failure removes even partial staging writes");
  }
  adapter = make_adapter({ seed: seed }); env = make_env(adapter);
  var collision = await lc_download_supported_model(env, model_id);
  assert(collision.name !== result.name && adapter.disk.get(dest + "/custom.onnx") === "original", "unregistered folder is preserved and name suffixed");
  var registry = {}; registry[result.name] = installed;
  adapter = make_adapter(); env = make_env(adapter, registry);
  collision = await lc_download_supported_model(env, model_id);
  assert(collision.name !== result.name && registry[result.name] === installed, "registered model is preserved");

  var normal_config = fixture["config.json"];
  fixture["config.json"] = ascii("null" + " ".repeat(normal_config.byteLength - 4));
  adapter = make_adapter(); env = make_env(adapter);
  await rejects(function () { return lc_download_supported_model(env, model_id); }, "JSON object");
  assert(!adapter.writes.length, "invalid metadata writes nothing");
  fixture["config.json"] = normal_config;
  for (var mode of ["large-header", "headerless-overflow", "truncated"]) {
    network_mode = mode; read_count = 0; canceled = 0;
    await rejects(function () { return lc_fetch_allowed_model_file(model_id, test_spec.revision, "config.json"); }, "Integrity check failed");
    assert(canceled === 1, "bad response is canceled");
    if (mode === "large-header") assert(read_count === 0, "oversized header is rejected before reading body");
    if (mode === "headerless-overflow") assert(read_count === 1, "headerless response stops on first oversized chunk");
  }
  network_mode = "normal";
  digest_wrong = true; adapter = make_adapter(); env = make_env(adapter);
  await rejects(function () { return lc_download_supported_model(env, model_id); }, "Integrity check failed");
  assert(!adapter.writes.length, "checksum failure prevents installation"); digest_wrong = false;
  network_mode = "missing";
  await rejects(function () { return lc_download_supported_model(env, model_id); }, "missing"); network_mode = "normal";
  var before = fetch_calls.length;
  await rejects(function () { return lc_fetch_allowed_model_file(model_id, "main", "config.json"); }, "manifest");
  await rejects(function () { return lc_fetch_allowed_model_file(model_id, test_spec.revision, "../config.json"); }, "manifest");
  await rejects(function () { return lc_validate_download_file(model_id, "unknown", 4, zero_hash); }, "manifest");
  assert(fetch_calls.length === before, "untrusted paths/revisions never reach network");
  var old_size = test_spec.files["config.json"][0]; test_spec.files["config.json"][0] = 1024 * 1024 + 1;
  await rejects(function () { return lc_fetch_allowed_model_file(model_id, test_spec.revision, "config.json"); }, "size limit");
  test_spec.files["config.json"][0] = old_size;
  assert(fetch_calls.length === before, "oversized metadata manifest rejected before fetch");

  var active = [{ data: { model_key: model_id } }]; registry = {}; registry[result.name] = installed;
  adapter = make_adapter({ seed: seed }); env = make_env(adapter, registry, active);
  await rejects(function () { return lc_remove_local_model(env, result.name); }, "selected");
  assert(!adapter.removed.length && registry[result.name], "active public alias protected from removal");
  active[0].data.model_key = "lc-local/" + result.name;
  await rejects(function () { return lc_remove_local_model(env, result.name); }, "selected");
  active[0].deleted = true;
  await lc_remove_local_model(env, result.name);
  assert(!registry[result.name] && !adapter.disk.has(dest), "unused downloaded model can be removed");

  adapter = make_adapter(); env = make_env(adapter);
  var first = lc_download_supported_model(env, model_id);
  await rejects(function () { return lc_download_supported_model(env, model_id); }, "already in progress");
  await first;
  assert(adapter.renames.length === 1, "concurrent request installs only once");
  LC_DOWNLOAD_MODELS = production_catalog;
  finished = true;
})().catch(function (error) { failure = error; });
if (typeof drainMicrotasks === "function") drainMicrotasks();
if (failure) throw failure;
assert(finished, "download tests completed");
print("OFFLINE DOWNLOAD TEST PASS");
