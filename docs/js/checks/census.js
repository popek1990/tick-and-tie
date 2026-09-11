// The census through the money lens: one dot per citizen, marked by the furthest money state reached.
//
// The maintainer wrote it as prose in #1916: "Ninety-nine of you did work here. Three got paid." This view computes
// that sentence live, for every citizen, and checks the "paid" half on Base: a receipt counts only if schedule A
// tied it at two nodes, and "paid with no receipt" counts only transfers schedule C tied to a bound address.
//
// Cost: the citizen list is 1,000 rows per page (3 pages today) plus two event lists. It is read once per visit.

import { registry } from "../net.js";
import { STATE } from "../chain.js";

export const LEVELS = Object.freeze([
  Object.freeze({ key: "none", label: "registered, no money trail" }),
  Object.freeze({ key: "handed", label: "handed in work" }),
  Object.freeze({ key: "routed", label: "filed a payout route" }),
  Object.freeze({ key: "paid-unseen", label: "paid on Base, no receipt (tied at two nodes)" }),
  Object.freeze({ key: "receipted", label: "holds a receipt, tied on both ledgers" }),
]);

async function allCitizens() {
  const rows = [];
  let since = null;
  let total = null;
  for (let page = 0; page < 6; page++) {
    const r = await registry(since === null ? "/api/citizens" : `/api/citizens?since=${encodeURIComponent(since)}`);
    if (!r.ok) return { rows, total, complete: false, error: r.error };
    rows.push(...(r.json.citizens ?? []));
    total = r.json.total ?? total;
    if (!r.json.has_more) return { rows, total, complete: true };
    since = r.json.next_since;
  }
  return { rows, total, complete: false, error: "stopped after 6 pages" };
}

export async function census(ctx) {
  const [cit, subs, binds] = await Promise.all([allCitizens(), registry("/api/events?kind=listing-submission"), registry("/api/events?kind=payout-binding")]);
  const level = new Map();
  const bump = (handle, k) => {
    if (!handle) return;
    const i = LEVELS.findIndex((l) => l.key === k);
    if ((level.get(handle) ?? 0) < i) level.set(handle, i);
  };
  const eventsComplete = (r) => r.ok && r.json.has_more === false;
  for (const e of subs.ok ? subs.json.events : []) bump(e.citizen, "handed");
  for (const e of binds.ok ? binds.json.events : []) bump(e.citizen, "routed");
  for (const p of ctx.observerPayments ?? []) for (const b of p.match?.bindings ?? []) bump(b.handle, "paid-unseen");
  for (const l of ctx.receiptLines ?? []) if (l.state === STATE.TIED) for (const h of l.handles) bump(h, "receipted");

  const seen = new Set(cit.rows.map((c) => c.handle));
  const dots = cit.rows
    .slice()
    .sort((a, b) => a.created_at - b.created_at || a.citizen_id - b.citizen_id)
    .map((c) => ({ handle: c.handle, id: c.citizen_id, level: level.get(c.handle) ?? 0 }));
  const count = (k) => dots.filter((d) => LEVELS[d.level].key === k).length;
  const atLeast = (k) => dots.filter((d) => d.level >= LEVELS.findIndex((l) => l.key === k)).length;
  const summary = {
    total: cit.total ?? dots.length,
    read: dots.length,
    complete: cit.complete,
    handed: atLeast("handed"),
    routed: atLeast("routed"),
    receipted: count("receipted"),
    paidUnseen: count("paid-unseen"),
    eventsComplete: eventsComplete(subs) && eventsComplete(binds),
    notInList: [...level.keys()].filter((h) => !seen.has(h)),
  };
  return { dots, summary, error: cit.error ?? null };
}
