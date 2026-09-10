// jsc smoke-test harness: evaluate the Local Connections bundle with stubbed
// obsidian/electron/zlib modules and verify it exports a plugin class.
var window = this;
if (typeof globalThis === "undefined") this.globalThis = this;

// Minimal DOM stubs for top-level code paths (CSS strings, doc fragments not
// created at load time, but guard anyway).
var document = {
  head: { appendChild: function () {} },
  createElement: function () { return { style: {}, setAttribute: function () {}, addEventListener: function () {} }; },
  querySelector: function () { return null; }
};
var navigator = { userAgent: "smoke-test" };
function TextEncoder() { this.encode = function (s) { return []; }; }
function TextDecoder() { this.decode = function (b) { return ""; }; }
function Worker() {}
function Blob() {}
var URL = { createObjectURL: function () { return "blob:stub"; }, revokeObjectURL: function () {} };
function MutationObserver() { this.observe = function () {}; this.disconnect = function () {}; }
function ResizeObserver() { this.observe = function () {}; this.disconnect = function () {}; }
var requestAnimationFrame = function (cb) {};
var performance = { now: function () { return 0; } };
var localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };

function make_module_stub(name) {
  // Proxy: every property access returns a constructible class that is also
  // callable, so `class X extends stub.ItemView` and `stub.requestUrl(...)` both work.
  var cache = {};
  return new Proxy(function () {}, {
    get: function (t, prop) {
      if (prop === "default") return make_module_stub(name + ".default");
      if (!(prop in cache)) {
        cache[prop] = new Proxy(function StubClass() {}, {
          get: function (t2, p2) {
            if (p2 === "prototype") return t2.prototype;
            if (p2 === Symbol.hasInstance) return undefined;
            return t2[p2] !== undefined ? t2[p2] : function () {};
          },
          set: function (t2, p2, v) { t2[p2] = v; return true; },
          construct: function (t2, args) { return {}; },
          apply: function () { return {}; }
        });
      }
      return cache[prop];
    },
    set: function (t, p, v) { t[p] = v; return true; },
    construct: function () { return {}; },
    apply: function () { return {}; }
  });
}

var module = { exports: {} };
var exports = module.exports;
function require(name) {
  return make_module_stub(name);
}

load("/Users/alex/Documents/dev/LocalConnections/local-connections/main.js");

var exported = module.exports && (module.exports.default || module.exports);
if (typeof exported !== "function") {
  throw new Error("SMOKE TEST FAIL: module.exports is " + typeof exported);
}
print("SMOKE TEST PASS: bundle evaluated fully; exported plugin class: " + (exported.name || "anonymous"));
