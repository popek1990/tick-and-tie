// Schedule C · THE OBSERVER: a second observer, standing next to the registry's own.
//
// The registry walks each funder wallet's USDC and 1F916 Transfer logs, one wallet per cycle, and records a
// transfer to a bound address as an OBSERVED PAYMENT once two providers return the same logs (src/observer.ts).
// Its marks are public in GET /api/rail → observer.marks, with its own rule for reading them: "A count of zero on
// a listing is meaningful only once its funder wallet's last_block is past the block the listing was posted at."
//
// For each wallet it watches, this schedule:
//   1. prints how far behind finality the mark is, and the cycles it needs to catch up (arithmetic on the
//      registry's own walk_note, shown as such);
//   2. walks the same wallet itself (committed baseline + live stretch), classifies every transfer with the
//      registry's own rule (classifyTransfer's, written again below), and ties every payment at two nodes;
//   3. splits them at the mark. After it: payments the rail cannot count yet. Before it: payments the rail should
//      already count, set against GET /api/rail → listings[].observed_payments. The second half is what turns a
//      line green the day the observer catches up, instead of going quiet.
// The replay of the observer's own next call (the diagnosis) is replay(), used by "today".

import { indexerPages, rpcVerbatim, registry } from "../net.js";
import { receiptsAt, tieTransfer, STATE } from "../chain.js";
import { parseAtomic, formatAsset, lc, short, fromMs, isoMin, groupInt, plural, ranges, USDC, TOKEN, addressToTopic } from "../codec.js";
import { line } from "../lines.js";

const OBSERVED_TOKENS = [USDC, TOKEN];
const KEYED_RANGE = 10_000; // src/observer.ts OBSERVER_BLOCKS_PER_CYCLE_KEYED; the live marks span exactly this
const CAPPED_RANGE = 2_000; // what mainnet.base.org accepts today (-32614 "limited to a 2,000 range")
const START_MARGIN = 20_000; // src/observer.ts OBSERVER_START_MARGIN_BLOCKS
const BLOCK_SECONDS = 2;
const DAY_BLOCKS = 43_200;
const HANDLE = /^[A-Za-z0-9_.-]{1,64}$/;
const plainHandle = (h) => (HANDLE.test(String(h)) ? String(h) : "(a handle with unusual characters)");

export function blockTime(block, head) {
  // Base makes a block every 2 seconds; derived from the finalized head we read, labelled "≈" wherever shown.
  if (!head?.time || !head?.number) return null;
  return new Date(head.time.getTime() - (head.number - block) * BLOCK_SECONDS * 1000);
}

export function blockAt(time, head) {
  if (!head?.time || !head?.number || !(time instanceof Date) || isNaN(time)) return null;
  return head.number - Math.round((head.time.getTime() - time.getTime()) / (BLOCK_SECONDS * 1000));
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

// The observer's public providers, in its own order after the keyed one (src/observer.ts observerRpcUrls:
// mainnet.base.org, tenderly, then the rail's pool).
export const REPLAY_NODES = Object.freeze(["base", "tenderly", "drpc", "publicnode"]);

/**
 * The diagnosis. Asks each public provider the observer's own question (10,000 blocks), then the same question
 * over 1,000 blocks at the two that accept that width. Verbatim answers, dated, no interpretation beyond counting.
 */
export async function replay(mark, finalized) {
  const call = nextObserverCall(mark, finalized);
  const wideAnswers = await Promise.all(REPLAY_NODES.map((node) => rpcVerbatim(node, call)));
  const wide = Object.fromEntries(REPLAY_NODES.map((node, i) => [node, summarizeAnswer(wideAnswers[i])]));
  const narrowCall = structuredClone(call);
  narrowCall.params[0].toBlock = "0x" + (mark.last_block + 1000).toString(16);
  const narrowNodes = ["base", "tenderly"];
  const narrowAnswers = await Promise.all(narrowNodes.map((node) => rpcVerbatim(node, narrowCall)));
  const narrow = Object.fromEntries(narrowNodes.map((node, i) => [node, summarizeAnswer(narrowAnswers[i])]));
  const wideAnswered = Object.values(wide).filter((s) => /answered/.test(s)).length;
  const narrowAnswered = Object.values(narrow).filter((s) => /answered/.test(s)).length;
  return { call, wide, narrow, wideAnswered, narrowAnswered, at: new Date().toISOString() };
}

/**
 * The registry's own rule for one transfer, as src/observer.ts classifyTransfer applies it (commit c0c1afab),
 * written again for this page's shapes (no code copied) and held to it case by case in test/checks.test.mjs.
 * `bindings` are every worker and verifier binding on the funder's listings, as its bindingIndexFor reads them;
 * `t` is {to, token, value}.
 *   a zero value                                         → zero_value (the address-poisoning pattern)
 *   no binding on the funder's listings at that address  → other
 *   exactly one listing has a binding with the same address, amount and asset → a payment credited to it
 *   anything else (another amount or asset, or the same on several listings) → a payment against the citizen
 *     only, named by the earliest binding at that address
 */
export function classifyTransfer(t, bindings) {
  if (t.value === 0n) return { kind: "zero_value", listing: null, binding: null, handle: null, citizenOnly: false };
  const cands = bindings.filter((b) => lc(b.payout_address) === lc(t.to)).sort((a, b) => Number(a.id) - Number(b.id));
  if (!cands.length) return { kind: "other", listing: null, binding: null, handle: null, citizenOnly: false };
  const exact = cands.filter((c) => String(c.amount_atomic) === t.value.toString() && lc(c.token) === lc(t.token));
  const listings = [...new Set(exact.map((c) => c.listing_id))];
  if (listings.length !== 1) {
    return { kind: "payment", listing: null, binding: null, handle: cands[0].handle, citizenOnly: true, listings, why: exact.length ? `the same address, amount and asset are bound on listings ${ranges(listings)}` : "another amount or asset than any binding at this address" };
  }
  const pick = exact[0];
  return { kind: "payment", listing: pick.listing_id, binding: Number(pick.id), handle: pick.handle, citizenOnly: false, boundAt: pick.created_at };
}

/** How the registry's rule reads one transfer, in words. */
function ruleText(c) {
  if (c.kind === "other") return "no binding on this funder's listings names this address: not a payment by the registry's rule";
  if (c.kind === "zero_value") return "zero value: the poisoning pattern";
  if (c.citizenOnly) return `the registry's rule records it against ${plainHandle(c.handle)} only, no listing: ${c.why}`;
  return `the registry's rule credits listing ${c.listing} (${plainHandle(c.handle)}'s binding #${c.binding})`;
}

/**
 * Catching up, as arithmetic on the walk_note: each wallet gets one cycle every (wallets × cycle) minutes, Base
 * adds (wallets × cycle × 60 / 2) blocks meanwhile, and a cycle walks at most `range` blocks.
 */
export function catchUp(gap, wallets, cycleMinutes, range) {
  if (!(gap > 0) || !(wallets > 0) || !(cycleMinutes > 0)) return null;
  const perTurn = (wallets * cycleMinutes * 60) / BLOCK_SECONDS;
  if (range <= perTurn) return { cycles: Infinity, hours: Infinity, perTurn };
  const cycles = Math.ceil(gap / (range - perTurn));
  return { cycles, hours: (cycles * wallets * cycleMinutes) / 60, perTurn };
}

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
/** "One funder wallet per five-minute cycle" → 5, or null when the note says something else. */
export function cycleMinutesOf(walkNote) {
  const m = /per ([a-z]+|\d+)-minute cycle/i.exec(String(walkNote ?? ""));
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : WORDS[m[1].toLowerCase()] ?? null;
}

export const hoursText = (h) => (!Number.isFinite(h) ? "never" : h < 48 ? `≈${Math.round(h)} hours` : `≈${(h / 24).toFixed(1)} days`);

/** Transfers out of `wallet` after `afterBlock`, from the committed baseline plus the indexer after it. */
async function outflowsFrom(ctx, wallet, afterBlock) {
  const base = ctx.baseline;
  const found = [];
  const notes = [];
  let zero = 0;
  const take = (x) => (x.value === 0n ? zero++ : found.push(x));
  if (base) {
    for (const l of base.logs) {
      if (l.from === wallet && l.block > afterBlock && OBSERVED_TOKENS.includes(l.token)) take({ tx: l.tx, logIndex: l.log_index, token: l.token, from: l.from, to: l.to, value: BigInt(l.value), block: l.block, source: "baseline" });
    }
  } else notes.push("the committed baseline did not load, so only the indexer's newest transfers were read");
  const liveFrom = Math.max(afterBlock, base?.to_block ?? afterBlock);
  const liveNeeded = !!(ctx.minFinal && liveFrom < ctx.minFinal);
  let liveOk = !liveNeeded; // nothing after the baseline to read is not a failure to read it
  if (liveNeeded) {
    const r = await indexerPages(`/api/v2/addresses/${wallet}/token-transfers?type=ERC-20&filter=from`, liveFrom, 3);
    if (!r.ok) notes.push(`the live stretch after block ${groupInt(liveFrom)}: not read (indexer: ${r.error})`);
    else if (!r.complete) notes.push(`the live stretch after block ${groupInt(liveFrom)}: the indexer's list did not reach back that far (${r.error}), so older transfers in it were not listed`);
    else liveOk = true;
    for (const it of r.items) {
      const block = Number(it.block_number ?? 0);
      const token = lc(it.token?.address_hash ?? it.token?.address);
      const value = parseAtomic(it.total?.value);
      if (block <= liveFrom || block > ctx.minFinal || !OBSERVED_TOKENS.includes(token) || value === null || lc(it.from?.hash) !== wallet) continue;
      take({ tx: lc(it.transaction_hash), logIndex: Number(it.log_index), token, from: wallet, to: lc(it.to?.hash), value, block, source: "indexer hint" });
    }
  }
  // The stretch counts as read only when every source that covers it answered: the committed baseline, and — when
  // the stretch reaches past the baseline's last block — the indexer's list back to that block. Anything less and
  // an empty result means "not read", never "nothing moved".
  return { found, zero, notes, stretchRead: !!base && liveOk };
}

const fundersListings = (ctx, wallet) => (ctx.docs.rail?.listings ?? []).filter((l) => lc(l.funder_address) === wallet);

/**
 * Every binding on the funder's listings (the registry's rule needs all of them, open or closed). From the
 * committed index (data/bindings.json) while GET /api/rail still shows the same binding counts for a listing,
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

/** Handles as sentence parts, at most `max`, then "and N more". */
function handleParts(handles, max = 6) {
  const shown = handles.slice(0, max);
  const parts = shown.flatMap((h, i) => [i ? ", " : "", { handle: h }]);
  if (handles.length > max) parts.push(` and ${handles.length - max} more`);
  return parts;
}

export async function scheduleC(ctx) {
  const rail = ctx.docs.rail;
  const marks = rail?.observer?.marks ?? [];
  const walkNote = rail?.observer?.walk_note ?? null;
  const countNote = rail?.observer?.note ?? null;
  const cycleMinutes = cycleMinutesOf(walkNote);
  const lines = [];
  ctx.observerPayments = [];
  ctx.observerWallets = [];
  for (const mark of marks) {
    const wallet = lc(mark.funder_address);
    const never = !Number.isInteger(mark.last_block);
    const listings = fundersListings(ctx, wallet);
    const ids = listings.map((l) => l.listing_id);
    const firstAt = listings.map((l) => l.created_at).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const startBlock = firstAt && ctx.headRef ? blockAt(new Date(firstAt), ctx.headRef) - START_MARGIN : null;
    const walkFrom = Math.max(ctx.baseline?.from_block ?? 0, startBlock ?? 0);
    const gap = ctx.minFinal && !never ? ctx.minFinal - mark.last_block : null;
    const behind = never || gap === null || gap > DAY_BLOCKS;
    const days = gap !== null ? Math.round((gap * BLOCK_SECONDS) / 86400) : null;

    const { found, zero, notes, stretchRead } = ctx.minFinal ? await outflowsFrom(ctx, wallet, walkFrom - 1) : { found: [], zero: 0, notes: ["no finalized head was read, so this wallet was not walked"], stretchRead: false };
    const { bindings, unread, live, indexed } = found.length ? await fundersBindings(ctx, wallet) : { bindings: [], unread: [], live: [], indexed: [] };
    if (unread.length) notes.push(`listing detail not read for listing${unread.length === 1 ? "" : "s"} ${unread.join(", ")}: a payment to a route there would be missed`);
    const receipts = found.length ? await receiptsAt(found.map((f) => f.tx)) : null;
    const all = found.map((f) => {
      const time = blockTime(f.block, ctx.headRef);
      return { ...f, time, tie: tieTransfer(f, receipts, ctx.minFinal), cls: classifyTransfer(f, bindings), receipted: ctx.receiptTxs?.has(f.tx) ?? false, after: never || f.block > mark.last_block };
    });
    const tied = (p) => p.tie.state === STATE.TIED;
    const payments = all.filter((p) => p.cls.kind === "payment");
    const others = all.filter((p) => p.cls.kind === "other");
    const after = payments.filter((p) => p.after);
    const afterTied = after.filter(tied);
    const unseen = afterTied.filter((p) => !p.receipted);
    const afterReceipted = afterTied.filter((p) => p.receipted);
    const afterUnread = after.filter((p) => !tied(p));
    const walked = payments.filter((p) => !p.after);

    // Before the mark: a payment credited to one listing, tied, to a binding filed before the money moved, is one
    // the observer saw with that binding in its index. The rail's count for that listing cannot be lower.
    const expected = new Map();
    for (const p of walked) if (tied(p) && !p.cls.citizenOnly && p.time && Number(p.cls.boundAt) < p.time.getTime()) expected.set(p.cls.listing, (expected.get(p.cls.listing) ?? 0) + 1);
    const railCount = new Map(listings.map((l) => [l.listing_id, l.observed_payments]));
    const fewer = [...expected].filter(([id, n]) => (railCount.get(id) ?? 0) < n).map(([id]) => id);
    const railTotal = listings.reduce((s, l) => s + (Number.isInteger(l.observed_payments) ? l.observed_payments : 0), 0);
    const expectedTotal = [...expected.values()].reduce((a, b) => a + b, 0);

    const who = [...new Set(unseen.map((p) => p.cls.handle))];
    ctx.observerPayments.push(...unseen.map((p) => ({ tx: p.tx, logIndex: p.logIndex, to: p.to, token: p.token, value: p.value, block: p.block, handle: p.cls.handle, listing: p.cls.listing, funder: wallet })));
    const fast = catchUp(gap, marks.length, cycleMinutes, KEYED_RANGE);
    const slow = catchUp(gap, marks.length, cycleMinutes, CAPPED_RANGE);
    ctx.observerWallets.push({ wallet, never, gap, behind, unseen: unseen.length, fast, slow });

    let state;
    let why;
    if (!ctx.minFinal) [state, why] = [STATE.UNREAD, "not read: no finalized head was read"];
    else if (never) [state, why] = [STATE.BLIND, "its last_block is null: it has never finished a read of this wallet, so by the registry's own rule a zero it serves here is not a reading"];
    else if (behind) [state, why] = [STATE.BLIND, `the observer is ${groupInt(gap)} blocks (≈${days} days) behind finality; by the registry's own rule a zero it serves on these listings is not a reading yet`];
    else if (!ctx.baseline || unread.length) [state, why] = [STATE.UNREAD, "the observer is current, but this page could not read everything it needs to compare (see NOT VERIFIED)"];
    else if (fewer.length) [state, why] = [STATE.UNREAD, `the observer is current, and the rail counts fewer observed payments than this page finds before its mark on listing${fewer.length === 1 ? "" : "s"} ${ranges(fewer)}`];
    else [state, why] = [STATE.TIED, "the observer is current, and the rail counts every payment this page finds before its mark"];

    const sentence = [];
    if (never) sentence.push("The observer has never finished a read of this wallet (last_block is null). Since this funder's first listing, ");
    else sentence.push(`The observer has read this wallet to block ${groupInt(mark.last_block)}${gap !== null ? `, ${groupInt(gap)} blocks behind finality` : ""}. ${behind ? "After that block" : "Since then"} `);
    // An empty walk is an absence only when the walk happened. Without a read stretch the page says so instead.
    if (!stretchRead) sentence.push(`this page did not read that stretch of Base, so it cannot say what moved there: ${notes[0] ?? "no source answered"}.`);
    else if (!afterTied.length) sentence.push("Base shows no payment by the registry's own rule, tied at two nodes.");
    else {
      sentence.push(`Base shows ${plural(afterTied.length, "payment")} by the registry's own rule, tied at two nodes`);
      if (unseen.length) sentence.push(`: ${unseen.length} with no receipt, to ${plural(who.length, "citizen")} (`, ...handleParts(who), ")");
      if (afterReceipted.length) sentence.push(`${unseen.length ? "; " : ": "}${afterReceipted.length} with a receipt (schedule A)`);
      sentence.push(".");
      if (behind) sentence.push(" The rail cannot count them until its observer gets there.");
    }
    if (afterUnread.length) sentence.push(` ${plural(afterUnread.length, "more was", "more were")} not read at two nodes.`);
    if (!behind && ctx.baseline) sentence.push(` Before its mark the rail counts ${railTotal} observed on these listings; this page expects at least ${expectedTotal}.`);

    const railSays = (() => {
      const vals = listings.map((l) => l.observed_payments);
      if (!vals.length) return "no listing names this wallet";
      return vals.every((v) => v === vals[0]) ? `${vals[0] ?? "null"} on each of listing${ids.length === 1 ? "" : "s"} ${ranges(ids)}` : listings.map((l) => `listing ${l.listing_id}: ${l.observed_payments ?? "null"}`).join(", ");
    })();
    const row = (p) => ({ node: `${p.tie.mark} block ${groupInt(p.block)}`, text: `${short(p.to)} ← ${formatAsset(p.value, p.token)} · ${ruleText(p.cls)} · ${p.tie.why}` });
    const group = (title, list, cap = 40) => (list.length ? [{ group: `${title} (${list.length})` }, ...list.slice(0, cap).map(row), ...(list.length > cap ? [{ node: "…", text: `${list.length - cap} more not shown` }] : [])] : []);
    const catchText = fast && slow ? `at the observer's ${groupInt(KEYED_RANGE)} blocks a cycle: ${Number.isFinite(fast.cycles) ? groupInt(fast.cycles) : "no"} cycles, ${hoursText(fast.hours)}; at ${groupInt(CAPPED_RANGE)} a cycle: ${Number.isFinite(slow.cycles) ? groupInt(slow.cycles) : "no"} cycles, ${hoursText(slow.hours)}. Arithmetic on the walk_note (one wallet per ${cycleMinutes}-minute cycle, ${marks.length} wallets), and Base adds ${groupInt(fast.perTurn)} blocks while the other wallets take their turns.` : null;

    lines.push(
      line({
        ref: `C-${wallet.slice(2, 8)}`,
        schedule: "C",
        route: `#/c/${wallet}`,
        state,
        why,
        title: `${short(wallet)} · funder wallet of ${ids.length ? `listing${ids.length === 1 ? "" : "s"} ${ranges(ids)}` : "no listing on the rail"}`,
        handles: who,
        sentence,
        says: [
          { label: "observer mark", value: `last_block ${mark.last_block}, last range ${mark.last_range_from ?? "none"}–${mark.last_range_to ?? "none"} (${mark.last_range_rows ?? 0} rows), updated ${isoMin(fromMs(mark.updated_at))}, last_error "${mark.last_error ?? "none"}"`, source: "GET /api/rail → observer.marks", readAt: ctx.readAt },
          ...(walkNote ? [{ label: "how it walks", value: walkNote, source: "GET /api/rail → observer.walk_note" }] : []),
          ...(countNote ? [{ label: "what it counts", value: countNote, source: "GET /api/rail → observer.note" }] : []),
          { label: "what the rail counts", value: `observed_payments ${railSays}`, source: "GET /api/rail → listings[].observed_payments", readAt: ctx.readAt },
          ...(indexed.length || live.length
            ? [{ label: "bindings classified against", value: `${bindings.length} bindings on listings ${ranges([...indexed, ...live])}${indexed.length ? `; from data/bindings.json (built ${ctx.bindingsIndex?.built_at ?? "?"}) for ${ranges(indexed)}, whose binding counts on the rail are unchanged` : ""}${live.length ? `; read live for ${ranges(live)}` : ""}`, source: indexed.length ? "data/bindings.json, checked against GET /api/rail counts" : "GET /api/listings/:id", kind: indexed.length ? "file" : "registry" }]
            : []),
        ],
        shows: [
          { node: "finalized", text: !ctx.minFinal ? "not read" : never ? `min(finalized) ${groupInt(ctx.minFinal)}; the mark has no last_block, so this page walked from block ${groupInt(walkFrom)} (≈ the funder's first listing, minus ${groupInt(START_MARGIN)})` : `min(finalized) ${groupInt(ctx.minFinal)}; the mark is ${groupInt(gap)} blocks behind (block ${groupInt(mark.last_block)} ≈ ${isoMin(blockTime(mark.last_block, ctx.headRef))})` },
          ...(behind && catchText ? [{ node: "catching up", text: catchText }] : []),
          ...group("After the mark, no receipt: the rail cannot count these yet", unseen),
          ...group("After the mark, with a receipt (schedule A)", afterReceipted),
          ...group("After the mark, not read at two nodes", afterUnread),
          ...group(`Before the mark: blocks ${groupInt(walkFrom)}–${never ? "" : groupInt(mark.last_block)}, which the observer has walked`, walked),
          ...group("Not a payment by the registry's rule", others, 12),
          ...(zero ? [{ node: "zero value", text: `${plural(zero, "zero-value transfer")} from this wallet since block ${groupInt(walkFrom)}: the poisoning pattern, which the observer records apart (schedule G shows the lookalikes)` }] : []),
        ],
        notVerified: [
          "which submission any of these payments was for: nothing says",
          "what the observer's keyed endpoint and Cloudflare's egress see: only its public marks are read",
          "when this mark last moved: updated_at moves on failed cycles too, and last_error keeps only the last provider's message (src/observer.ts)",
          `the observer's first block for this wallet: estimated as its first listing's block minus ${groupInt(START_MARGIN)} (src/observer.ts OBSERVER_START_MARGIN_BLOCKS)`,
          "the bindings each block was classified with: the observer used those that existed when it walked the block; this page uses today's, and counts only payments to a binding filed before the money moved when it compares",
          ...notes,
        ],
        extra: { mark, payments, gap, never, behind, unseen, fast, slow },
        cite: `C ${short(wallet)}: observer last_block ${mark.last_block}${gap !== null ? `, ${groupInt(gap)} behind min(finalized) ${ctx.minFinal}` : ""}; after it, ${plural(unseen.length, "payment")} by the registry's rule with no receipt, tied at two nodes`,
      })
    );
  }
  return lines;
}

export { KEYED_RANGE, CAPPED_RANGE, OBSERVED_TOKENS };
