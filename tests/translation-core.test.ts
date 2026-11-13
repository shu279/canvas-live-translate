import test from "node:test";
import assert from "node:assert/strict";
import { containsJapanese, makeBatches, parseTranslations, splitWhitespace, makeCacheKey } from "../src/translation-core.ts";

test("detects Japanese but not English or numbers", () => {
  assert.equal(containsJapanese("問題: KV Cache"), true);
  assert.equal(containsJapanese("Attention-based prototype bank"), false);
  assert.equal(containsJapanese("x_t = 3.5"), false);
});

test("keeps leading and trailing whitespace outside translated text", () => {
  assert.deepEqual(splitWhitespace("  手法\n"), { prefix: "  ", core: "手法", suffix: "\n" });
});

test("packs requests without dropping parts", () => {
  const parts = Array.from({ length: 31 }, (_, i) => ({ source: `項目${i}`, context: "" }));
  const batches = makeBatches(parts, 10, 100);
  assert.deepEqual(batches.map(batch => batch.parts.length), [10, 10, 10, 1]);
  assert.deepEqual(batches.flatMap(batch => batch.parts), parts);
});

test("does not silently accept malformed model outputs", () => {
  assert.deepEqual(parseTranslations({ translations: ["Problem", "Method"] }, 2), ["Problem", "Method"]);
  assert.throws(() => parseTranslations({ translations: ["Problem"] }, 2));
  assert.throws(() => parseTranslations({ translations: ["", "Method"] }, 2));
  assert.throws(() => parseTranslations({}, 2));
});

test("cache keys change with context, model, or glossary", async () => {
  const part = { source: "代表位置", context: "RoPEの代表位置" };
  const first = await makeCacheKey("gpt-6-luna", "English", "", part);
  assert.equal(first.length, 64);
  assert.equal(first, await makeCacheKey("gpt-6-luna", "English", "", part));
  assert.notEqual(first, await makeCacheKey("gpt-6.1-sol", "English", "", part));
  assert.notEqual(first, await makeCacheKey("gpt-6-luna", "English", "Position anchor", part));
  assert.notEqual(first, await makeCacheKey("gpt-6-luna", "English", "", { ...part, context: "別の文脈" }));
  const oldHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    JSON.stringify(["gpt-6-luna", "English", "", part.source, part.context])));
  const oldKey = Array.from(new Uint8Array(oldHash), byte => byte.toString(16).padStart(2, "0")).join("");
  assert.notEqual(first, oldKey, "v0.1 positional-output entries must not be reused");
});
