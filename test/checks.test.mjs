// The rules that decide a mark, on hand-made inputs: the tie rule, the registry's own matching rule for observed
// payments, the books' row matching, and the link builder. Each state the page can print has a case that makes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, tieBalance, agreedValue, STATE } from "../docs/js/chain.js";
import { classifyTransfer, nextObserverCall, catchUp, cycleMinutesOf } from "../docs/js/checks/observer.js";
import { matchRow, onchainCentsLine, PAYOUT_WALLET } from "../docs/js/checks/books.js";
import { censusOf } from "../docs/js/checks/census.js";
import { foldExhibits } from "../docs/js/checks/forgeries.js";
import { firstWitnessed } from "../docs/js/checks/receipts.js";
import { linkHref, saysKind } from "../docs/js/ui.js";
import { USDC, TOKEN, ranges } from "../docs/js/codec.js";

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

test("classifyTransfer, as src/observer.ts: every real transfer to a bound address is a payment", () => {
  let id = 0;
  const b = (listing_id, addr, amount, token = USDC, handle = "h") => ({ id: ++id, listing_id, payout_address: addr, amount_atomic: String(amount), token, handle, created_at: 1 });
  const A = "0x" + "a".repeat(40);
  const B = "0x" + "b".repeat(40);
  const t = { to: A, token: USDC, value: 100_000n };
  const one = classifyTransfer(t, [b(24, A, 100000)]);
  assert.equal(one.kind, "payment");
  assert.equal(one.listing, 24, "exactly one listing matches address, amount and asset: it is credited");
  const two = classifyTransfer(t, [b(24, A, 100000, USDC, "first"), b(25, A, 100000, USDC, "second")]);
  assert.deepEqual([two.kind, two.listing, two.citizenOnly, two.handle], ["payment", null, true, "first"], "the same on two listings: the citizen only, named by the earliest binding");
  const other = classifyTransfer(t, [b(24, A, 250000)]);
  assert.deepEqual([other.kind, other.citizenOnly], ["payment", true], "another amount is still a payment, against the citizen only");
  assert.deepEqual([classifyTransfer(t, [b(24, A, 100000, TOKEN)]).kind, classifyTransfer(t, [b(24, A, 100000, TOKEN)]).citizenOnly], ["payment", true], "another asset: the citizen only");
  assert.equal(classifyTransfer(t, [b(24, B, 100000)]).kind, "other", "no binding at the address");
  assert.equal(classifyTransfer({ ...t, value: 0n }, [b(24, A, 100000)]).kind, "zero_value", "zero value is the poisoning pattern wherever it goes");
  assert.equal(classifyTransfer({ to: A.toUpperCase().replace("0X", "0x"), token: USDC.toUpperCase().replace("0X", "0x"), value: 100_000n }, [b(24, A, 100000)]).listing, 24, "case does not matter");
});

test("catching up: arithmetic on the walk_note, with the chain growing meanwhile", () => {
  assert.equal(cycleMinutesOf("One funder wallet per five-minute cycle, at most 10,000 Base blocks per cycle"), 5);
  assert.equal(cycleMinutesOf("something else"), null);
  const fast = catchUp(940_000, 4, 5, 10_000);
  assert.equal(fast.perTurn, 600, "4 wallets × 5 min × 60 s / 2 s");
  assert.equal(fast.cycles, 100, "940,000 / (10,000 − 600)");
  assert.equal(fast.hours, (100 * 20) / 60);
  assert.equal(catchUp(940_000, 4, 5, 2_000).cycles, Math.ceil(940_000 / 1_400));
  assert.equal(catchUp(940_000, 4, 5, 500).cycles, Infinity, "a range below the chain's growth never catches up");
  assert.equal(catchUp(0, 4, 5, 10_000), null);
  assert.equal(ranges([18, 9, 11, 14, 15, 16, 17, 24, 25]), "9, 11, 14–18, 24, 25");
});

test("the census counts citizens, each from one source", () => {
  const citizens = ["a", "b", "c", "d"].map((h, i) => ({ handle: h, citizen_id: i + 1, created_at: i }));
  const c = censusOf({
    citizens,
    submissions: [{ citizen: "a" }, { citizen: "a" }, { citizen: "b" }],
    bindings: [{ citizen: "b" }, { citizen: "c" }], // c filed a route without handing in work (a verifier)
    observerPayments: [{ handle: "c" }, { handle: "d" }],
    receiptLines: [{ state: STATE.TIED, handles: ["d"] }],
  });
  assert.equal(c.counts.handed, 2, "only citizens with a submission event, not those who only filed a route");
  assert.equal(c.counts.routed, 2);
  assert.equal(c.counts.unseenCitizens, 2);
  assert.equal(c.counts.paidUnseen, 1, "d holds a receipt, so only c is paid with no receipt at all");
  assert.equal(c.counts.receipted, 1);
});

test("D-3: a null onchain_cents is not a reading, never a zero and never a break", () => {
  const per = { base: { value: 28_810_931_619n }, tenderly: { value: 28_810_931_619n } };
  const nul = onchainCentsLine({ onchain_cents: null, onchain_checked_at: null, assets: { errors: ["USDC balanceOf did not answer"] } }, per);
  assert.equal(nul.state, STATE.BLIND);
  assert.equal(nul.shows.length, 2, "the per-node reads are in the drawer");
  const off = onchainCentsLine({ onchain_cents: 100, onchain_checked_at: 1789157675995, onchain_is_stale: false, assets: { errors: [] } }, per);
  assert.equal(off.state, STATE.UNREAD, "a difference is reported, never called a break");
  assert.match(off.says[0].value, /checked 2026-09-11 \d\d:\d\d:\d\dZ/, "an ISO time, not milliseconds");
  assert.equal(onchainCentsLine({ onchain_cents: 2_881_093, onchain_checked_at: 1789157675995, onchain_is_stale: false, assets: { errors: [] } }, per).state, STATE.TIED);
});

test("G folds into campaigns: listing 23's lookalikes first, then one line per imitated token", () => {
  const m = (fake, kind = "wallet") => ({ real: "0x" + "1".repeat(40), fake, label: kind === "l23" ? "x's route on listing 23" : "the treasury", kind, handle: kind === "l23" ? "x" : null, prefix: 4, suffix: 4 });
  const ex = [
    { kind: "counterfeit", pretends: "USDC", token: "0x" + "c".repeat(40), symbol: "ÚSDС", mimic: m("0x" + "2".repeat(40)) },
    { kind: "counterfeit", pretends: "USDC", token: "0x" + "d".repeat(40), symbol: "USDC", mimic: m("0x" + "3".repeat(40)) },
    { kind: "zero-value", token: USDC, symbol: "USDC", mimic: m("0x" + "2".repeat(40)) },
    { kind: "zero-value", token: USDC, symbol: "USDC", mimic: m("0x" + "4".repeat(40), "l23") },
  ];
  const g = foldExhibits(ex);
  assert.deepEqual(g.map((x) => x.key), ["l23", "fake-USDC", "zero"]);
  assert.equal(g.reduce((n, x) => n + x.items.length, 0), ex.length, "each exhibit is counted in one line");
});

test("the witness file: its first identity_events checkpoint; each drawer row names its speaker", () => {
  const text = ['{"at":"2026-09-11T00:00:35Z","checkpoints":[{"log":"identity_events","tree_size":11133,"root":"' + "a".repeat(64) + '","sig":"x","created_at":1}]}', '{"type":"witness-countersignature"}'].join("\n");
  assert.equal(firstWitnessed(text).cp.tree_size, 11133);
  assert.equal(firstWitnessed(text).at, "2026-09-11T00:00:35Z");
  assert.equal(firstWitnessed("not json\n{}"), null);
  assert.equal(saysKind({ source: "GET /api/rail" }), "registry");
  assert.equal(saysKind({ source: "GET base.blockscout.com /api/v2/addresses/0x…" }), "indexer");
  assert.equal(saysKind({ source: "data/baseline.json + live" }), "file");
  assert.equal(saysKind({ source: "GET raw.githubusercontent.com/1f916-ai/1f916/main/witness/2026-09-11.jsonl" }), "witness");
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
