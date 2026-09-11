#!/usr/bin/env node
// Builds docs/data/bindings.json: the payout bindings on every listing that names a funder wallet, read with
// GET /api/listings/:id from the registry, one listing every two seconds.
//
// Why: schedule C matches what left a funder wallet against the bindings on that funder's listings, by the
// registry's own rule. That needs every binding on about twenty listings, and a listing detail costs the registry
// a second or more to build; three at once were refused on 2026-09-11. So the page reads this index instead, and
// re-reads live any listing whose binding counts on GET /api/rail differ from the counts recorded here. The index
// is a list of where to look; nothing is ticked on it.
//
// Usage: node tools/build-bindings.mjs [--out docs/data/bindings.json]

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : new URL("../docs/data/bindings.json", import.meta.url).pathname;
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

const rail = await get("/api/rail");
const funded = (rail.listings ?? []).filter((l) => /^0x[0-9a-fA-F]{40}$/.test(l.funder_address ?? ""));
const listings = {};
for (const l of funded) {
  await sleep(2000);
  const d = await get(`/api/listings/${l.listing_id}`);
  if (d.bindings_has_more) console.error(`listing ${l.listing_id}: bindings are paged (has_more); the page will read it live`);
  listings[l.listing_id] = {
    listing_id: l.listing_id,
    funder_address: l.funder_address.toLowerCase(),
    rail_worker_bindings: l.worker_bindings,
    rail_verifier_bindings: l.verifier_bindings,
    bindings_total: d.bindings_total,
    bindings_has_more: d.bindings_has_more,
    bindings: (d.bindings ?? []).map((b) => ({
      id: b.id,
      handle: b.handle,
      role: b.role,
      payout_address: String(b.payout_address).toLowerCase(),
      token: String(b.token).toLowerCase(),
      chain_id: b.chain_id,
      amount_atomic: b.amount_atomic,
      expiry: b.expiry,
      created_at: b.created_at,
    })),
  };
  console.error(`listing ${l.listing_id}: ${listings[l.listing_id].bindings.length} bindings`);
}

writeFileSync(
  OUT,
  JSON.stringify({
    kind: "tick-and-tie.bindings.v1",
    built_at: new Date().toISOString(),
    built_by: "tools/build-bindings.mjs (rerun it and diff)",
    method: "GET https://1f916.ai/api/rail, then GET /api/listings/:id for every listing that names a funder wallet, one every 2 s",
    rail_read_at: rail.now ?? null,
    use: "An index of where to look. The page uses a listing's entry only while GET /api/rail still shows the same worker_bindings and verifier_bindings for it; otherwise it reads that listing live.",
    listings,
  }) + "\n"
);
console.error(`wrote ${OUT}: ${Object.keys(listings).length} listings`);
