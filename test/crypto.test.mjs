// Vectors are real: the checkpoint, proofs, receipts and books below were read from the registry on
// 2026-09-11 and are frozen in test/fixtures. Every positive check has a negative twin, because a check
// that could not have failed is not a check (#4613).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keccakHex, selectorOf, topicOf } from "../docs/js/keccak.js";
import {
  sha256Hex, rowHash, eventFields, leafHash, mth, bytesToHex, verifyInclusion, verifyConsistency,
  ed25519Verify, verifyCheckpoint, verifyEvent, verifyLedgerRoot, jwkThumbprint,
} from "../docs/js/crypto.js";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const checkpoint = fx("checkpoint.json");
const KEY = checkpoint.registry_public_key.x;
const cpOf = (log) => checkpoint.checkpoints.find((c) => c.log === log);

test("keccak-256 vectors, including the 136-byte rate boundary", () => {
  assert.equal(keccakHex(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccakHex("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.ok(keccakHex("a".repeat(135)).startsWith("34367dc2"));
  assert.ok(keccakHex("a".repeat(136)).startsWith("a6c4d403"));
  assert.ok(keccakHex("a".repeat(137)).startsWith("d869f639"));
});

test("selectors and topics derive from full signatures", () => {
  assert.equal(selectorOf("balanceOf(address)"), "0x70a08231");
  assert.equal(selectorOf("totalSupply()"), "0x18160ddd");
  assert.equal(selectorOf("decimals()"), "0x313ce567");
  assert.equal(selectorOf("symbol()"), "0x95d89b41");
  assert.equal(selectorOf("vestedTotalAmount()"), "0xf68d90d8");
  assert.notEqual(selectorOf("vestedTotalAmount(address)"), "0xf68d90d8");
  assert.equal(topicOf("Transfer(address,address,uint256)"), "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  // write selectors this page must never carry; computed here only to prove we know them
  assert.equal(selectorOf("transfer(address,uint256)"), "0xa9059cbb");
  assert.equal(selectorOf("approve(address,uint256)"), "0x095ea7b3");
});

test("sha256 vectors", async () => {
  assert.equal(await sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("registry checkpoints: Ed25519 signature verifies, and fails on one flipped byte", async () => {
  for (const log of ["identity_events", "ledger"]) {
    const cp = cpOf(log);
    assert.equal(await verifyCheckpoint(KEY, log, cp), true, log);
    assert.equal(await verifyCheckpoint(KEY, log, { ...cp, tree_size: cp.tree_size + 1 }), false);
    const sig = cp.sig;
    const flipped = (sig[5] === "A" ? "B" : "A");
    assert.equal(await verifyCheckpoint(KEY, log, { ...cp, sig: sig.slice(0, 5) + flipped + sig.slice(6) }), false);
  }
});

test("RFC 8032 test 1 (empty message) through WebCrypto", async () => {
  const pub = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
  const sig = "5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc-bRr0lv18FlbviRlUUFDjnoQCw";
  assert.equal(await ed25519Verify(pub, new Uint8Array(0), sig), true);
  assert.equal(await ed25519Verify(pub, new Uint8Array([0]), sig), false);
  assert.equal(await ed25519Verify(pub, new Uint8Array(0), sig.slice(0, -2)), false); // wrong length
});

test("thumbprints match the registry's", async () => {
  assert.equal(await jwkThumbprint("zl98d2fgq22xnL0EoE0PhyryQsSEhY0OU7PcWWc9Y_o"), "aHNshzoake5VHs5aJJbsx9GBNPwh-hIB_weUpka7K4k");
  assert.equal(await jwkThumbprint(KEY), "MWjyLJdwBH9OEy5erZUzHCbgW_SjWr0RmuDOGbA-ZuQ");
});

test("payout-receipt events rehash from their own fields", async () => {
  const ev = fx("events-payout-receipt.json").events;
  assert.equal(ev.length, 8);
  for (const e of ev) assert.equal(await rowHash(e.prev_hash, eventFields(e)), e.hash, `event ${e.id}`);
  const e = ev[0];
  assert.notEqual(await rowHash(e.prev_hash, eventFields({ ...e, detail: e.detail + " " })), e.hash);
});

test("receipt event 6045: inclusion + signature, and the tree-size trap", async () => {
  const ev = fx("events-payout-receipt.json").events.find((e) => e.id === 6045);
  const proof = fx("proof-6045.json");
  const r = await verifyEvent(KEY, ev, proof);
  assert.deepEqual(r.steps, { rehash: true, same_leaf: true, inclusion: true, signature: true });
  assert.equal(r.ok, true);
  // a flipped proof node fails
  const bad = { ...proof, proof: [...proof.proof] };
  bad.proof[0] = (bad.proof[0][0] === "0" ? "1" : "0") + bad.proof[0].slice(1);
  assert.equal((await verifyEvent(KEY, ev, bad)).ok, false);
  // wrong leaf index fails
  assert.equal((await verifyEvent(KEY, ev, { ...proof, event: { ...proof.event, leaf_index: proof.event.leaf_index + 1 } })).ok, false);
  // tree size ± 1: the signature step must catch what the bare fold may not
  const plus = { ...proof, checkpoint: { ...proof.checkpoint, tree_size: proof.checkpoint.tree_size + 1 } };
  assert.equal((await verifyEvent(KEY, ev, plus)).ok, false);
  assert.equal((await verifyEvent(KEY, ev, plus)).steps.signature, false);
});

test("bare RFC 6962 inclusion does not bind tree size (documents why the signature step exists)", async () => {
  // 4 leaves; leaf 0's proof is [h(l1), h(l2,l3)]. It also verifies against claimed size 3.
  const leaves = await Promise.all(["a", "b", "c", "d"].map((s) => leafHash(s.repeat(64))));
  const root = bytesToHex(await mth(leaves));
  const { nodeHash } = await import("../docs/js/crypto.js");
  const proof = [bytesToHex(leaves[1]), bytesToHex(await nodeHash(leaves[2], leaves[3]))];
  assert.equal(await verifyInclusion(0, 4, leaves[0], proof, root), true);
  assert.equal(await verifyInclusion(0, 3, leaves[0], proof, root), true);
  assert.equal(await verifyInclusion(4, 4, leaves[0], proof, root), false);
  assert.equal(await verifyInclusion(0, 4, leaves[0], proof.slice(0, 1), root), false);
});

test("consistency 6033 → 11708 verifies; tampering fails", async () => {
  const c = fx("consistency-6033-11708.json");
  const ok = await verifyConsistency(c.from.tree_size, c.to.tree_size, c.from.root, c.to.root, c.proof);
  assert.equal(ok, true);
  assert.equal(await verifyConsistency(c.from.tree_size, c.to.tree_size, c.from.root, c.to.root, c.proof.slice(1)), false);
  const badRoot = (c.from.root[0] === "0" ? "1" : "0") + c.from.root.slice(1);
  assert.equal(await verifyConsistency(c.from.tree_size, c.to.tree_size, badRoot, c.to.root, c.proof), false);
  assert.equal(await verifyConsistency(0, c.to.tree_size, c.from.root, c.to.root, c.proof), false);
  assert.equal(await verifyConsistency(5, 5, "aa", "aa", []), true);
});

test("treasury books: 11 sealed rows rehash, link and fold to the signed ledger root", async () => {
  const t = fx("treasury.json");
  const r = await verifyLedgerRoot(KEY, t.entries, cpOf("ledger"));
  assert.equal(r.steps.rows, 11);
  assert.equal(r.steps.rows_rehash, 11);
  assert.equal(r.steps.links, true);
  assert.equal(r.steps.root, true);
  assert.equal(r.steps.signature, true);
  assert.equal(r.ok, true);
  const tampered = t.entries.map((e) => (e.id === 12 ? { ...e, amount_cents: e.amount_cents + 1 } : e));
  const bad = await verifyLedgerRoot(KEY, tampered, cpOf("ledger"));
  assert.equal(bad.ok, false);
  assert.equal(bad.steps.first_bad_row, 12);
  // swapping two rows breaks the links
  const swapped = t.entries.map((e) => ({ ...e }));
  const a = swapped.find((e) => e.id === 13);
  const b = swapped.find((e) => e.id === 14);
  [a.id, b.id] = [b.id, a.id];
  assert.equal((await verifyLedgerRoot(KEY, swapped, cpOf("ledger"))).ok, false);
});
