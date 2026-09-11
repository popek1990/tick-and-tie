// Units, symbols and hidden characters: the traps this society has already fallen into (see codec.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAsset, formatUnits, parseAtomic, parseWord, foldSymbol, counterfeitOf, reveal, isLookalike, fromSec, fromMs, USDC, TOKEN, WETH } from "../docs/js/codec.js";

test("amounts: exact, per asset, truncation marked, no silent rounding", () => {
  assert.equal(formatAsset(5_000_000n, USDC), "5.00 USDC");
  assert.equal(formatAsset(100_000n, USDC), "0.10 USDC");
  assert.equal(formatAsset(28_810_931_619n, USDC), "28,810.931619 USDC");
  assert.equal(formatAsset(0n, USDC), "0.00 USDC");
  assert.equal(formatAsset(30_000_000n * 10n ** 18n, TOKEN), "30,000,000 1F916");
  assert.equal(formatAsset(5_149_935_337_111_295_622_736_931_288n, TOKEN), "5,149,935,337.111295… 1F916");
  assert.equal(formatAsset(1n, TOKEN), "0.000000… 1F916");
  assert.equal(formatAsset(10n ** 18n, WETH), "1 WETH");
  assert.equal(formatAsset(5n, "0x0000000000000000000000000000000000000001"), null, "an unknown asset is never formatted");
  assert.equal(formatAsset(5, USDC), null, "a Number is refused: amounts are BigInt");
  assert.equal(formatUnits(-1_500_000n, 6), "-1.500000");
});

test("strict parsing: decimal strings and 32-byte words only", () => {
  assert.equal(parseAtomic("30000000000000000000000000"), 30_000_000n * 10n ** 18n);
  for (const bad of ["1e6", "-1", " 1", "0x10", "", "1.5", null, undefined, 1.5, -1]) assert.equal(parseAtomic(bad), null, String(bad));
  assert.equal(parseWord("0x" + "0".repeat(63) + "1"), 1n);
  assert.equal(parseWord("0x"), null, "an empty eth_call result is not read, never zero");
  assert.equal(parseWord("0x01"), null);
});

test("clocks: seconds and milliseconds are typed, not guessed", () => {
  assert.equal(fromSec(1789603140).toISOString(), "2026-09-16T23:59:00.000Z");
  assert.equal(fromSec(1789603140000), null, "milliseconds passed as seconds are refused");
  assert.equal(fromMs(1789603140000).toISOString(), "2026-09-16T23:59:00.000Z");
  assert.equal(fromMs(1789603140), null, "seconds passed as milliseconds are refused");
});

test("counterfeit symbols fold to the real ones; the real token never counts as its own counterfeit", () => {
  const fake = "0x5409000000000000000000000000000000000000";
  for (const s of ["ÚSDС", "U​S︀D͏C", "ＵＳＤＣ", "UႽD‬C", "usdc"]) assert.equal(counterfeitOf(fake, s), "USDC", JSON.stringify(s));
  assert.equal(counterfeitOf(fake, "WΕTH"), "WETH");
  assert.equal(counterfeitOf(fake, "USDT"), null);
  assert.equal(counterfeitOf(USDC, "USDC"), null, "canonical is decided by address, never by name");
  assert.equal(foldSymbol("ÚSDС"), "USDC");
});

test("reveal: hidden characters always shown; in strict mode every non-ASCII character is shown", () => {
  assert.deepEqual(reveal("a‮b"), [{ text: "a" }, { hidden: "U+202E RIGHT-TO-LEFT OVERRIDE" }, { text: "b" }]);
  assert.deepEqual(reveal("ÚSDС"), [{ text: "ÚSDС" }], "ordinary letters pass in prose");
  assert.deepEqual(reveal("ÚSDС", 32, { strict: true }), [{ hidden: "U+00DA LATIN CAPITAL LETTER U WITH ACUTE" }, { text: "SD" }, { hidden: "U+0421 CYRILLIC CAPITAL LETTER ES" }]);
  assert.deepEqual(reveal("abcdef", 3), [{ text: "abc" }, { note: "… truncated, 3 more characters" }]);
});

test("lookalikes: a real poisoning pair, and an address is never its own lookalike", () => {
  assert.equal(isLookalike("0x4B010DeaCd6aA30D6674b0624ad5aAD935B44D28", "0x4b086F5Df2a15394a3b2FD83Db90764F25134d28"), true);
  assert.equal(isLookalike("0x4B010DeaCd6aA30D6674b0624ad5aAD935B44D28", "0x4b010deacd6aa30d6674b0624ad5aad935b44d28"), false);
  assert.equal(isLookalike("0x4B010DeaCd6aA30D6674b0624ad5aAD935B44D28", "0x9999999999999999999999999999999999999999"), false);
});
