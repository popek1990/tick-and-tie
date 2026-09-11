// Schedule F · CLOCKS: money that is due, and routes that are running out.
//
// These are registry facts and arithmetic, not chain ties (⏱). An award that is payable with no receipt is money
// the registry itself says is owed. The wallet that paid a listing's other awards is read at two nodes as
// context, labelled as not named by the listing.

import { registry } from "../net.js";
import { balancesAt, tieBalance, agreedValue } from "../chain.js";
import { fromMs, isoMin, span, formatAsset, parseAtomic, lc, short, USDC } from "../codec.js";
import { line, STATE } from "../lines.js";

const PAYOUT_WALLET = "0xf32c99ae17c17022889b2288749ca433a2504211";

export async function scheduleF(ctx) {
  const rail = ctx.docs.rail;
  const lines = [];
  const due = (rail?.listings ?? []).filter((l) => parseAtomic(l.economics?.currently_due_atomic) > 0n);
  const payerReads = due.length ? await balancesAt([{ token: USDC, holder: PAYOUT_WALLET }], ctx.minFinal) : [];
  for (const l of due) {
    const d = ctx.listingDetail ? await ctx.listingDetail(l.listing_id) : await registry(`/api/listings/${l.listing_id}`);
    if (!d?.ok) continue;
    for (const a of d.json.awards ?? []) {
      if (a.receipt_id || !["payable", "overdue_unpaid", "awarded"].includes(a.state)) continue;
      const sub = (d.json.submissions ?? []).find((s) => s.id === a.submission_id);
      const handle = sub?.handle ?? "?";
      const since = fromMs(a.payable_at);
      const ready = fromMs(a.ready_at);
      const amount = formatAsset(parseAtomic(a.amount_atomic), d.json.token);
      const payer = payerReads[0];
      const payerVal = payer ? agreedValue(payer.perNode) : null;
      const now = fromMs(rail.now) ?? new Date();
      lines.push(
        line({
          ref: `F-${l.listing_id}-${a.award_id}`,
          schedule: "F",
          state: STATE.NIL,
          mark: "⏱",
          why: "an award the registry marks owed, with no receipt",
          title: `listing ${l.listing_id} · award ${a.award_id} · ${handle}`,
          handles: [handle],
          sentence: [{ handle }, ` is owed ${amount} on listing ${l.listing_id} (award ${a.award_id}): ${a.state} since ${isoMin(since)}${ready ? `, ready to pay since ${isoMin(ready)}` : ""}. No receipt, ${span(now - (ready ?? since))} on.`],
          says: [
            { label: "award", value: `state ${a.state}, amount ${amount}, payable_at ${isoMin(since)}, ready_at ${isoMin(ready)}, ready_payout_address ${a.ready_payout_address ?? "null"}, receipt_id ${a.receipt_id ?? "null"}, expires ${isoMin(fromMs(a.expires_at))}`, source: `GET /api/listings/${l.listing_id} → awards`, readAt: ctx.readAt },
          ],
          shows: payer
            ? [{ node: "context", text: `the wallet that paid this listing's other awards, ${short(PAYOUT_WALLET)} (not named by the listing), holds ${payerVal !== null ? formatAsset(payerVal, USDC) : "not read"} at block ${ctx.minFinal} · ${tieBalance(payer.perNode, null).why}` }]
            : [],
          notVerified: ["why it is unpaid: nothing on the record says", "that the ready address is controlled by the payee: nothing on chain says until money moves"],
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
        sentence: [`Submissions close ${isoMin(L.close)}. The declared decision window ends ${isoMin(L.decideBy)}, and no code evaluates it. ${L.submitters - L.withRoute} of ${L.submitters} submitters hold no route that lives past it.`],
        says: [{ label: "listing", value: "expiry and requester_timeout_seconds", source: "GET /api/listings/23", readAt: ctx.readAt }],
        notVerified: ["when the funder will decide: the registry says nothing enforces it"],
      })
    );
  }
  return lines;
}
