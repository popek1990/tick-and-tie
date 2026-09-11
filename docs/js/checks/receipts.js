// Schedule A · RECEIPTS: everyone ever paid on this rail, tied on both ledgers.
//
// For each payout-receipt event in the society's log:
//   1. the event row rehashes from its own fields, and a Merkle proof places it under a checkpoint the registry
//      key signed (the society's ledger);
//   2. the event commits to a receipt payload hash; that hash recomputes from the receipt's own fields, which name
//      the tx, the log index, the payee, the amount and the token (the link between the two ledgers);
//   3. that transfer is read on Base at two nodes run by different operators, below finality (the other ledger).
// Only when all three hold is the line tied and sealed.

import { registry } from "../net.js";
import { sha256Hex, verifyEvent } from "../crypto.js";
import { receiptsAt, tieTransfer, STATE } from "../chain.js";
import { parseAtomic, formatAsset, lc, isTxHash, fromMs, isoMin } from "../codec.js";
import { line } from "../lines.js";

/** "binding=150, docket=listing-20, receipt payload sha256=945a…, base tx=0xc2ca…:429" → fields, or null. */
export function parseReceiptDetail(detail) {
  const m = /^binding=(\d+), docket=(listing-\d+), receipt payload sha256=([0-9a-f]{64}), base tx=(0x[0-9a-f]{64}):(\d+)$/.exec(String(detail));
  if (!m) return null;
  return { binding: Number(m[1]), docket: m[2], payloadHash: m[3], tx: m[4], logIndex: Number(m[5]) };
}

/** Recompute a payload_hash from its recipe: sha256 of a compact JSON array of payload[field] for each field. */
export async function recipeHash(payload, recipe) {
  if (!payload || !Array.isArray(recipe?.fields)) return null;
  return sha256Hex(JSON.stringify(recipe.fields.map((k) => payload[k])));
}

/**
 * Pure part of schedule A for one receipt: given the event, its proof, the binding record and receipts read at
 * the nodes, produce the line. Exported so tests and window.tickTie can feed it corrupted copies.
 */
export async function receiptLine({ event, proof, binding, receipts, minFinal, registryKey, readAt }) {
  const d = parseReceiptDetail(event.detail);
  const r = binding?.receipt ?? null;
  const logSteps = [];
  const notVerified = [
    "who controls the paying or the paid address: nothing on chain says",
    "which submission this paid for: the rail records who was paid, never which submission (the registry says so)",
    "the paying wallet's signed statement (funder_signature, EIP-191): not checked in this browser",
    "that the two nodes are independent: assumed",
  ];
  if (!d) {
    return line({ ref: `A-${event.id}`, schedule: "A", state: STATE.UNREAD, why: "the event detail did not parse", title: `event ${event.id}`, notVerified });
  }

  // 1. the society's ledger
  const ev = await verifyEvent(registryKey, event, proof);
  logSteps.push({ label: `event ${event.id} rehashes from its own fields`, ok: ev.steps.rehash });
  logSteps.push({ label: `Merkle proof places it at leaf ${proof?.event?.leaf_index ?? "?"} under checkpoint ${proof?.checkpoint?.id ?? "?"} (tree ${proof?.checkpoint?.tree_size ?? "?"})`, ok: ev.steps.inclusion && ev.steps.same_leaf });
  logSteps.push({ label: "the registry key signed that checkpoint over the same tree size (WebCrypto Ed25519)", ok: ev.steps.signature });

  // 2. the link: event → receipt payload → transfer
  const payloadOk = r ? (await recipeHash(r.payload, r.payload_hash_recipe)) === d.payloadHash && r.payload_hash === d.payloadHash : false;
  logSteps.push({ label: "the receipt's fields hash to the payload hash the event commits to", ok: payloadOk });
  const sameTx = r ? lc(r.tx_hash) === d.tx && Number(r.transfer_log_index) === d.logIndex : false;
  logSteps.push({ label: "the receipt names the same tx and log index as the event", ok: sameTx });

  // 3. the other ledger
  const value = parseAtomic(binding?.amount_atomic);
  const claim = {
    tx: d.tx,
    logIndex: d.logIndex,
    token: binding?.token,
    from: r?.source_address ?? null,
    to: binding?.address,
    value,
    block: r?.block_number ?? null,
    blockHash: r?.block_hash ?? null,
  };
  let tie = { state: STATE.UNREAD, mark: "?", why: "not read: the binding record did not load", perNode: {} };
  if (binding && value !== null && isTxHash(d.tx) && receipts) tie = tieTransfer(claim, receipts, minFinal);

  const sealed = ev.ok && payloadOk && sameTx;
  let state = tie.state;
  if (state === STATE.TIED && !sealed) state = STATE.UNREAD; // chain ties, but the society-log half did not
  const amount = value !== null ? formatAsset(value, binding.token) : "?";
  const handle = binding?.handle ?? event.citizen;
  const paidAt = fromMs(r?.block_timestamp ? r.block_timestamp * 1000 : null);

  const shows = [];
  for (const [node, v] of Object.entries(tie.perNode ?? {})) {
    shows.push({
      node,
      text: v.notRead
        ? v.notRead
        : v.transfer
          ? `status ${v.status} · block ${v.block} · log ${d.logIndex}: ${v.transfer.from} → ${v.transfer.to} · ${formatAsset(v.transfer.value, v.transfer.token) ?? v.transfer.value.toString() + " (not a canonical token)"}`
          : `status ${v.status} · block ${v.block} · no ERC-20 Transfer at log ${d.logIndex}`,
    });
  }

  return line({
    ref: `A-${d.binding}`,
    schedule: "A",
    state,
    mark: state === STATE.TIED ? "✓" : tie.mark,
    why: state === STATE.UNREAD && tie.state === STATE.TIED ? "Base ties, the society-log half did not verify" : tie.why,
    title: `binding ${d.binding} · ${d.docket} · ${handle}`,
    handles: [handle],
    sentence: [{ handle }, ` was paid ${amount} on ${d.docket} (${paidAt ? isoMin(paidAt) : "time not read"}).`],
    says: [
      { label: "event", value: `${event.id}: ${event.detail}`, source: "GET /api/events?kind=payout-receipt", readAt },
      { label: "binding", value: `${handle} bound ${binding?.address ?? "?"} for ${amount} on ${d.docket}`, source: `GET /api/payout-bindings/${d.binding}`, readAt },
      { label: "receipt", value: r ? `tx ${r.tx_hash} log ${r.transfer_log_index}, block ${r.block_number}, from ${r.source_address}` : "no receipt record", source: `GET /api/payout-bindings/${d.binding} → receipt`, readAt },
    ],
    shows,
    log: logSteps,
    sealed,
    notVerified,
    extra: { claim, receiptRecord: r, eventId: event.id, checkpointSize: proof?.checkpoint?.tree_size ?? null },
    cite: `A-${d.binding} ${state === STATE.TIED ? "tied" : state} · tx ${d.tx}:${d.logIndex} · event ${event.id} → checkpoint ${proof?.checkpoint?.id ?? "?"}`,
  });
}

/** Load and build schedule A. */
export async function scheduleA(ctx) {
  const events = (ctx.docs.receiptEvents?.events ?? []).slice().sort((a, b) => b.id - a.id);
  const parsed = events.map((e) => ({ e, d: parseReceiptDetail(e.detail) }));
  const bindings = {};
  const proofs = {};
  await Promise.all(
    parsed.map(async ({ e, d }) => {
      if (!d) return;
      const [b, p] = await Promise.all([registry(`/api/payout-bindings/${d.binding}`), registry(`/api/proof?log=identity_events&event=${e.id}`)]);
      if (b.ok) bindings[d.binding] = b.json;
      if (p.ok) proofs[e.id] = p.json;
    })
  );
  const txs = parsed.filter((x) => x.d).map((x) => x.d.tx);
  const receipts = txs.length ? await receiptsAt(txs) : null;
  const lines = [];
  for (const { e, d } of parsed) {
    lines.push(await receiptLine({ event: e, proof: proofs[e.id], binding: d ? bindings[d.binding] : null, receipts, minFinal: ctx.minFinal, registryKey: ctx.registryKey, readAt: ctx.readAt }));
  }
  ctx.receiptTxs = new Set(txs.map(lc));
  ctx.samples = { ...(ctx.samples ?? {}), receipts }; // kept so the controls can re-run ties on live data
  ctx.receiptLines = lines;
  return lines;
}
