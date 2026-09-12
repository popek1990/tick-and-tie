// The rules that decide a mark, on hand-made inputs: the tie rule, the registry's own matching rule for observed
// payments, the books' row matching, and the link builder. Each state the page can print has a case that makes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, finalizedHead, tieBalance, agreedValue, STATE } from "../docs/js/chain.js";
import { footingF } from "../docs/js/lines.js";
import { summary } from "../docs/js/run.js";
import { classifyTransfer, nextObserverCall, catchUp, cycleMinutesOf, scheduleC } from "../docs/js/checks/observer.js";
import { matchRow, onchainCentsLine, PAYOUT_WALLET, scheduleD } from "../docs/js/checks/books.js";
import { censusOf, censusHeadline } from "../docs/js/checks/census.js";
import { foldExhibits } from "../docs/js/checks/forgeries.js";
import { firstWitnessed } from "../docs/js/checks/receipts.js";
import { scheduleF } from "../docs/js/checks/clocks.js";
import { linkHref, saysKind, el } from "../docs/js/ui.js";
import { USDC, TOKEN, ranges, readError } from "../docs/js/codec.js";

const bal = (v) => ({ value: v });
const rule = (claim) => ({ same: (a, b) => a.value === b.value, matchesClaim: (v) => v.value === claim, blockOf: (v) => v.block ?? null, finalHead: 100 });

test("the tie rule: two operators, same answer, behind finality, equal to the claim", () => {
  assert.equal(decide({ base: { value: 5n, block: 90 }, drpc: { value: 5n, block: 90 } }, rule(5n)).state, STATE.TIED);
  assert.equal(decide({ base: { value: 5n, block: 90 }, drpc: { value: 5n, block: 90 } }, rule(6n)).state, STATE.BROKEN, "they agree, and not with the claim");
  assert.equal(decide({ base: { value: 5n, block: 101 }, drpc: { value: 5n, block: 101 } }, rule(5n)).state, STATE.PENDING, "above the finalized head");
  const one = decide({ base: { value: 5n, block: 90 }, drpc: { notRead: "HTTP 429" } }, rule(5n));
  assert.equal(one.state, STATE.UNREAD);
  assert.equal(one.mark, "½", "one node is read once, not tied");
  const split = decide({ base: { value: 5n, block: 90 }, drpc: { value: 6n, block: 90 } }, rule(5n));
  assert.equal(split.mark, "≠", "nodes that disagree are not read, never a break");
  assert.equal(decide({ base: { notRead: "timeout" }, drpc: { notRead: "HTTP 503" } }, rule(5n)).state, STATE.UNREAD);
});

test("the finalized head: two operators, so one node lying in either direction cannot move it", () => {
  const per = {
    base: { number: 51_200_000 },
    tenderly: { number: 51_199_990 },
    drpc: { number: 51_199_995 },
    publicnode: { number: 51_300_000 }, // refuses archive reads, so it does not vote on the head
  };
  assert.equal(finalizedHead(per).finalHead, 51_199_995, "the highest block two archive operators call final");
  assert.deepEqual(finalizedHead(per).problems, [], "a few blocks apart is jitter, not worth a word");

  const behind = finalizedHead({ ...per, drpc: { number: 50_199_995 } });
  assert.equal(behind.finalHead, 51_199_990, "a node a million blocks behind does not drag the reading backwards");
  assert.match(behind.problems[0] ?? "", /disagree about Base's finalized head by 1,000,005 blocks/);
  assert.match(behind.problems[0] ?? "", /base\.drpc\.org says 50,199,995/);

  const ahead = finalizedHead({ ...per, drpc: { number: 52_200_000 } });
  assert.equal(ahead.finalHead, 51_200_000, "and a node running ahead cannot pull a younger block into a tick");
  assert.equal(ahead.problems.length, 1);

  assert.equal(finalizedHead({ base: { number: 100 }, tenderly: { number: 90 } }).finalHead, 90, "two voices: the lower, as before");
  assert.equal(finalizedHead({ base: { number: 100 } }).finalHead, 100, "one archive voice stands alone; decide() still refuses the tick");
  assert.equal(finalizedHead({ publicnode: { number: 100 }, base: { notRead: "HTTP 429" } }).finalHead, null, "no archive answer is no head");
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

test("C: a stretch of Base that was not read is never printed as 'no payment'", async () => {
  const wallet = "0x" + "1".repeat(40);
  const rail = { observer: { marks: [{ funder_address: wallet, last_block: 50_000_000 }], walk_note: "one funder wallet per five-minute cycle" }, listings: [] };
  // No finalized head was read, so the wallet was never walked: an empty result means "not read", not "nothing".
  const [l] = await scheduleC({ docs: { rail }, finalHead: null, readAt: "test" });
  const said = l.sentence.join("");
  assert.match(said, /did not read that stretch of Base, so it cannot say what moved there/);
  assert.doesNotMatch(said, /no payment/, "absence is only absence when the walk happened");
  assert.equal(l.state, STATE.UNREAD, l.why);
  assert.notEqual(l.mark, "✓");
});

test("the census says 'at least' and names what it missed when the citizen list was read in part", () => {
  const whole = { total: 2415, read: 2415, complete: true, eventsComplete: true, handed: 74, routed: 51, receipted: 9, paidUnseen: 7, unseenCitizens: 14, notReadWhy: null };
  const s1 = censusHeadline(whole);
  assert.match(s1, /^Of 2,415 citizens, 74 handed in work and 51 filed a payout route; 9 hold a receipt/);
  assert.doesNotMatch(s1, /at least/, "a complete read needs no hedge");

  // A later page of GET /api/citizens was refused (the registry's 429 arrives without CORS headers). censusOf()
  // counts only the citizens it actually read, so every count is a lower bound and the sentence has to say so.
  const part = { ...whole, read: 1000, complete: false, handed: 36, routed: 22, receipted: 6, paidUnseen: 6, notReadWhy: "Failed to fetch" };
  const s2 = censusHeadline(part);
  assert.match(s2, /1,000 were read on this visit, so these counts are lower bounds/);
  assert.match(s2, /at least 36 handed in work and at least 22 filed a payout route; at least 6 hold a receipt/);
  assert.match(s2, /at least 6 of them hold no receipt at all/);
  assert.match(s2, /The other 1,415 were not read: no answer this browser may read/);
  assert.doesNotMatch(s2, /citizens, 36 handed/, "a count over half the list is never stated as a whole number");

  // An event list read in part hedges the two counts that come from events, and nothing else.
  const ev = censusHeadline({ ...whole, eventsComplete: false });
  assert.match(ev, /at least 74 handed in work and at least 51 filed a payout route; 9 hold a receipt/);
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

test("a clock whose listing did not answer stays on the page as not read, from the rail's own figures", async () => {
  const listing = (id, due) => ({ listing_id: id, asset: { chain_id: 8453, token: USDC }, award_states: { payable: 1 }, economics: { outstanding_awarded_atomic: due, currently_due_atomic: due, overdue_unpaid_atomic: "0" } });
  const rail = { now: 1789000000000, listings: [listing(28, "100000"), { ...listing(29, "0"), award_states: { paid: 1 } }] };
  const ctx = { docs: { rail }, readAt: "test", finalHead: 100, listingDetail: async () => ({ ok: false, status: 0, error: "Failed to fetch" }) };
  const lines = await scheduleF(ctx);
  assert.equal(lines.length, 1, "listing 29 owes nothing, so it has no clock");
  const [l] = lines;
  assert.equal(l.ref, "F-28");
  assert.equal(l.state, STATE.UNREAD);
  assert.match(l.sentence.join(""), /0\.10 USDC is owed on listing 28 \(1 payable\)/);
  assert.match(l.why, /^not read: GET \/api\/listings\/28: .*HTTP 429 without CORS headers/);
});

test("F: a listing whose own amounts do not parse stays on the page, and is not counted as a clock", async () => {
  const listing = (id, due) => ({ listing_id: id, asset: { chain_id: 8453, token: USDC }, award_states: { payable: 1 }, economics: { outstanding_awarded_atomic: due, currently_due_atomic: due, overdue_unpaid_atomic: "0" } });
  // "12.5" is not an atomic integer: parseAtomic returns null. Rounding that down to zero would drop the listing.
  const rail = { now: 1789000000000, listings: [listing(31, "12.5"), { ...listing(32, "0"), award_states: { paid: 1 } }] };
  const ctx = { docs: { rail }, readAt: "test", finalHead: 100, listingDetail: async () => ({ ok: false, status: 0, error: "Failed to fetch" }) };
  const lines = await scheduleF(ctx);
  assert.equal(lines.length, 1, "listing 32 owes nothing; listing 31's unreadable figure keeps it here");
  assert.equal(lines[0].ref, "F-31");
  assert.equal(lines[0].state, STATE.UNREAD);
  assert.match(lines[0].sentence.join(""), /an amount this page could not read is owed/);
  assert.doesNotMatch(lines[0].sentence.join(""), /0\.00 USDC/, "a figure that does not parse is never printed as zero");
});

test("D: without the committed baseline the books say not read, and D-5 stays on the page", async () => {
  const treasury = { entries: [], onchain_cents: null, onchain_checked_at: null, assets: {} };
  const ctx = { docs: { treasury, checkpoint: { checkpoints: [] } }, baseline: null, finalHead: 51_200_000, headRef: null, readAt: "test", registryKey: null };
  const lines = await scheduleD(ctx);
  const d4 = lines.find((l) => l.ref === "D-4");
  const d5 = lines.find((l) => l.ref === "D-5");
  assert.ok(d4, "D-4 is on the page");
  assert.equal(d4.state, STATE.UNREAD, "no baseline is not an empty list of outflows");
  assert.notEqual(d4.mark, "—");
  assert.match(d4.sentence.join(""), /were not read on this visit/);
  assert.doesNotMatch(d4.sentence.join(""), /^0 out/, "never a count of zero");
  assert.ok(d5, "D-5 does not vanish when it cannot be computed");
  assert.equal(d5.state, STATE.UNREAD);
  assert.match(d5.why, /not read: data\/baseline\.json did not load/);
});

test("F's bar counts clocks and not-read lines apart, in one place for page and terminal", () => {
  const l = (state) => ({ state });
  assert.deepEqual(footingF([l(STATE.UNREAD), l("clock"), l("clock")]), { clocks: 2, unread: 1 });
  assert.deepEqual(footingF([l("clock")]), { clocks: 1, unread: 0 });
  assert.deepEqual(footingF([]), { clocks: 0, unread: 0 });
});

test("a fetch failure becomes the same words everywhere", () => {
  for (const raw of ["Failed to fetch", "fetch failed", "TypeError: Failed to fetch", "NetworkError when attempting to fetch resource."]) {
    assert.match(readError(raw), /HTTP 429 without CORS headers/, raw);
  }
  assert.equal(readError("HTTP 500"), "HTTP 500", "a status the browser did show is passed through");
  assert.equal(readError(null), "not read");
});

test("el() refuses every attribute that would load or style from a value", () => {
  const had = "document" in globalThis;
  globalThis.document = { createElement: () => ({ setAttribute() {}, append() {}, className: "", textContent: "" }) };
  try {
    for (const k of ["src", "srcset", "style", "formaction", "action", "poster", "background"]) {
      assert.throws(() => el("img", { [k]: "https://evil.example/x" }), /not settable/, k);
    }
    assert.throws(() => el("a", { href: "#/a" }), /safeLink/);
    assert.throws(() => el("div", { onclick: "x" }), /no inline handlers/);
    assert.doesNotThrow(() => el("div", { class: "x", text: "y", title: "z" }));
  } finally {
    if (!had) delete globalThis.document;
  }
});

test("the status line never reports controls that did not run as controls that passed", () => {
  const base = { ctx: { readAt: "2026-09-12 09:00:00Z" }, results: { controls: [], controlsSkipped: [] }, problems: [] };
  assert.match(summary(base), /controls: none ran on this read/);
  assert.doesNotMatch(summary(base), /0\/0 as they must/, "a skipped self-test must never read as a passed one");
  const partial = { ...base, results: { controls: [{ pass: true }, { pass: true }], controlsSkipped: ["the witness consistency proof (3): not read"] } };
  const s = summary(partial);
  assert.match(s, /controls: 2\/2 as they must/);
  assert.match(s, /1 group did not run/, "a group whose inputs were not read is named, not silently dropped");
});
