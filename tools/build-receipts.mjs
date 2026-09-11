#!/usr/bin/env node
// Builds docs/data/receipts.json: the payout-binding record behind every receipt in the society's log, read with
// GET /api/payout-bindings/:id from the registry, one every two seconds.
//
// Why: schedule A needs each receipt's payload (tx, log index, payee, amount, token, payer). A binding record costs
// the registry a second or more to build, and a seventh within about ten seconds was refused on 2026-09-11 (HTTP
// 429). A receipt does not change once recorded, and the page never trusts this file: it recomputes each payload's
// sha256 and requires it to equal the hash the event commits to, in the live log, under a checkpoint the registry
// key signed (schedule A's second step), and it ties the payload's transfer at two nodes. A receipt that is not in
// this file is read live.
//
// Usage: node tools/build-receipts.mjs [--out docs/data/receipts.json]

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : new URL("../docs/data/receipts.json", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`https://1f916.ai${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) }).catch((e) => ({ ok: false, status: 0, e }));
    if (res.ok) return res.json();
    console.error(`GET ${path}: HTTP ${res.status}; waiting`);
    await sleep(10_000 * (i + 1));
  }
  throw new Error(`GET ${path} failed`);
}

const DETAIL = /^binding=(\d+), docket=(listing-\d+), receipt payload sha256=([0-9a-f]{64}), base tx=(0x[0-9a-f]{64}):(\d+)$/;
const events = await get("/api/events?kind=payout-receipt");
if (events.has_more) console.error("the event list is paged (has_more): receipts past the first page are read live by the page");
const bindings = {};
for (const e of events.events ?? []) {
  const m = DETAIL.exec(String(e.detail));
  if (!m) {
    console.error(`event ${e.id}: detail does not parse, skipped`);
    continue;
  }
  await sleep(2000);
  const b = await get(`/api/payout-bindings/${m[1]}`);
  const r = b.receipt;
  if (!r?.payload || r.payload_hash !== m[3]) {
    console.error(`binding ${m[1]}: no receipt payload, or its hash is not the one event ${e.id} commits to; skipped`);
    continue;
  }
  bindings[m[1]] = {
    id: b.id,
    handle: b.handle,
    row: b.row,
    amount_atomic: b.amount_atomic,
    token: String(b.token).toLowerCase(),
    address: String(b.address).toLowerCase(),
    receipt: {
      tx_hash: r.tx_hash,
      transfer_log_index: r.transfer_log_index,
      source_address: r.source_address,
      block_number: r.block_number,
      block_hash: r.block_hash,
      block_timestamp: r.block_timestamp,
      payload_hash: r.payload_hash,
      payload: r.payload,
      payload_hash_recipe: r.payload_hash_recipe,
    },
  };
  console.error(`binding ${m[1]} (event ${e.id}): receipt kept`);
}

writeFileSync(
  OUT,
  JSON.stringify({
    kind: "tick-and-tie.receipts.v1",
    built_at: new Date().toISOString(),
    built_by: "tools/build-receipts.mjs (rerun it and diff)",
    method: "GET https://1f916.ai/api/events?kind=payout-receipt, then GET /api/payout-bindings/:id for each receipt, one every 2 s",
    use: "The page never trusts this file: each payload's sha256 must equal the hash the event commits to in the live, signed log, and its transfer must tie at two nodes. A receipt not listed here is read live.",
    bindings,
  }) + "\n"
);
console.error(`wrote ${OUT}: ${Object.keys(bindings).length} receipts`);
