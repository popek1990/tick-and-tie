// Schedule D · THE BOOKS: the treasury ledger, measured against its own sentences. Last on the page on purpose.
//
// Order, and why:
//   D-1  docket row treasury-governance (a) asks that a third party can recompute, from public methods only, which
//        USDC in the published treasury is spendable without a further claim step. This recomputes the balance at
//        two nodes. It does not claim the row closes.
//   D-2  what ties: every sealed row rehashes, links, and folds to the ledger root the registry key signed.
//   D-3  onchain_cents against balanceOf at two nodes ("the books round to cents").
//   D-4  outflows: each one ties at two nodes; each is matched to a row by tx, or by amount, date and destination
//        where a row names no tx. The ones no row names are folded, not hidden, with the count in the open.
//   D-5  the footing that makes D-4 complete: start balance + in − out = end balance, at two nodes.
//
// Words: "outflow" (not spend: that implies a purpose this page does not read), "no row names this tx", "the
// treasury key signed". The page does not read purpose, and it names no person. Credit: uriel (#3288, #4689)
// and bubbles walked these outflows first, in posts.

import { indexer } from "../net.js";
import { verifyLedgerRoot, NotSupported } from "../crypto.js";
import { balancesAt, tieBalance, agreedValue, receiptsAt, readTransfer, decide, STATE } from "../chain.js";
import { centsToUsdcAtomic, formatAsset, lc, short, isoMin, parseAtomic, groupInt, decodeTransfer, USDC, TOKEN, WETH, ASSETS } from "../codec.js";
import { blockTime } from "./observer.js";
import { topicOf } from "../keccak.js";
import { line } from "../lines.js";

export const TREASURY = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
export const PAYOUT_WALLET = "0xf32c99ae17c17022889b2288749ca433a2504211";
// Derived from the signature, never typed: a hex table from memory is how a wrong selector ships (see keccak.js).
const AUTHORIZATION_USED = topicOf("AuthorizationUsed(address,bytes32)");

/** Match one outflow to a ledger row: by tx first; else by amount, UTC date and a destination the row names. */
export function matchRow(outflow, entries) {
  const tx = lc(outflow.tx);
  const byTx = entries.find((e) => lc(e.tx) === tx || String(e.description).toLowerCase().includes(tx));
  if (byTx) return { how: "tx", row: byTx };
  if (outflow.token !== USDC) return null;
  const cents = -Number(outflow.value / 10000n);
  const day = outflow.time ? outflow.time.toISOString().slice(0, 10) : null;
  const toPayout = outflow.to === PAYOUT_WALLET;
  const byAmount = entries.find((e) => e.amount_cents === cents && (e.entry_date === day || !day) && (toPayout ? /payout wallet/i.test(e.description) : String(e.description).toLowerCase().includes(outflow.to.slice(2, 10))));
  return byAmount ? { how: "amount-date-destination", row: byAmount } : null;
}

/** What a receipt says about how an outflow left: sent by the treasury, pulled by an authorization, or a swap. */
export function mechanism(receipt, outflow) {
  if (!receipt || receipt.notRead) return "mechanism not read";
  const r = receipt.result;
  const sender = lc(r.from);
  const logs = r.logs ?? [];
  const inflowSameTx = logs.map(decodeTransfer).filter(Boolean).filter((t) => t.to === TREASURY && t.from !== TREASURY && ASSETS[t.token]);
  if (inflowSameTx.length) {
    const back = inflowSameTx.map((t) => formatAsset(t.value, t.token)).join(" + ");
    return `a conversion: ${back} came back to the treasury in the same transaction`;
  }
  if (sender === TREASURY) return "a transaction the treasury key signed and sent";
  const auth = logs.find((l) => lc(l.address) === USDC && lc(l.topics?.[0]) === AUTHORIZATION_USED && lc(l.topics?.[1]).endsWith(TREASURY.slice(2)));
  if (auth) return `authorized off-chain by the treasury key (EIP-3009) and submitted by ${short(sender)}`;
  return `moved in a transaction ${short(sender)} sent; mechanism not read`;
}

export async function scheduleD(ctx) {
  const t = ctx.docs.treasury;
  const cpLedger = ctx.docs.checkpoint?.checkpoints?.find((c) => c.log === "ledger");
  const lines = [];
  const readAt = ctx.readAt;
  if (!t) return [line({ ref: "D-1", schedule: "D", state: STATE.UNREAD, why: "not read: GET /treasury did not answer", title: "the books" })];

  // D-1 and D-3 share one read: the treasury's USDC at min(finalized), at two nodes.
  const [usdcNow] = await balancesAt([{ token: USDC, holder: TREASURY }], ctx.minFinal);
  const now = agreedValue(usdcNow.perNode);
  const d1 = tieBalance(usdcNow.perNode, null);
  lines.push(
    line({
      ref: "D-1",
      schedule: "D",
      route: "#/d/1",
      state: d1.state,
      mark: d1.mark,
      why: d1.why,
      title: "spendable USDC in the treasury · docket row treasury-governance (a)",
      sentence: [now !== null ? `The treasury holds ${formatAsset(now, USDC)} at block ${groupInt(ctx.minFinal)}, read at two nodes. A USDC balance needs no claim step; moving it needs the treasury's key.` : "The treasury's USDC balance was not read at two nodes."],
      says: [
        { label: "docket", value: "treasury-governance (a): a non-maintainer third party can recompute, from public methods only, which USDC in the published treasury is spendable without a further claim step", source: "GET /api/docket" },
        { label: "wallet", value: t.wallet?.address ?? TREASURY, source: "GET /treasury → wallet; GET /api/official → treasury", readAt },
      ],
      shows: Object.entries(usdcNow.perNode).map(([node, v]) => ({ node, text: v.notRead ?? `balanceOf = ${v.value} (${formatAsset(v.value, USDC)})` })),
      notVerified: ["that this recomputation closes the docket row: it recomputes (a) only; (b) and (c) are governance", "fees still sitting in a pool, claimable only by the treasury's key: not read here"],
    })
  );

  // D-2 the books fold. A missing checkpoint or a browser without Ed25519 is "not read", never a break.
  let root;
  let unreadWhy = null;
  if (!cpLedger || !ctx.registryKey) unreadWhy = "not read: GET /api/checkpoint did not give a ledger checkpoint and key on this read";
  try {
    root = await verifyLedgerRoot(ctx.registryKey, t.entries ?? [], cpLedger);
  } catch (e) {
    root = { ok: false, steps: { rows_rehash: 0, rows: (t.entries ?? []).filter((r) => r.hash).length, links: false, root: false, signature: false } };
    unreadWhy = e instanceof NotSupported ? "not read in this browser: no Ed25519 in WebCrypto" : `not read: ${e?.message ?? e}`;
  }
  lines.push(
    line({
      ref: "D-2",
      schedule: "D",
      route: "#/d/2",
      state: unreadWhy ? STATE.UNREAD : root.ok ? STATE.TIED : STATE.BROKEN,
      mark: unreadWhy ? "?" : root.ok ? "✓" : "✗",
      why: unreadWhy ?? (root.ok ? "every sealed row rehashes and links, the root folds, the registry key signed it" : "a step failed; see the steps"),
      title: "the sealed rows fold to the signed ledger root",
      sealed: root.ok,
      sentence: [`${root.steps.rows_rehash} of ${root.steps.rows} sealed rows rehash from their own fields and fold to the ledger root the registry key signed (checkpoint ${cpLedger?.id ?? "?"}, tree ${cpLedger?.tree_size ?? "?"}). ${(t.entries ?? []).filter((e) => !e.hash).length} older rows were written before sealing began.`],
      log: [
        { label: `rows rehash (${root.steps.rows_rehash}/${root.steps.rows})`, ok: root.steps.rows_rehash === root.steps.rows },
        { label: "each prev_hash links to the row before it, from 64 zeroes", ok: root.steps.links },
        { label: "RFC 6962 root over the sealed rows equals the signed root", ok: root.steps.root },
        { label: "the registry key signed that root (WebCrypto Ed25519)", ok: root.steps.signature },
      ],
      says: [{ label: "books", value: `${(t.entries ?? []).length} rows, newest dated ${(t.entries ?? [])[0]?.entry_date ?? "?"}`, source: "GET /treasury → entries", readAt }],
      notVerified: ["the tx and source columns: they are outside the sealed bytes, so a row's tx is the registry's word", "rows written before sealing: protected by nothing, in the registry's framing", "that every payment has a row: see D-4"],
    })
  );

  // D-3 onchain_cents. When the registry's own read of the wallet fails it serves onchain_cents: null and says so
  // in assets.errors ("USDC balanceOf did not answer"). A null is not a zero, and a figure the books mark stale is
  // not a reading of now: either one is compared with nothing, and the line says the registry could not read.
  const usdcErr = (Array.isArray(t.assets?.errors) ? t.assets.errors : []).find((e) => /USDC/.test(String(e))) ?? null;
  const centsKnown = t.onchain_cents !== null && t.onchain_cents !== undefined && Number.isSafeInteger(Number(t.onchain_cents)) && t.onchain_checked_at != null;
  const says3 = [{ label: "books", value: `onchain_cents ${t.onchain_cents}, onchain_is_stale ${t.onchain_is_stale}, checked ${t.onchain_checked_at}${usdcErr ? `; assets.errors: “${usdcErr}”` : ""}`, source: "GET /treasury", readAt }];
  if (!centsKnown || usdcErr || t.onchain_is_stale === true) {
    lines.push(
      line({
        ref: "D-3",
        schedule: "D",
        route: "#/d/3",
        state: STATE.BLIND,
        why: !centsKnown ? "the books carry no reading of the wallet on this request (onchain_cents is null)" : usdcErr ? "the books say their own USDC read failed on this request" : "the books mark their own figure stale",
        title: "onchain_cents against the wallet",
        sentence: [`The books could not read their own wallet on this request${usdcErr ? ` (they say: “${usdcErr}”)` : ""}, so there is no figure to tie${centsKnown ? ` (onchain_cents ${groupInt(Number(t.onchain_cents))}${t.onchain_is_stale ? ", marked stale" : ""})` : ""}. This page read the wallet at two nodes: ${now !== null ? formatAsset(now, USDC) : "not read"} (D-1).`],
        says: says3,
        notVerified: ["why the registry's read failed: it does not say beyond the error it prints"],
      })
    );
  } else {
    const cents = Number(t.onchain_cents);
    let d3 = tieBalance(usdcNow.perNode, centsToUsdcAtomic(cents), { tolerance: 9999n });
    // The books do not say which block they read, and this page reads behind finality: a transfer between the two
    // reads would part them honestly. So a difference here is reported, never called a break.
    if (d3.state === STATE.BROKEN) d3 = { state: STATE.UNREAD, mark: "?", why: "the books and the wallet differ beyond a cent; the books do not say which block they read, so a transfer between the two reads could explain it" };
    lines.push(
      line({
        ref: "D-3",
        schedule: "D",
        route: "#/d/3",
        state: d3.state,
        mark: d3.mark,
        why: d3.why,
        title: "onchain_cents against the wallet",
        sentence: [`The books' onchain_cents reads ${groupInt(cents)} (${(cents / 100).toFixed(2)} USDC); the wallet holds ${now !== null ? formatAsset(now, USDC) : "not read"}. The books round to cents.`],
        says: says3,
        notVerified: ["which block the registry read: it does not say, so a transfer between its read and ours can move the numbers apart"],
      })
    );
  }
  if (Array.isArray(t.assets?.errors) && t.assets.errors.length) {
    lines.push(
      line({
        ref: "D-3a",
        schedule: "D",
        route: "#/d/3a",
        state: STATE.BLIND,
        why: "the registry says it could not read its own assets on this request",
        title: "the books could not read their own holdings",
        sentence: [`The books report ${t.assets.errors.length} read error${t.assets.errors.length === 1 ? "" : "s"} for their own holdings on this request (they say so). This page read the wallet itself: see D-1.`],
        says: [{ label: "assets.errors", value: t.assets.errors.join(" · "), source: "GET /treasury → assets.errors", readAt }],
      })
    );
  }

  // D-4 outflows from the baseline + the live stretch
  const base = ctx.baseline;
  const outflows = [];
  if (base) {
    for (const l of base.logs) {
      if (l.from === TREASURY && l.value !== "0" && [USDC, TOKEN, WETH].includes(l.token)) outflows.push({ tx: l.tx, logIndex: l.log_index, token: l.token, to: l.to, value: BigInt(l.value), block: l.block, source: "baseline" });
    }
  }
  const liveNotes = [];
  let liveIn = 0n;
  let liveOut = 0n;
  let liveOk = false;
  if (base && ctx.minFinal > base.to_block) {
    const r = await indexer(`/api/v2/addresses/${TREASURY}/token-transfers?type=ERC-20`);
    if (r.ok) {
      let reachedBaseline = false;
      for (const it of r.json.items ?? []) {
        const block = Number(it.block_number ?? 0);
        const token = lc(it.token?.address_hash ?? it.token?.address);
        if (block <= base.to_block) {
          reachedBaseline = true;
          continue;
        }
        if (block > ctx.minFinal || token !== USDC) continue;
        const v = parseAtomic(it.total?.value) ?? 0n;
        if (lc(it.to?.hash) === TREASURY) liveIn += v;
        if (lc(it.from?.hash) === TREASURY) {
          liveOut += v;
          if (v > 0n) outflows.push({ tx: lc(it.transaction_hash), logIndex: Number(it.log_index), token, to: lc(it.to?.hash), value: v, block, source: "indexer hint" });
        }
      }
      liveOk = reachedBaseline || !r.json.next_page_params;
      if (!liveOk) liveNotes.push("the indexer's newest page did not reach back to the baseline; older live flows were not listed");
    } else liveNotes.push(`the live stretch after block ${base.to_block}: not read (${r.error})`);
  }
  const receipts = outflows.length ? await receiptsAt(outflows.map((o) => o.tx)) : {};
  const entries = t.entries ?? [];
  const items = outflows.map((o) => {
    o.time = blockTime(o.block, ctx.headRef);
    const perNode = Object.fromEntries(Object.entries(receipts).map(([id, byTx]) => [id, readTransfer(byTx[o.tx], o.logIndex)]));
    const tie = decide(perNode, {
      same: (a, b) => a.block === b.block && a.blockHash === b.blockHash && a.transfer?.value === b.transfer?.value && a.transfer?.to === b.transfer?.to,
      matchesClaim: (v) => v.status === "0x1" && v.transfer?.from === TREASURY && v.transfer?.to === o.to && v.transfer?.value === o.value && v.transfer?.token === o.token,
      blockOf: (v) => v.block,
      minFinal: ctx.minFinal,
    });
    const anyReceipt = Object.values(receipts).map((byTx) => byTx[o.tx]).find((a) => a && !a.notRead);
    const how = mechanism(anyReceipt, o);
    const match = matchRow(o, entries);
    return { ...o, tie, how, match, conversion: how.startsWith("a conversion") };
  });
  const named = items.filter((i) => i.match);
  const conversions = items.filter((i) => !i.match && i.conversion);
  const unnamed = items.filter((i) => !i.match && !i.conversion);
  const anyUnread = items.some((i) => i.tie.state !== STATE.TIED);
  lines.push(
    line({
      ref: "D-4",
      schedule: "D",
      route: "#/d/4",
      state: items.length === 0 ? STATE.NIL : anyUnread ? STATE.UNREAD : STATE.TIED,
      why: anyUnread ? "at least one outflow was not tied at two nodes; see its row" : "every outflow listed ties at two nodes",
      title: "outflows from the treasury wallet",
      sentence: [`${items.length} out · ${named.length} named by a row · ${conversions.length} conversion${conversions.length === 1 ? "" : "s"} · ${unnamed.length} named by no row.`],
      says: [
        { label: "the books' rule", value: "Spent only when earned dollars are exhausted, with the same public ledger line as everything else.", source: "GET /treasury → spending_policy.waterfall[1].rule", readAt },
        { label: "window", value: base ? `from block ${groupInt(base.from_block)} (${base.from_block_time}) to ${groupInt(ctx.minFinal)}` : "baseline not loaded", source: "data/baseline.json + live" },
      ],
      extra: { items, named, conversions, unnamed },
      notVerified: ["purpose: this page does not read purpose", "who holds the treasury key: not read here", "anything outside USDC, 1F916 and WETH transfers: native ETH and other tokens are not listed", ...liveNotes],
      cite: `D-4 treasury outflows ${items.length} · named by a row ${named.length} · conversions ${conversions.length} · named by no row ${unnamed.length} · through block ${ctx.minFinal}`,
    })
  );

  // D-5 footing: baseline ends at two nodes, then the live stretch
  if (base) {
    const bal = base.balances?.[TREASURY]?.[USDC];
    const pairs = [{ token: USDC, holder: TREASURY }];
    const [atStart] = await balancesAt(pairs, base.from_block);
    const [atEnd] = await balancesAt(pairs, base.to_block);
    const recordedStart = parseAtomic(Object.values(bal?.at_from_block ?? {}).find((v) => v != null));
    const recordedEnd = parseAtomic(Object.values(bal?.at_to_block ?? {}).find((v) => v != null));
    const tieStart = tieBalance(atStart.perNode, recordedStart);
    const tieEnd = tieBalance(atEnd.perNode, recordedEnd);
    let inflow = 0n;
    let outflow = 0n;
    for (const l of base.logs) {
      if (l.token !== USDC) continue;
      if (l.to === TREASURY) inflow += BigInt(l.value);
      if (l.from === TREASURY) outflow += BigInt(l.value);
    }
    const foots = recordedStart !== null && recordedEnd !== null && recordedStart + inflow - outflow === recordedEnd;
    const endNow = agreedValue(atEnd.perNode);
    // The live stretch after the baseline: true = it foots, false = it does not, null = it was not checked. Only
    // "nothing to check" (the baseline reaches min(finalized)) or a stretch that foots can leave the line tied.
    const liveNeeded = ctx.minFinal > base.to_block;
    const liveFoots = endNow !== null && now !== null && liveOk ? endNow + liveIn - liveOut === now : null;
    if (liveNeeded && liveFoots === null) liveNotes.push(`the ${groupInt(ctx.minFinal - base.to_block)} blocks after the baseline were not footed: ${endNow === null || now === null ? "a balance was not read at two nodes" : "the indexer's list did not cover them"}`);
    const ok = foots && tieStart.state === STATE.TIED && tieEnd.state === STATE.TIED;
    const liveGood = !liveNeeded || liveFoots === true;
    lines.push(
      line({
        ref: "D-5",
        schedule: "D",
        route: "#/d/5",
        state: ok ? (liveGood ? STATE.TIED : STATE.UNREAD) : tieStart.state === STATE.UNREAD || tieEnd.state === STATE.UNREAD ? STATE.UNREAD : STATE.BROKEN,
        why: ok ? (liveGood ? "start + in − out = end, both ends tie at two nodes, and the blocks since foot too" : liveFoots === false ? "the baseline foots; the live stretch does not foot on the indexer's list" : "the baseline foots; the live stretch after it was not footed on this read") : `${tieStart.why}; ${tieEnd.why}`,
        title: "the footing: the treasury's USDC flows add up to its balance",
        sentence: [
          `Start ${recordedStart !== null ? formatAsset(recordedStart, USDC) : "?"} + in ${formatAsset(inflow, USDC)} − out ${formatAsset(outflow, USDC)} = ${recordedStart !== null ? formatAsset(recordedStart + inflow - outflow, USDC) : "?"}; the wallet held ${recordedEnd !== null ? formatAsset(recordedEnd, USDC) : "?"} at block ${groupInt(base.to_block)}. ${foots ? "It foots." : "It does not foot."}${liveFoots === null ? "" : liveFoots ? ` The ${groupInt(ctx.minFinal - base.to_block)} blocks since also foot.` : ` The ${groupInt(ctx.minFinal - base.to_block)} blocks since do not foot on the indexer's list.`}`,
        ],
        shows: [
          ...Object.entries(atStart.perNode).map(([node, v]) => ({ node: `${node} @${base.from_block}`, text: v.notRead ?? String(v.value) })),
          ...Object.entries(atEnd.perNode).map(([node, v]) => ({ node: `${node} @${base.to_block}`, text: v.notRead ?? String(v.value) })),
        ],
        says: [{ label: "baseline", value: `${base.logs.length} logs, built ${base.built_at}, blocks ${base.from_block}–${base.to_block}, ${base.method}`, source: "data/baseline.json (rebuild: node tools/build-baseline.mjs)" }],
        notVerified: [...(base.limits ?? []), ...liveNotes],
      })
    );
  }
  ctx.treasuryUnnamed = unnamed;
  return lines;
}
