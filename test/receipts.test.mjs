// Schedule A against the real record: 8 receipts, 8 bindings, 4 proofs, and the receipts as mainnet.base.org
// and base.drpc.org served them on 2026-09-11. Every tie is then broken on a corrupted copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { receiptLine, parseReceiptDetail, recipeHash } from "../docs/js/checks/receipts.js";
import { tieTransfer, STATE } from "../docs/js/chain.js";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const KEY = fx("checkpoint.json").registry_public_key.x;
const events = fx("events-payout-receipt.json").events;
const receipts = fx("receipts-8.json");
const MIN_FINAL = 51177956;

test("event details parse", () => {
  for (const e of events) assert.ok(parseReceiptDetail(e.detail), e.detail);
  assert.equal(parseReceiptDetail("binding=1, docket=listing-6"), null);
});

test("all 8 receipts tie at two nodes on the transfer they name", () => {
  for (const e of events) {
    const d = parseReceiptDetail(e.detail);
    const b = fx(`binding-${d.binding}.json`);
    const claim = { tx: d.tx, logIndex: d.logIndex, token: b.token, from: b.receipt.source_address, to: b.address, value: BigInt(b.amount_atomic), block: b.receipt.block_number, blockHash: b.receipt.block_hash };
    const t = tieTransfer(claim, receipts, MIN_FINAL);
    assert.equal(t.state, STATE.TIED, `binding ${d.binding}: ${t.why}`);
    // negative controls: each must stop the tick
    assert.equal(tieTransfer({ ...claim, value: claim.value + 1n }, receipts, MIN_FINAL).state, STATE.BROKEN);
    assert.equal(tieTransfer({ ...claim, token: "0x9e00fc92493451eba1c63dd3880d68b622037ba3" }, receipts, MIN_FINAL).state, STATE.BROKEN);
    assert.equal(tieTransfer({ ...claim, logIndex: claim.logIndex + 1 }, receipts, MIN_FINAL).state, STATE.BROKEN);
    assert.equal(tieTransfer(claim, receipts, claim.block - 1).state, STATE.PENDING);
    // one node only is ½, never a tie
    assert.equal(tieTransfer(claim, { base: receipts.base }, MIN_FINAL).mark, "½");
    // a node that returns nothing is "not read", never "not there"
    const half = { base: receipts.base, drpc: {} };
    assert.equal(tieTransfer(claim, half, MIN_FINAL).state, STATE.UNREAD);
  }
});

test("nodes that disagree give ≠, not a tick", () => {
  const e = events[0];
  const d = parseReceiptDetail(e.detail);
  const b = fx(`binding-${d.binding}.json`);
  const claim = { tx: d.tx, logIndex: d.logIndex, token: b.token, from: b.receipt.source_address, to: b.address, value: BigInt(b.amount_atomic) };
  const lying = structuredClone(receipts);
  const r = lying.drpc[d.tx].result;
  const log = r.logs.find((l) => Number(BigInt(l.logIndex)) === d.logIndex);
  log.data = "0x" + (BigInt(log.data) + 1n).toString(16).padStart(64, "0");
  assert.equal(tieTransfer(claim, lying, MIN_FINAL).mark, "≠");
});

test("receipt payload hashes recompute from their recipes and match the events", async () => {
  for (const e of events) {
    const d = parseReceiptDetail(e.detail);
    const b = fx(`binding-${d.binding}.json`);
    assert.equal(await recipeHash(b.receipt.payload, b.receipt.payload_hash_recipe), d.payloadHash, `binding ${d.binding}`);
  }
});

test("receipt line for binding 150 (event 6045): tied and sealed; corrupted copies are not", async () => {
  const event = events.find((e) => e.id === 6045);
  const proof = fx("proof-6045.json");
  const binding = fx("binding-150.json");
  const l = await receiptLine({ event, proof, binding, receipts, minFinal: MIN_FINAL, registryKey: KEY, readAt: "test" });
  assert.equal(l.state, STATE.TIED, l.why);
  assert.equal(l.sealed, true);
  assert.ok(l.notVerified.length >= 3);
  // the receipt's amount altered in the binding record: the payload hash no longer matches the event
  const tampered = structuredClone(binding);
  tampered.receipt.payload.amount_atomic = "5000001";
  const l2 = await receiptLine({ event, proof, binding: tampered, receipts, minFinal: MIN_FINAL, registryKey: KEY, readAt: "test" });
  assert.equal(l2.sealed, false);
  assert.notEqual(l2.state, STATE.TIED);
  // the binding's top-level amount altered: the tie follows the sealed payload, and a record that contradicts its
  // own payload is not sealed, so the line cannot tick
  const l3 = await receiptLine({ event, proof, binding: { ...binding, amount_atomic: "4000000" }, receipts, minFinal: MIN_FINAL, registryKey: KEY, readAt: "test" });
  assert.equal(l3.sealed, false);
  assert.notEqual(l3.state, STATE.TIED);
  for (const bad of [l2, l3]) assert.notEqual(bad.mark, "✓", "a line that is not sealed cannot show a tick");
});

test("a ✓ from Base never survives a society-log half that was not read", async () => {
  const event = events.find((e) => e.id === 6045);
  const binding = fx("binding-150.json");
  const args = { event, binding, receipts, minFinal: MIN_FINAL, registryKey: KEY, readAt: "test" };
  // GET /api/proof refused (the registry's rate limit arrives as a network error): Base still ties at two nodes,
  // but the society's log half was never read, so the line must say "not read" and must not tick.
  const l = await receiptLine({ ...args, proof: null });
  assert.equal(l.state, STATE.UNREAD, l.why);
  assert.equal(l.mark, "?");
  assert.notEqual(l.mark, "✓", "a line the page itself calls not read cannot show a tick");
  assert.match(l.why, /Base ties at two nodes; the society's log half was not read/);
  // The tie's own refinements must survive while the state is still the tie's: ◔ above finality, not a flat ?
  const p = await receiptLine({ ...args, proof: fx("proof-6045.json"), minFinal: 1 });
  assert.equal(p.state, STATE.PENDING);
  assert.equal(p.mark, "◔", "½, ≠ and ◔ come from the tie and must not be flattened");
});

test("event 1258 (binding 1) also seals with its own proof", async () => {
  if (!existsSync(new URL("./fixtures/proof-1258.json", import.meta.url))) return;
  const event = events.find((e) => e.id === 1258);
  const l = await receiptLine({ event, proof: fx("proof-1258.json"), binding: fx("binding-1.json"), receipts, minFinal: MIN_FINAL, registryKey: KEY, readAt: "test" });
  assert.equal(l.state, STATE.TIED, l.why);
  assert.equal(l.sealed, true);
});
