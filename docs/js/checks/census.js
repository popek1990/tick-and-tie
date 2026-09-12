// The census through the money lens: one dot per citizen, marked by the furthest money state reached.
//
// The maintainer wrote it as prose in #1916: "Ninety-nine of you did work here. Three got paid." This view computes
// that sentence live, for every citizen, and checks the "paid" half on Base: a receipt counts only if schedule A
// tied it at two nodes, and "paid with no receipt" counts only payments schedule C tied, by the registry's own rule,
// to citizens who hold no receipt at all.
//
// Each count is a count of citizens, from one source: "handed in work" from listing-submission events only,
// "filed a payout route" from payout-binding events only. The rail's own totals (submissions, bindings, receipts:
// counts of records, not of citizens) are printed beside them.
//
// Cost: the citizen list is 1,000 rows per page (3 pages today) plus two event lists. It is read once per visit.

import { registry } from "../net.js";
import { STATE } from "../chain.js";
import { groupInt, readError } from "../codec.js";

export const LEVELS = Object.freeze([
  Object.freeze({ key: "none", label: "registered, no money trail" }),
  Object.freeze({ key: "handed", label: "handed in work" }),
  Object.freeze({ key: "routed", label: "filed a payout route" }),
  Object.freeze({ key: "paid-unseen", label: "paid on Base, no receipt at all (tied at two nodes)" }),
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

/**
 * The furthest state per handle, and the citizen counts, from already-read inputs. Pure, for the tests.
 *
 * `observerPayments` and `receiptLines` are the money half, and they arrive with schedules C and A — long after the
 * citizen list. Pass **null** for them while they are unread, and `[]` only once a schedule has actually run and
 * found nothing. Null is not zero: with it the two paid states are not assigned to anyone, and their counts come
 * back null so no sentence can print an unread schedule as "nobody was paid". Both go together, because
 * "paid with no receipt at all" can only be decided against the set of receipt holders.
 */
export function censusOf({ citizens, submissions, bindings, observerPayments = null, receiptLines = null }) {
  const moneyRead = Array.isArray(observerPayments) && Array.isArray(receiptLines);
  const level = new Map();
  const bump = (handle, k) => {
    if (!handle) return;
    const i = LEVELS.findIndex((l) => l.key === k);
    if ((level.get(handle) ?? 0) < i) level.set(handle, i);
  };
  const handed = new Set(submissions.map((e) => e.citizen).filter(Boolean));
  const routed = new Set(bindings.map((e) => e.citizen).filter(Boolean));
  const unseen = new Set(moneyRead ? observerPayments.map((p) => p.handle).filter(Boolean) : []);
  const holders = new Set(moneyRead ? receiptLines.flatMap((l) => l.handles ?? []) : []);
  for (const h of handed) bump(h, "handed");
  for (const h of routed) bump(h, "routed");
  if (moneyRead) {
    for (const h of unseen) if (!holders.has(h)) bump(h, "paid-unseen");
    for (const l of receiptLines) if (l.state === STATE.TIED) for (const h of l.handles) bump(h, "receipted");
  }
  const dots = citizens
    .slice()
    .sort((a, b) => a.created_at - b.created_at || a.citizen_id - b.citizen_id)
    .map((c) => ({ handle: c.handle, id: c.citizen_id, level: level.get(c.handle) ?? 0 }));
  const inList = new Set(citizens.map((c) => c.handle));
  const count = (k) => dots.filter((d) => LEVELS[d.level].key === k).length;
  return {
    dots,
    moneyRead,
    // One count per level, of the dots themselves: the field draws this array, so the sentence that reads it and
    // the picture cannot disagree. Note these are levels (the furthest state reached), not the sets below.
    byLevel: LEVELS.map((_, i) => dots.filter((d) => d.level === i).length),
    counts: {
      handed: [...handed].filter((h) => inList.has(h)).length,
      routed: [...routed].filter((h) => inList.has(h)).length,
      receipted: moneyRead ? count("receipted") : null,
      paidUnseen: moneyRead ? count("paid-unseen") : null,
      unseenCitizens: moneyRead ? unseen.size : null,
    },
    notInList: [...level.keys()].filter((h) => !inList.has(h)),
  };
}

/**
 * The page's first claim, and the only sentence here that is about the whole population rather than about money:
 * every citizen the registry lists carries one mark, and the mark is the furthest state its own records reach.
 *
 * It reads `byLevel`, the same array the dot field draws, so the count and the picture are one source. Pure.
 * While the money half is unread the two paid states are not printed at all — an unread schedule must never
 * appear as a population of zero.
 */
export function populationLine(s) {
  const n = (i) => groupInt(s.byLevel?.[i] ?? 0);
  const lead = s.complete
    ? `All ${groupInt(s.total)} citizens the registry lists carry one mark here`
    : `${groupInt(s.read)} of the ${groupInt(s.total)} citizens the registry lists were read on this visit, each carrying one mark here`;
  // "No further than" is load-bearing. These are levels, so a citizen is counted once, at the furthest state they
  // reached — while the headline under this sentence counts every citizen in every state they reached. Without the
  // phrase the two sentences read as a contradiction ("31 handed in work" over "108 handed in work") and the page
  // loses on its own ground: the one thing it sells is that its numbers can be checked against each other.
  const states = [`${n(0)} with no money trail at all`, `${n(1)} who got no further than handing in work`, `${n(2)} no further than a filed payout route`];
  if (s.moneyRead) states.push(`${n(3)} paid on Base with no receipt at all`, `${n(4)} holding a receipt that ties on both ledgers`);
  const tail = s.moneyRead
    ? " Every mark opens, and the two paid states are ones this page tied against Base at two nodes, not ones the registry asserts."
    : " The two paid states are still being read (schedules A and C), so no citizen is counted at them yet. Every mark opens.";
  return `${lead}, in join order, set to the furthest state the society's own records reach: ${states.join(", ")}.${tail}`;
}

/**
 * The one census sentence, from the summary alone: pure, and the only copy, so the page and the terminal say the
 * same thing. Two different reads can make a count a lower bound, and they hedge different halves of it:
 *   - the citizen list read in part → every count here is a lower bound, because censusOf() counts only citizens
 *     that were actually read (it filters by the list);
 *   - an event list read in part → "handed in work" and "filed a payout route" are lower bounds, and nothing else.
 * A partial read is never stated as a whole number, and the sentence names what was not read.
 */
export function censusHeadline(s) {
  const partial = !s.complete;
  const ev = partial || !s.eventsComplete ? "at least " : "";
  const list = partial ? "at least " : "";
  const lead = partial
    ? `Of ${groupInt(s.total)} citizens, ${groupInt(s.read)} were read on this visit, so these counts are lower bounds: `
    : `Of ${groupInt(s.total)} citizens, `;
  const rest = partial && s.total > s.read ? ` The other ${groupInt(s.total - s.read)} were not read: ${readError(s.notReadWhy)}.` : "";
  const work = `${ev}${groupInt(s.handed)} handed in work and ${ev}${groupInt(s.routed)} filed a payout route`;
  // The money half lands with schedules A and C. Until it does there is no receipt count to state, and stating one
  // would be the page's own worst failure: a schedule that has not run reading as a schedule that found nothing.
  if (s.moneyRead === false) return `${lead}${work}; what the records say about their money is still being read (schedules A and C), so no receipt count is stated yet.${rest}`;
  const paid = s.unseenCitizens
    ? ` Base shows ${groupInt(s.unseenCitizens)} more paid with no receipt for that payment (schedule C); ${list}${groupInt(s.paidUnseen)} of them hold no receipt at all.`
    : "";
  return `${lead}${work}; ${list}${groupInt(s.receipted)} hold a receipt that ties on both ledgers.${paid}${rest}`;
}

/** The census's own reads (the citizen list and two event lists). Started early; census() waits for schedule C. */
export async function readCensusInputs() {
  const [cit, subs, binds] = await Promise.all([allCitizens(), registry("/api/events?kind=listing-submission"), registry("/api/events?kind=payout-binding")]);
  return { cit, subs, binds };
}

/**
 * @param money  false for the early pass, which runs as soon as the citizen list lands so the population line is on
 *               screen in seconds. The full pass runs again once schedules A and C have set their arrays on ctx.
 *               A schedule that threw leaves its array undefined, and that reads as unread here, never as empty.
 */
export async function census(ctx, inputs = null, { money = true } = {}) {
  const { cit, subs, binds } = inputs ?? (await readCensusInputs());
  if (!cit.rows.length) return { dots: [], summary: null, error: `the citizen list was not read (${cit.error ?? "empty"})` };
  const eventsComplete = (r) => r.ok && r.json.has_more === false;
  const c = censusOf({
    citizens: cit.rows,
    submissions: subs.ok ? subs.json.events ?? [] : [],
    bindings: binds.ok ? binds.json.events ?? [] : [],
    observerPayments: money ? ctx.observerPayments ?? null : null,
    receiptLines: money ? ctx.receiptLines ?? null : null,
  });
  const totals = ctx.docs.rail?.totals ?? null;
  const summary = {
    total: cit.total ?? c.dots.length,
    read: c.dots.length,
    complete: cit.complete,
    notReadWhy: cit.error ?? null,
    moneyRead: c.moneyRead,
    byLevel: c.byLevel,
    ...c.counts,
    submissionsRead: subs.ok,
    bindingsRead: binds.ok,
    eventsComplete: eventsComplete(subs) && eventsComplete(binds),
    rail: totals ? { submissions: totals.submissions, bindings: totals.bindings, receipts: totals.receipts } : null,
    notInList: c.notInList,
  };
  return { dots: c.dots, summary, error: cit.error ?? null };
}
