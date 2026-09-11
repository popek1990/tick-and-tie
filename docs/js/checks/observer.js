// Schedule C · THE OBSERVER: a second observer, standing next to the registry's own.
//
// The registry walks each funder wallet's USDC and 1F916 Transfer logs and records a payment when two providers
// return the same logs (src/observer.ts). Its marks are public in GET /api/rail → observer.marks, and its rule is
// quoted there: "A count of zero on a listing is meaningful only once its funder wallet's last_block is past the
// block the listing was posted at."
//
// This schedule does three things:
//   1. prints how far behind finality each mark is;
//   2. replays the observer's exact next call at each public node and shows each answer verbatim (the diagnosis);
//   3. walks the same wallets itself (committed baseline + live stretch + footing), matches what moved to bindings
//      with the registry's own rule, and ties every match at two nodes.

import { registry, indexer, rpcVerbatim } from "../net.js";
import { receiptsAt, tieTransfer, balancesAt, agreedValue, STATE } from "../chain.js";
import { parseAtomic, formatAsset, lc, short, fromMs, isoMin, groupInt, USDC, TOKEN, addressToTopic } from "../codec.js";
import { line } from "../lines.js";

const OBSERVED_TOKENS = [USDC, TOKEN];
const KEYED_RANGE = 10_000; // src/observer.ts OBSERVER_BLOCKS_PER_CYCLE_KEYED; the live marks span exactly this
const BLOCK_SECONDS = 2;

export function blockTime(block, head) {
  // Base makes a block every 2 seconds; derived from the finalized head we read, labelled "≈" wherever shown.
  if (!head?.time || !head?.number) return null;
  return new Date(head.time.getTime() - (head.number - block) * BLOCK_SECONDS * 1000);
}

/** The observer's next eth_getLogs call for one mark, exactly as src/observer.ts builds it. */
export function nextObserverCall(mark, finalized) {
  const from = mark.last_block + 1;
  const to = Math.min(finalized, from + KEYED_RANGE - 1);
  return {
    method: "eth_getLogs",
    params: [{ address: OBSERVED_TOKENS, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", addressToTopic(mark.funder_address)] }],
  };
}

function summarizeAnswer(a) {
  if (!a) return "no answer";
  if (a.error) return `no answer (${a.error})`;
  let j = null;
  try {
    j = JSON.parse(a.text);
  } catch {}
  if (j?.error) return `HTTP ${a.status}: error ${j.error.code}: ${String(j.error.message).slice(0, 120)}`;
  if (Array.isArray(j?.result)) return `HTTP ${a.status}: answered, ${j.result.length} logs`;
  return `HTTP ${a.status}: ${String(a.text).slice(0, 120) || "(empty body)"}`;
}

/**
 * The diagnosis. Asks each public node the observer's own question (10,000 blocks), then the same question over
 * 1,000 blocks at the two nodes that accept that width. Verbatim answers, dated, no interpretation beyond counting.
 */
export async function replay(mark, finalized) {
  const call = nextObserverCall(mark, finalized);
  const wide = {};
  for (const node of ["base", "tenderly", "drpc", "publicnode"]) wide[node] = summarizeAnswer(await rpcVerbatim(node, call));
  const narrowCall = structuredClone(call);
  narrowCall.params[0].toBlock = "0x" + (mark.last_block + 1000).toString(16);
  const narrow = {};
  for (const node of ["base", "tenderly"]) narrow[node] = summarizeAnswer(await rpcVerbatim(node, narrowCall));
  const wideAnswered = Object.values(wide).filter((s) => /answered/.test(s)).length;
  const narrowAnswered = Object.values(narrow).filter((s) => /answered/.test(s)).length;
  return { call, wide, narrow, wideAnswered, narrowAnswered, at: new Date().toISOString() };
}

/**
 * The registry's matching rule, applied here: a transfer from the funder to an address bound on one of the
 * funder's listings, for exactly the bound amount and asset, credits that listing only when no other listing of
 * the same funder has a binding with the same address, amount and asset.
 */
export function matchToBindings(transfer, bindings) {
  const hits = bindings.filter((b) => lc(b.payout_address) === transfer.to && lc(b.token) === transfer.token && parseAtomic(b.amount_atomic) === transfer.value);
  const listings = [...new Set(hits.map((b) => b.listing_id))];
  if (listings.length === 1) return { rule: "creditable", listing: listings[0], bindings: hits };
  if (listings.length > 1) return { rule: "citizen-only", listings, bindings: hits };
  const toBound = bindings.filter((b) => lc(b.payout_address) === transfer.to);
  if (toBound.length) return { rule: "bound-other-amount", bindings: toBound };
  return { rule: "bound-nowhere" };
}

/** Transfers out of `wallet` after `afterBlock`, from the committed baseline plus the indexer after it. */
async function outflowsAfter(ctx, wallet, afterBlock) {
  const base = ctx.baseline;
  const found = [];
  const notes = [];
  if (base) {
    for (const l of base.logs) {
      if (l.from === wallet && l.block > afterBlock && OBSERVED_TOKENS.includes(l.token) && l.value !== "0") {
        found.push({ tx: l.tx, logIndex: l.log_index, token: l.token, from: l.from, to: l.to, value: BigInt(l.value), block: l.block, source: "baseline" });
      }
    }
  } else notes.push("the committed baseline did not load");
  const liveFrom = Math.max(afterBlock, base?.to_block ?? afterBlock);
  if (ctx.minFinal && liveFrom < ctx.minFinal) {
    const r = await indexer(`/api/v2/addresses/${wallet}/token-transfers?type=ERC-20&filter=from`);
    if (!r.ok) notes.push(`live stretch after block ${liveFrom}: not read (indexer: ${r.error})`);
    else {
      for (const it of r.json.items ?? []) {
        const block = Number(it.block_number ?? 0);
        const token = lc(it.token?.address_hash ?? it.token?.address);
        const value = parseAtomic(it.total?.value);
        if (block <= liveFrom || block > ctx.minFinal || !OBSERVED_TOKENS.includes(token) || !value) continue;
        found.push({ tx: lc(it.transaction_hash), logIndex: Number(it.log_index), token, from: wallet, to: lc(it.to?.hash), value, block, source: "indexer hint" });
      }
      if (r.json.next_page_params) notes.push("the indexer has more pages; only the newest page was read for the live stretch");
    }
  }
  return { found, notes };
}

const fundersListings = (ctx, wallet) => (ctx.docs.rail?.listings ?? []).filter((l) => lc(l.funder_address) === wallet);

/**
 * Every binding on the funder's listings (the registry's matching rule needs all of them, open or closed). From
 * the committed index (data/bindings.json) while GET /api/rail still shows the same binding counts for a listing,
 * otherwise from GET /api/listings/:id, one at a time.
 */
async function fundersBindings(ctx, wallet) {
  const listings = fundersListings(ctx, wallet);
  const out = [];
  const unread = [];
  const live = [];
  const indexed = [];
  for (const l of listings) {
    const snap = ctx.bindingsIndex?.listings?.[l.listing_id];
    const same = snap && !snap.bindings_has_more && snap.rail_worker_bindings === l.worker_bindings && snap.rail_verifier_bindings === l.verifier_bindings && lc(snap.funder_address) === wallet;
    if (same) {
      indexed.push(l.listing_id);
      for (const b of snap.bindings) out.push({ ...b, listing_id: l.listing_id });
      continue;
    }
    const r = ctx.listingDetail ? await ctx.listingDetail(l.listing_id) : await registry(`/api/listings/${l.listing_id}`);
    if (!r?.ok) {
      unread.push(l.listing_id);
      continue;
    }
    live.push(l.listing_id);
    for (const b of r.json.bindings ?? []) out.push({ ...b, listing_id: l.listing_id });
    if (r.json.bindings_has_more) unread.push(`${l.listing_id} (bindings past the first page)`);
  }
  return { bindings: out, unread, live, indexed };
}

export async function scheduleC(ctx) {
  const rail = ctx.docs.rail;
  const marks = rail?.observer?.marks ?? [];
  const rule = "A count of zero on a listing is meaningful only once its funder wallet's last_block is past the block the listing was posted at.";
  const lines = [];
  ctx.observerPayments = [];
  for (const mark of marks) {
    const wallet = lc(mark.funder_address);
    // last_block null: the observer has never finished a read of this wallet. Its zeros are then not readings at
    // all; this page walks the wallet from the start of the committed baseline instead.
    const never = !Number.isInteger(mark.last_block);
    const from = never ? (ctx.baseline?.from_block ?? 0) : mark.last_block;
    const gap = ctx.minFinal && !never ? ctx.minFinal - mark.last_block : null;
    const lastAt = never ? null : blockTime(mark.last_block, ctx.headRef);
    const listings = fundersListings(ctx, wallet);
    const { found, notes } = await outflowsAfter(ctx, wallet, from);
    const { bindings, unread, live, indexed } = found.length ? await fundersBindings(ctx, wallet) : { bindings: [], unread: [], live: [], indexed: [] };
    if (unread.length) notes.push(`listing detail not read for listing${unread.length === 1 ? "" : "s"} ${unread.join(", ")}: a match there would be missed`);
    const receipts = found.length ? await receiptsAt(found.map((f) => f.tx)) : null;
    const payments = [];
    for (const f of found) {
      const tie = tieTransfer(f, receipts, ctx.minFinal);
      const m = matchToBindings(f, bindings);
      const receipted = ctx.receiptTxs?.has(f.tx) ?? false;
      payments.push({ ...f, tie, match: m, receipted });
    }
    const unseen = payments.filter((p) => !p.receipted && p.tie.state === STATE.TIED && (p.match.rule === "creditable" || p.match.rule === "citizen-only"));
    ctx.observerPayments.push(...unseen.map((p) => ({ ...p, funder: wallet })));
    const listingsAfter = listings.filter((l) => (never ? true : l.created_at && lastAt ? l.created_at > lastAt.getTime() : false)).map((l) => l.listing_id);
    const blind = never || (gap ?? 0) > 43_200 || unseen.length > 0;
    const handleList = [...new Set(unseen.flatMap((p) => (p.match.bindings ?? []).map((b) => b.handle)))];
    const since = never ? "and the observer has never finished a read of it" : `since the observer's last block, ${groupInt(gap)} blocks ago`;
    const named = listings.length ? ` Listing${listings.length === 1 ? "" : "s"} ${listings.map((l) => l.listing_id).join(", ")} name${listings.length === 1 ? "s" : ""} it as funder.` : "";
    const sentence = unseen.length
      ? ["The rail shows ", `${unseen.length === 1 ? "no payment" : "no payments"}`, " for ", ...handleList.flatMap((h, i) => [i ? ", " : "", { handle: h }]), `. Base shows ${unseen.length} from this wallet, ${since}.`]
      : never
        ? [`The observer has never finished a read of this wallet (last_block is null; its last attempt: “${String(mark.last_error ?? "no error given").slice(0, 120)}”).${named} Base shows no unreceipted payment from it to a bound address.`]
        : [`The observer read this wallet up to block ${groupInt(mark.last_block)}, ${gap !== null ? groupInt(gap) + " blocks" : "an unknown distance"} behind finality. Base shows no unreceipted payment to a bound address since.`];
    lines.push(
      line({
        ref: `C-${wallet.slice(2, 8)}`,
        schedule: "C",
        route: `#/c/${wallet}`,
        state: blind ? STATE.BLIND : STATE.TIED,
        why: never ? "the observer has no last_block for this wallet; by the registry's own rule its zeros are not readings" : blind ? `the observer is ${groupInt(gap)} blocks (≈${Math.round((gap * BLOCK_SECONDS) / 86400)} days) behind; by the registry's own rule its zeros are not readings` : "the observer is current",
        title: `${short(wallet)} · ${listings.length ? listings.length : "no"} listing${listings.length === 1 ? " names" : "s name"} it as funder`,
        handles: handleList,
        sentence,
        says: [
          { label: "observer mark", value: `last_block ${mark.last_block}, updated ${isoMin(fromMs(mark.updated_at))}, last_error "${mark.last_error ?? "none"}", last range ${mark.last_range_from}–${mark.last_range_to}`, source: "GET /api/rail → observer.marks", readAt: ctx.readAt },
          { label: "the rule", value: rule, source: "GET /api/rail → observer", readAt: ctx.readAt },
          ...(listingsAfter.length ? [{ label: "listings posted after its last block", value: listingsAfter.map((id) => `listing ${id}`).join(", "), source: "GET /api/rail → listings[].created_at" }] : []),
          ...(indexed.length || live.length
            ? [{ label: "bindings matched against", value: `${bindings.length} bindings on listings ${[...indexed, ...live].sort((a, b) => a - b).join(", ")}${indexed.length ? `; from data/bindings.json (built ${ctx.bindingsIndex?.built_at ?? "?"}) for ${indexed.length}, whose binding counts on the rail are unchanged` : ""}${live.length ? `; read live for ${live.join(", ")}` : ""}`, source: indexed.length ? "data/bindings.json, checked against GET /api/rail counts" : "GET /api/listings/:id" }]
            : []),
        ],
        shows: [
          { node: "finalized", text: !ctx.minFinal ? "not read" : never ? `min(finalized) ${groupInt(ctx.minFinal)}; the mark has no last_block, so this page read from block ${groupInt(from)}` : `min(finalized) ${groupInt(ctx.minFinal)}; the mark is ${groupInt(gap)} blocks behind (≈ ${lastAt ? isoMin(lastAt) : "?"})` },
          ...payments.map((p) => ({
            node: `${p.tie.mark} block ${groupInt(p.block)}`,
            text: `${short(p.to)} ← ${formatAsset(p.value, p.token)} · ${p.receipted ? "has a receipt (schedule A)" : p.match.rule === "creditable" ? `creditable to listing ${p.match.listing}` : p.match.rule === "citizen-only" ? `bound on listings ${p.match.listings.join(" and ")} at this amount: citizen only` : p.match.rule === "bound-other-amount" ? "bound address, other amount" : "bound nowhere read"} · ${p.tie.why}`,
          })),
        ],
        notVerified: [
          "which submission any of these payments was for: nothing says",
          "that the indexer's list after the baseline is complete: see the footing line in schedule D for the wallets it covers",
          "the observer's own providers and keys: only its public marks are read",
          ...notes,
        ],
        extra: { mark, payments, gap, never },
        cite: `C ${short(wallet)}: observer last_block ${mark.last_block}${never ? "" : `, ${groupInt(gap)} behind min(finalized) ${ctx.minFinal}`}; ${unseen.length} tied payment(s) to bound addresses with no receipt`,
      })
    );
  }
  return lines;
}

export { KEYED_RANGE, OBSERVED_TOKENS };
