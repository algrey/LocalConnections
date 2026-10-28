// Vault data compaction: vector files of models that are not installed are
// removed, references to them (and to already-missing files) are stripped from
// the note records, stale collection folders holding only .ajson records go,
// and everything in use is kept. In-memory fake vault adapter; no Obsidian.
load("/Users/alex/Documents/dev/LocalConnections/tools/smoke_test.js");
var console = { log: function () {}, warn: function () {}, error: function () {} };
var setTimeout = function (fn) { fn(); return 1; };
function assert(v, m) { if (!v) throw new Error("VAULT COMPACT TEST FAIL: " + m); }
var ARCTIC = "Snowflake/snowflake-arctic-embed-xs";
var arctic_fp = lc_model_fingerprint_for_key({ settings: {} }, ARCTIC);
assert(arctic_fp === "mf_in00wz", "bundled fingerprint matches the vault's file name, got " + arctic_fp);

// fake vault: paths → contents; folders implied
var files = {
  ".smart-env/smart_env.json": "{}",
  ".smart-env/smart_sources/smart_sources.ajson": "",
  ".smart-env/smart_sources/mf_in00wz": "cur",
  ".smart-env/smart_sources/mf_keep01": "installed model",
  ".smart-env/smart_sources/mf_old001": "orphan",
  ".smart-env/smart_sources/mf_old002": "orphan",
  ".smart-env/smart_sources/notes.txt": "not a vector file",
  ".smart-env/event_logs/event_logs.ajson": "",
  ".smart-env/smart_contexts/.keep": "",
  ".smart-env/other_thing/data.bin": "",
  ".smart-env/embedding_models/embedding_models.ajson": ""
};
var removed = [], rmdirs = [];
var adapter = {
  exists: async function (p) { return Object.keys(files).some(function (k) { return k === p || k.indexOf(p + "/") === 0; }); },
  list: async function (dir) {
    var out = { files: [], folders: [] };
    Object.keys(files).forEach(function (k) {
      if (k.indexOf(dir + "/") !== 0) return;
      var rest = k.slice(dir.length + 1);
      if (rest.indexOf("/") === -1) out.files.push(k);
      else { var f = dir + "/" + rest.split("/")[0]; if (out.folders.indexOf(f) === -1) out.folders.push(f); }
    });
    return out;
  },
  remove: async function (p) { delete files[p]; removed.push(p); },
  rmdir: async function (p) { Object.keys(files).forEach(function (k) { if (k.indexOf(p + "/") === 0) delete files[k]; }); rmdirs.push(p); }
};
lc_vault_adapter = function () { return adapter; };
// registry: one installed folder whose fingerprint we pin to mf_keep01
var registry = { "my-model": { dims: 384, max_tokens: 512, pooling: "mean" } };
var real_fp = lc_model_fingerprint_for_key;
lc_model_fingerprint_for_key = function (env, key) { return key === "lc-local/my-model" ? "mf_keep01" : real_fp(env, key); };
function item(key, refs, history) {
  var it = { key: key, saved: 0, data: { embedding: { history: history || [], default: refs } } };
  it.queue_save = function () { it.saved++; };
  return it;
}
var a = item("a", { mf_in00wz: { file: "mf_in00wz", file_i: 0, read_hash: "h" }, mf_old001: { file: "mf_old001", file_i: 0, read_hash: "h" } });
var b = item("b", { mf_old002: { file: "mf_old002", file_i: 1, read_hash: "h" }, mf_gone00: { file: "mf_gone00", file_i: 3, read_hash: "h" } }, [{ file: "mf_old001", file_i: 9 }, { file: "mf_in00wz", file_i: 1 }]);
var c = item("c", { mf_keep01: { file: "mf_keep01", file_i: 2, read_hash: "h" } });
var saves = 0;
var env = {
  state: "loaded",
  data_fs_path: ".smart-env",
  settings: { lc_local_models: registry },
  config: { collections: { smart_sources: {}, smart_blocks: {}, embedding_models: { data_dir: "embedding_models" } } },
  embedding_models: { default: { data: { model_key: ARCTIC } } },
  smart_sources: { data_dir: "smart_sources", embeddings: { data_dir: "smart_sources", active_file: "mf_in00wz" }, items: { a: a, b: b, c: c }, process_save_queue: async function () { saves++; } },
  smart_blocks: { data_dir: "smart_sources", embeddings: { data_dir: "smart_sources", active_file: "mf_in00wz" }, items: {} }
};
var finished = false;
lc_compact_vault_data(env).then(function (summary) {
  assert(removed.indexOf(".smart-env/smart_sources/mf_old001") !== -1 && removed.indexOf(".smart-env/smart_sources/mf_old002") !== -1, "orphan vector files removed: " + JSON.stringify(removed));
  assert(files[".smart-env/smart_sources/mf_in00wz"] && files[".smart-env/smart_sources/mf_keep01"], "current and installed-model files kept");
  assert(files[".smart-env/smart_sources/notes.txt"] && files[".smart-env/smart_sources/smart_sources.ajson"], "non-vector files untouched");
  assert(!a.data.embedding.default.mf_old001 && a.data.embedding.default.mf_in00wz, "ref to removed file stripped, current kept");
  assert(!b.data.embedding.default, "record with only dead refs loses the whole ref map");
  assert(b.data.embedding.history.length === 1 && b.data.embedding.history[0].file === "mf_in00wz", "history entries for dead files stripped");
  assert(c.data.embedding.default.mf_keep01 && c.saved === 0, "untouched record not re-saved");
  assert(a.saved === 1 && b.saved === 1 && saves === 1, "changed records queued and saved once");
  assert(summary.cleared_refs === 4, "cleared refs counted, got " + summary.cleared_refs);
  assert(rmdirs.indexOf(".smart-env/event_logs") !== -1, "stale record folder removed");
  assert(rmdirs.indexOf(".smart-env/smart_contexts") === -1, "folder with non-record files kept: " + JSON.stringify(rmdirs));
  assert(rmdirs.indexOf(".smart-env/other_thing") === -1, "folder with binary data kept");
  assert(files[".smart-env/embedding_models/embedding_models.ajson"], "live collection folder kept");
  // second pass is a no-op
  removed = []; rmdirs = [];
  return lc_compact_vault_data(env);
}).then(function (summary) {
  assert(!removed.length && !rmdirs.length && summary.cleared_refs === 0, "second pass changes nothing");
  // scheduling runs once per env and only when loaded
  var runs = 0; var real = lc_compact_vault_data; lc_compact_vault_data = async function () { runs++; return {}; };
  lc_schedule_vault_compaction(env); lc_schedule_vault_compaction(env);
  assert(runs === 1, "scheduled once per env, got " + runs);
  var env2 = { state: "loading" }; lc_schedule_vault_compaction(env2);
  assert(runs === 1, "not run while the env is still loading");
  lc_compact_vault_data = real;
  finished = true;
  print("vault compact test ok");
}).catch(function (e) { print(e.stack || String(e)); throw e; });
