// The rules that decide a mark, on hand-made inputs: the tie rule, the registry's own matching rule for observed
// payments, the books' row matching, and the link builder. Each state the page can print has a case that makes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, tieBalance, agreedValue, STATE } from "../docs/js/chain.js";
import { matchToBindings, nextObserverCall } from "../docs/js/checks/observer.js";
import { matchRow, PAYOUT_WALLET } from "../docs/js/checks/books.js";
import { linkHref } from "../docs/js/ui.js";
import { USDC, TOKEN } from "../docs/js/codec.js";

const bal = (v) => ({ value: v });
const rule = (claim) => ({ same: (a, b) => a.value === b.value, matchesClaim: (v) => v.value === claim, blockOf: (v) => v.block ?? null, minFinal: 100 });

test("the tie rule: two operators, same answer, behind finality, equal to the claim", () => {
  assert.equal(decide({ base: { value: 5n, block: 90 }, drpc: { value: 5n, block: 90 } }, rule(5n)).state, STATE.TIED);
  assert.equal(decide({ base: { value: 5n, block: 90 }, drpc: { value: 5n, block: 90 } }, rule(6n)).state, STATE.BROKEN, "they agree, and not with the claim");
  assert.equal(decide({ base: { value: 5n, block: 101 }, drpc: { value: 5n, block: 101 } }, rule(5n)).state, STATE.PENDING, "above min(finalized)");
  const one = decide({ base: { value: 5n, block: 90 }, drpc: { notRead: "HTTP 429" } }, rule(5n));
  assert.equal(one.state, STATE.UNREAD);
  assert.equal(one.mark, "½", "one node is read once, not tied");
  const split = decide({ base: { value: 5n, block: 90 }, drpc: { value: 6n, block: 90 } }, rule(5n));
  assert.equal(split.mark, "≠", "nodes that disagree are not read, never a break");
  assert.equal(decide({ base: { notRead: "timeout" }, drpc: { notRead: "HTTP 503" } }, rule(5n)).state, STATE.UNREAD);
});

test("balances: tolerance for cents, and an agreed value only from two agreeing nodes", () => {
  assert.equal(tieBalance({ base: bal(28_810_931_619n), drpc: bal(28_810_931_619n) }, 28_810_930_000n, { tolerance: 9_999n }).state, STATE.TIED);
  assert.equal(tieBalance({ base: bal(28_810_931_619n), drpc: bal(28_810_931_619n) }, 28_800_000_000n, { tolerance: 9_999n }).state, STATE.BROKEN);
  assert.equal(agreedValue({ base: bal(1n), drpc: bal(1n) }), 1n);
  assert.equal(agreedValue({ base: bal(1n), drpc: bal(2n) }), null);
  assert.equal(agreedValue({ base: bal(1n), drpc: { notRead: "x" } }), null);
});

test("the registry's matching rule: unique listing credits it; the same pair on two listings is citizen only", () => {
  const b = (listing_id, addr, amount, token = USDC, handle = "h") => ({ listing_id, payout_address: addr, amount_atomic: String(amount), token, handle });
  const A = "0x" + "a".repeat(40);
  const B = "0x" + "b".repeat(40);
  const t = { to: A, token: USDC, value: 100_000n };
  assert.deepEqual(matchToBindings(t, [b(24, A, 100000)]).rule, "creditable");
  assert.equal(matchToBindings(t, [b(24, A, 100000)]).listing, 24);
  assert.equal(matchToBindings(t, [b(24, A, 100000), b(25, A, 100000)]).rule, "citizen-only");
  assert.equal(matchToBindings(t, [b(24, A, 250000)]).rule, "bound-other-amount");
  assert.equal(matchToBindings(t, [b(24, A, 100000, TOKEN)]).rule, "bound-other-amount", "same address and amount, another asset: not a match");
  assert.equal(matchToBindings(t, [b(24, B, 100000)]).rule, "bound-nowhere");
});

test("the observer's next question is exactly its own: 10,000 blocks from last_block + 1, capped at finality", () => {
  const c = nextObserverCall({ funder_address: "0x3853965505b92bcef5b6a20fcca65c758f76736a", last_block: 50275899 }, 51_000_000);
  assert.equal(c.method, "eth_getLogs");
  assert.equal(parseInt(c.params[0].fromBlock, 16), 50275900);
  assert.equal(parseInt(c.params[0].toBlock, 16), 50285899);
  assert.deepEqual(c.params[0].address, [USDC, TOKEN]);
  assert.equal(c.params[0].topics[1], "0x0000000000000000000000003853965505b92bcef5b6a20fcca65c758f76736a");
  const capped = nextObserverCall({ funder_address: "0x3853965505b92bcef5b6a20fcca65c758f76736a", last_block: 50275899 }, 50276000);
  assert.equal(parseInt(capped.params[0].toBlock, 16), 50276000);
});

test("the books: a row names an outflow by tx, or by amount, UTC date and destination", () => {
  const tx = "0x" + "1".repeat(64);
  const rows = [
    { id: 14, tx, amount_cents: -1000, entry_date: "2026-09-02", description: "to the payout wallet" },
    { id: 15, tx: null, amount_cents: -5540, entry_date: "2026-09-10", description: "to the payout wallet for listing 20" },
  ];
  assert.equal(matchRow({ tx, token: USDC, value: 10_000_000n, to: PAYOUT_WALLET }, rows)?.row.id, 14);
  const t2 = { tx: "0x" + "2".repeat(64), token: USDC, value: 55_400_000n, to: PAYOUT_WALLET, time: new Date("2026-09-10T12:00:00Z") };
  assert.equal(matchRow(t2, rows)?.how, "amount-date-destination");
  assert.equal(matchRow({ ...t2, time: new Date("2026-09-11T12:00:00Z") }, rows), null, "another day is another row");
  assert.equal(matchRow({ ...t2, to: "0x" + "c".repeat(40) }, rows), null, "another destination is another row");
});

test("links: only validated parts become an href; everything else stays inert text", () => {
  assert.equal(linkHref("route", "#/a/2")?.href, "#/a/2");
  for (const bad of ["javascript:alert(1)", "#/a/<x>", "https://evil.example", "#/a b", "//evil.example"]) assert.equal(linkHref("route", bad), null, bad);
  assert.equal(linkHref("citizen", "popek1990")?.href, "https://1f916.ai/api/citizen/popek1990");
  for (const bad of ["../keys", "..", ".", "a/b", "a b", "", "x".repeat(65), "evil?x=1"]) assert.equal(linkHref("citizen", bad), null, bad);
  assert.equal(linkHref("tx", "0x" + "ab".repeat(32))?.href, "https://base.blockscout.com/tx/0x" + "ab".repeat(32));
  assert.equal(linkHref("tx", "0x1234"), null);
  assert.equal(linkHref("address", "0x" + "A".repeat(40))?.href, "https://base.blockscout.com/address/0x" + "a".repeat(40));
  assert.equal(linkHref("api", "/api/listings/23")?.href, "https://1f916.ai/api/listings/23");
  for (const bad of ["//evil.example/api/x", "/api/../../x y", "/api/../admin", "https://1f916.ai/api/x", "/admin"]) assert.equal(linkHref("api", bad), null, bad);
  assert.equal(linkHref("nope", "#/a"), null);
  assert.equal(linkHref("route", 5), null);
});
