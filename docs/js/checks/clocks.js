// Schedule F · CLOCKS: money that is due, and routes that are running out.
//
// These are registry facts and arithmetic, not chain ties (⏱). An award the registry marks payable with no receipt
// is money the registry itself says is due (its own field: economics.currently_due_atomic). The wallet the listing
// names as its funder is read at two nodes as context; a listing that names none says so.

import { registry } from "../net.js";
import { balancesAt, tieBalance, agreedValue } from "../chain.js";
import { fromMs, isoMin, span, formatAsset, parseAtomic, lc, short, isAddress } from "../codec.js";
import { line, STATE } from "../lines.js";

export async function scheduleF(ctx) {
  const rail = ctx.docs.rail;
  const lines = [];
  const due = (rail?.listings ?? []).filter((l) => parseAtomic(l.economics?.currently_due_atomic) > 0n);
  const details = [];
  for (const l of due) {
    const d = ctx.listingDetail ? await ctx.listingDetail(l.listing_id) : await registry(`/api/listings/${l.listing_id}`);
    if (d?.ok) details.push({ l, d });
  }
  // One balance read per funder wallet a due listing names (in the listing's own token), all in one batch.
  const pairs = [...new Map(details.filter(({ d }) => isAddress(d.json.funder_address)).map(({ d }) => [`${lc(d.json.funder_address)}:${lc(d.json.token)}`, { token: lc(d.json.token), holder: lc(d.json.funder_address) }])).values()];
  const reads = pairs.length ? await balancesAt(pairs, ctx.minFinal) : [];
  for (const { l, d } of details) {
    const wallet = isAddress(d.json.funder_address) ? lc(d.json.funder_address) : null;
    const payer = wallet ? reads.find((r) => r.holder === wallet && r.token === lc(d.json.token)) ?? null : null;
    for (const a of d.json.awards ?? []) {
      if (a.receipt_id || !["payable", "overdue_unpaid", "awarded"].includes(a.state)) continue;
      const sub = (d.json.submissions ?? []).find((s) => s.id === a.submission_id);
      const handle = sub?.handle ?? "?";
      const since = fromMs(a.payable_at);
      const ready = fromMs(a.ready_at);
      const amount = formatAsset(parseAtomic(a.amount_atomic), d.json.token);
      const payerVal = payer ? agreedValue(payer.perNode) : null;
      const now = fromMs(rail.now) ?? new Date();
      lines.push(
        line({
          ref: `F-${l.listing_id}-${a.award_id}`,
          schedule: "F",
          state: STATE.NIL,
          mark: "⏱",
          why: "an award the registry marks due, with no receipt",
          title: `listing ${l.listing_id} · award ${a.award_id} · ${handle}`,
          handles: [handle],
          sentence: [{ handle }, ` is due ${amount} on listing ${l.listing_id} (award ${a.award_id}): ${a.state} since ${isoMin(since)}${ready ? `, ready to pay since ${isoMin(ready)}` : ""}. No receipt yet, ${span(now - (ready ?? since))} on.`],
          says: [
            { label: "award", value: `state ${a.state}, amount ${amount}, payable_at ${isoMin(since)}, ready_at ${isoMin(ready)}, ready_payout_address ${a.ready_payout_address ?? "null"}, receipt_id ${a.receipt_id ?? "null"}, expires ${isoMin(fromMs(a.expires_at))}`, source: `GET /api/listings/${l.listing_id} → awards`, readAt: ctx.readAt },
            { label: "funder wallet", value: wallet ?? "the listing names none", source: `GET /api/listings/${l.listing_id} → funder_address`, readAt: ctx.readAt },
          ],
          shows: payer
            ? Object.entries(payer.perNode).map(([node, v]) => ({ node, text: v.notRead ?? `the listing's funder wallet ${short(wallet)} holds ${formatAsset(v.value, payer.token) ?? String(v.value)} at block ${ctx.minFinal}` })).concat([{ node: "context", text: `${tieBalance(payer.perNode, null).why}${payerVal !== null ? `; enough to pay: ${payerVal >= (parseAtomic(a.amount_atomic) ?? 0n) ? "yes" : "no"}` : ""}` }])
            : [{ node: "context", text: "the listing names no funder wallet, so there is no balance to read; schedule A shows which wallet paid its other awards, if any" }],
          notVerified: ["why no receipt exists yet: nothing on the record says", "that the ready address is controlled by the payee: nothing on chain says until money moves"],
        })
      );
    }
  }
  if (ctx.l23?.firstLapse || ctx.l23?.close) {
    const L = ctx.l23;
    lines.push(
      line({
        ref: "F-23",
        schedule: "F",
        route: "#/l",
        state: STATE.NIL,
        mark: "⏱",
        why: "clock facts from the listing's own record",
        title: "listing 23 · the clocks",
        sentence: [`Submissions close ${isoMin(L.close)}. The declared decision window ends ${isoMin(L.decideBy)}, and no code evaluates it. ${L.submitters - L.withRoute} of ${L.submitters} submitters hold no route that lives past it; a route can be filed until ${isoMin(L.close)}.`],
        says: [{ label: "listing", value: "expiry and requester_timeout_seconds", source: "GET /api/listings/23", readAt: ctx.readAt }],
        notVerified: ["when the funder will decide: the registry says nothing enforces it"],
      })
    );
  }
  return lines;
}
