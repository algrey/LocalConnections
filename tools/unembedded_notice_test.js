load("/Users/alex/Documents/dev/LocalConnections/tools/smoke_test.js");
function assert(c, m) { if (!c) throw new Error("ASSERT FAIL: " + m); }
var env = { settings: { smart_sources: { min_chars: 200 } } };
var tiny = { env: env, size: 134, should_embed: false, vec: undefined };
var big = { env: env, size: 5000, should_embed: true, vec: new Float32Array(3) };
var pending = { env: env, size: 5000, should_embed: true, vec: undefined };
assert(lc_item_has_vec(tiny) === false && lc_item_has_vec(big) === true, "vec detection");
assert(/134 characters/.test(lc_unembedded_reason(tiny)) && /Minimum length/.test(lc_unembedded_reason(tiny)), "tiny note reason mentions size and minimum length");
assert(/no embedding yet/.test(lc_unembedded_reason(pending)), "pending note reason");
assert(/lc-unembedded-notice/.test(lc_no_results_html({ item: tiny })), "list message for tiny note");
assert(/Reset embeddings/.test(lc_no_results_html({ item: big })) && !/Clear sources data/.test(lc_no_results_html({ item: big })), "generic message points at Reset embeddings");
assert(lc_escape_html('<a href="x">&') === '&lt;a href=&quot;x&quot;&gt;&amp;', "html escaping");
print("UNEMBEDDED NOTICE TEST PASS");
// v1.5.5: minimum note length helpers
var env2 = { settings: { smart_sources: { min_chars: 200 } }, smart_sources: { items: { a: { size: 100 }, b: { size: 200 }, c: { size: 5000 }, d: { size: 10, deleted: true } } } };
assert(lc_blocks_min_length(env2) === 200, "min length read");
assert(lc_blocks_min_length({ settings: {} }) === 300, "min length default 300 when unset");
var c = lc_blocks_count_short_notes(env2, 200);
assert(c.total === 3 && c.short === 2, "short note count ignores deleted, counts <= min: " + JSON.stringify(c));
print("MIN LENGTH TEST PASS");
