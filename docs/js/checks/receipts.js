// Schedule A · RECEIPTS: every receipt in the society's log, tied on both ledgers. (Payments with no receipt are
// schedule C's.)
//
// First, A-log: the log itself, checked against the checkpoint GitHub's witness recorded (witnessLine below).
// Then, for each payout-receipt event in the society's log:
//   1. the event row rehashes from its own fields, and a Merkle proof places it under a checkpoint the registry
//      key signed (the society's ledger);
//   2. the event commits to a receipt payload hash; that hash recomputes from the receipt's own fields, which name
//      the tx, the log index, the payee, the amount and the token (the link between the two ledgers);
//   3. that transfer is read on Base at two nodes run by different operators, below finality (the other ledger).
// Only when all three hold is the line tied and sealed.

import { registry, witness } from "../net.js";
import { sha256Hex, verifyEvent, verifyCheckpoint, verifyConsistency, NotSupported } from "../crypto.js";
import { receiptsAt, tieTransfer, STATE } from "../chain.js";
import { parseAtomic, formatAsset, lc, isTxHash, fromMs, isoMin, groupInt } from "../codec.js";
import { line, MARK } from "../lines.js";

/** The first checkpoint of `log` in a witness day file (JSON lines), with the time the witness recorded it. */
export function firstWitnessed(text, log = "identity_events") {
  for (const raw of String(text).split("\n")) {
    if (!raw.trim()) continue;
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    const cp = Array.isArray(row?.checkpoints) ? row.checkpoints.find((c) => c.log === log) : null;
    if (cp && Number.isSafeInteger(cp.tree_size) && /^[0-9a-f]{64}$/.test(String(cp.root))) return { cp, at: row.at ?? null };
  }
  return null;
}

/**
 * A-log · the society's log, as the public witness saw it. The registry's own GET /api/checkpoint says where to
 * look: "The witness records checkpoints at github.com/1f916-ai/1f916 under witness/ … Compare roots there before
 * believing ours." This does that: the first checkpoint the witness recorded today (UTC), then an RFC 6962
 * consistency proof from it to the checkpoint this browser was served. A registry that showed this browser a
 * different history than the one it showed the witness fails here.
 */
export async function witnessLine(ctx) {
  const cpDoc = ctx.docs.checkpoint;
  const now = (cpDoc?.checkpoints ?? []).find((c) => c.log === "identity_events");
  const base = { ref: "A-log", schedule: "A", route: "#/a/log", title: "the society's log, as GitHub's witness saw it" };
  const advice = /The witness records checkpoints[^.]*\.[^"]*?Compare roots there before believing ours\./.exec(String(cpDoc?.how_to_verify ?? ""))?.[0] ?? null;
  if (!now || !ctx.registryKey) return line({ ...base, state: STATE.UNREAD, why: "not read: GET /api/checkpoint gave no identity_events checkpoint and key" });
  const day = String(ctx.readAt).slice(0, 10);
  const yesterday = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  let got = null;
  let usedDay = day;
  for (const d of [day, yesterday]) {
    const r = await witness(d);
    got = r.ok ? firstWitnessed(r.text) : null;
    usedDay = d;
    if (got) break;
  }
  const says = [
    ...(advice ? [{ label: "the registry's own advice", value: advice, source: "GET /api/checkpoint → how_to_verify", readAt: ctx.readAt }] : []),
    { label: "served to this browser", value: `identity_events tree ${now.tree_size}, root ${now.root}, signed ${isoMin(fromMs(now.created_at))}`, source: "GET /api/checkpoint", readAt: ctx.readAt },
  ];
  if (!got) return line({ ...base, state: STATE.UNREAD, why: "not read: the witness day file did not load or had no identity_events checkpoint", says });
  const w = got.cp;
  says.push({ label: "recorded by the witness", value: `identity_events tree ${w.tree_size}, root ${w.root}, recorded ${got.at ?? "?"}`, source: `GET raw.githubusercontent.com/1f916-ai/1f916/main/witness/${usedDay}.jsonl (its first line)`, kind: "witness" });
  let steps;
  try {
    steps = { witnessedSig: await verifyCheckpoint(ctx.registryKey, "identity_events", w), servedSig: await verifyCheckpoint(ctx.registryKey, "identity_events", now) };
  } catch (e) {
    if (e instanceof NotSupported) return line({ ...base, state: STATE.UNREAD, why: "not read in this browser: no Ed25519 in WebCrypto", says });
    throw e;
  }
  if (w.tree_size > now.tree_size) {
    return line({ ...base, state: STATE.UNREAD, mark: "?", why: `the witness recorded a larger tree (${w.tree_size}) than this browser was served (${now.tree_size}): the checkpoint served here is older than the witness's`, says });
  }
  const r = await registry(`/api/checkpoint/consistency?log=identity_events&from=${w.tree_size}&to=${now.tree_size}`);
  if (!r.ok) return line({ ...base, state: STATE.UNREAD, why: `not read: GET /api/checkpoint/consistency (${r.error})`, says });
  const proof = Array.isArray(r.json.proof) ? r.json.proof : [];
  steps.fromSame = r.json.from?.root === w.root && r.json.from?.tree_size === w.tree_size;
  steps.toSame = r.json.to?.root === now.root && r.json.to?.tree_size === now.tree_size;
  steps.consistent = await verifyConsistency(w.tree_size, now.tree_size, w.root, now.root, proof);
  ctx.samples = { ...(ctx.samples ?? {}), consistency: { first: w.tree_size, second: now.tree_size, firstRoot: w.root, secondRoot: now.root, proof } };
  const ok = Object.values(steps).every((v) => v === true);
  return line({
    ...base,
    state: ok ? STATE.TIED : STATE.BROKEN,
    mark: ok ? "✓" : "✗",
    label: ok ? "checked in this browser, no chain read" : undefined,
    why: ok ? "the log served here extends the one the witness recorded, by a proof this browser checked" : "a step failed: the log served here does not provably extend the one the witness recorded (see THE SOCIETY'S LOG)",
    sealed: ok,
    sentence: [`The society's log served to this browser (tree ${groupInt(now.tree_size)}) ${ok ? "extends" : "does not provably extend"} the one GitHub's witness recorded at ${got.at ? isoMin(new Date(got.at)) : usedDay} (tree ${groupInt(w.tree_size)})${ok ? ": an RFC 6962 consistency proof verifies here. Every receipt below hangs off this log." : "."}`],
    says,
    log: [
      { label: `the registry key signed the witnessed checkpoint (tree ${w.tree_size})`, ok: steps.witnessedSig },
      { label: `the registry key signed the checkpoint served now (tree ${now.tree_size})`, ok: steps.servedSig },
      { label: "the consistency proof starts at the witnessed root and ends at the root served now", ok: steps.fromSame && steps.toSame },
      { label: `RFC 6962 consistency ${w.tree_size} → ${now.tree_size} (${proof.length} hashes) verifies in this browser`, ok: steps.consistent },
    ],
    notVerified: ["the witness's own countersignature (witness_sig): not checked here", "that GitHub serves every reader the same witness file: this reads it as GitHub serves it now", "anything the log gained after the checkpoint served now"],
    cite: `A-log ${ok ? "tied" : "BROKEN"}: identity_events ${w.tree_size} (witness ${usedDay}) → ${now.tree_size} (served ${ctx.readAt}), consistency ${steps.consistent ? "verifies" : "fails"}`,
  });
}

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
export async function receiptLine({ event, proof, binding, receipts, finalHead, registryKey, readAt }) {
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

  // 3. the other ledger. The claim is taken from the payload the log commits to, once its hash is checked, so no
  // field outside the sealed bytes decides the tie.
  const p = payloadOk ? r.payload : null;
  const value = parseAtomic(p ? p.amount_atomic : binding?.amount_atomic);
  const claim = {
    tx: d.tx,
    logIndex: d.logIndex,
    token: p ? p.token : binding?.token,
    from: (p ? p.source_address : r?.source_address) ?? null,
    to: p ? p.address : binding?.address,
    value,
    block: (p ? p.block_number : r?.block_number) ?? null,
    blockHash: (p ? p.block_hash : r?.block_hash) ?? null,
  };
  let tie = { state: STATE.UNREAD, mark: "?", why: "not read: the binding record did not load", perNode: {} };
  if (binding && value !== null && isTxHash(d.tx) && receipts) tie = tieTransfer(claim, receipts, finalHead);

  // The record's own top-level fields must say what its sealed payload says; a record that contradicts itself is
  // not sealed, whatever Base shows.
  const sameFields = p ? ["amount_atomic", "token", "address"].every((k) => lc(String(binding?.[k])) === lc(String(p[k]))) : false;
  logSteps.push({ label: "the binding's amount, token and address match its sealed payload", ok: sameFields });
  const sealed = ev.ok && payloadOk && sameTx && sameFields;
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
    // The tie's own mark carries ½ (one answer) and ≠ (nodes disagree), so keep it while the state is the tie's.
    // Once the state is demoted because the society-log half did not hold, the mark follows the state: a ✓ from
    // Base alone must never sit on a line this page calls not read.
    mark: state === tie.state ? tie.mark : MARK[state],
    why:
      state === STATE.UNREAD && tie.state === STATE.TIED
        ? `Base ties at two nodes; ${proof ? "the society-log half did not verify (see THE SOCIETY'S LOG below)" : "the society's log half was not read: its Merkle proof did not load"}`
        : tie.why,
    title: `binding ${d.binding} · ${d.docket} · ${handle}`,
    handles: [handle],
    sentence: [{ handle }, ` was paid ${amount} on ${d.docket} (${paidAt ? isoMin(paidAt) : "time not read"}).`],
    says: [
      { label: "event", value: `${event.id}: ${event.detail}`, source: "GET /api/events?kind=payout-receipt", readAt },
      ...(binding?.fromFile
        ? [
            { label: "binding", value: `${handle} bound ${binding?.address ?? "?"} for ${amount} on ${d.docket}`, source: `data/receipts.json (the registry's record of binding ${d.binding}, fetched ${binding.fetchedAt ?? "?"}; its payload hash is checked against the live log above)`, kind: "file" },
            { label: "receipt", value: r ? `tx ${r.tx_hash} log ${r.transfer_log_index}, block ${r.block_number}, from ${r.source_address}` : "no receipt record", source: "data/receipts.json → receipt", kind: "file" },
          ]
        : [
            { label: "binding", value: `${handle} bound ${binding?.address ?? "?"} for ${amount} on ${d.docket}`, source: `GET /api/payout-bindings/${d.binding}`, readAt },
            { label: "receipt", value: r ? `tx ${r.tx_hash} log ${r.transfer_log_index}, block ${r.block_number}, from ${r.source_address}` : "no receipt record", source: `GET /api/payout-bindings/${d.binding} → receipt`, readAt },
          ]),
    ],
    shows,
    log: logSteps,
    sealed,
    notVerified,
    extra: { claim, receiptRecord: r, eventId: event.id, checkpointSize: proof?.checkpoint?.tree_size ?? null },
    cite: `A-${d.binding} ${state === STATE.TIED ? "tied" : state} · tx ${d.tx}:${d.logIndex} · event ${event.id} → checkpoint ${proof?.checkpoint?.id ?? "?"}`,
  });
}

/** Load and build schedule A: the log against the witness first, then one line per receipt. */
export async function scheduleA(ctx) {
  const events = (ctx.docs.receiptEvents?.events ?? []).slice().sort((a, b) => b.id - a.id);
  const parsed = events.map((e) => ({ e, d: parseReceiptDetail(e.detail) }));
  const bindings = {};
  const proofs = {};
  const pWitness = witnessLine(ctx).catch((e) => line({ ref: "A-log", schedule: "A", route: "#/a/log", state: STATE.UNREAD, why: `not read: ${e?.message ?? e}`, title: "the society's log, as GitHub's witness saw it" }));
  // A receipt's binding record comes from data/receipts.json when it is there (the page re-checks its payload hash
  // against the live log), otherwise from the registry, one heavy GET each. Proofs are always read live.
  const index = ctx.receiptsIndex?.bindings ?? {};
  await Promise.all(
    parsed.map(async ({ e, d }) => {
      if (!d) return;
      const kept = index[d.binding];
      const [b, p] = await Promise.all([kept ? { ok: true, json: { ...kept, fromFile: true, fetchedAt: ctx.receiptsIndex.built_at } } : registry(`/api/payout-bindings/${d.binding}`), registry(`/api/proof?log=identity_events&event=${e.id}`)]);
      if (b.ok) bindings[d.binding] = b.json;
      if (p.ok) proofs[e.id] = p.json;
    })
  );
  const txs = parsed.filter((x) => x.d).map((x) => x.d.tx);
  const receipts = txs.length ? await receiptsAt(txs) : null;
  const lines = [await pWitness];
  for (const { e, d } of parsed) {
    lines.push(await receiptLine({ event: e, proof: proofs[e.id], binding: d ? bindings[d.binding] : null, receipts, finalHead: ctx.finalHead, registryKey: ctx.registryKey, readAt: ctx.readAt }));
  }
  ctx.receiptTxs = new Set(txs.map(lc));
  ctx.samples = { ...(ctx.samples ?? {}), receipts }; // kept so the controls can re-run ties on live data
  ctx.receiptLines = lines;
  return lines;
}
