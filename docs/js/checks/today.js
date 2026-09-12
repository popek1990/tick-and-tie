// "Today on the rail": at most three items, picked by rule rather than taste, each something the registry can act
// on. The rule, in order:
//   1. any observer mark more than a day behind finality → the observer, diagnosed (its own next call, replayed);
//   2. any award the registry marks due with no receipt → who is due, since when;
//   3. listing 23's routes against its clocks → who cannot be paid if picked, and until when they can fix it.
// Nothing about the treasury is ever picked here; the books are schedule D, last.
//
// Each item is built as soon as its own inputs land (the first in about five seconds); the observer item gains
// schedule C's count when C finishes.

import { replay, KEYED_RANGE, CAPPED_RANGE, catchUp, cycleMinutesOf, hoursText, BLOCK_SECONDS } from "./observer.js";
import { groupInt, short, plural } from "../codec.js";

const DAY_BLOCKS = 43_200; // one day at BLOCK_SECONDS

/** Item 1, with its replay: needs only GET /api/rail and the finalized head. Null when no mark is behind. */
export async function observerItem(ctx) {
  const marks = ctx.docs.rail?.observer?.marks ?? [];
  if (!ctx.minFinal || !marks.length) return null;
  const never = marks.filter((m) => !Number.isInteger(m.last_block));
  const behind = marks.filter((m) => Number.isInteger(m.last_block) && ctx.minFinal - m.last_block > DAY_BLOCKS).sort((a, b) => b.last_block - a.last_block);
  if (!behind.length && !never.length) return null;
  const current = marks.length - behind.length - never.length;
  // Blocks → days assumes Base's 2-second block, so this is an estimate and says so, exactly as schedule C does.
  const days = behind.map((x) => Math.round(((ctx.minFinal - x.last_block) * BLOCK_SECONDS) / 86400));
  const lo = Math.min(...days);
  const hi = Math.max(...days);
  const span = lo === hi ? `≈${lo} ${lo === 1 ? "day" : "days"}` : `≈${lo} to ${hi} days`;
  const counts = [
    behind.length ? `${behind.length} ${behind.length === 1 ? "is" : "are"} ${span} behind finality` : null,
    current ? `${current} ${current === 1 ? "is" : "are"} current` : null,
    never.length ? `${never.length} ${never.length === 1 ? "has" : "have"} never been read` : null,
  ].filter(Boolean);
  const countText = counts.length > 1 ? `${counts.slice(0, -1).join(", ")}, and ${counts[counts.length - 1]}` : counts[0];
  const lead = behind.length ? "The registry's payment observer is behind." : "The registry's payment observer has a wallet it has never read.";
  const item = { key: "observer", ref: "C", head: `${lead} It watches ${plural(marks.length, "wallet")}: ${countText}.`, body: [], notVerified: "what the observer's keyed endpoint answers, and whether Cloudflare's egress sees the same limits as this browser: not read" };
  const m = behind[0];
  if (!m) {
    item.route = `#/c/${never[0].funder_address.toLowerCase()}`;
    item.body.push(`The wallet it has never read: ${short(never[0].funder_address)}, last attempt “${String(never[0].last_error ?? "no error given").slice(0, 120)}”.`);
    return item;
  }
  item.route = `#/c/${m.funder_address.toLowerCase()}`;
  const r = await replay(m, ctx.minFinal); // the most recent mark: its next call is the one the observer is making now
  item.replay = r;
  item.body.push(`Its next question (eth_getLogs over ${groupInt(KEYED_RANGE)} blocks from ${short(m.funder_address)}), put just now to its own public providers, in its order:`);
  for (const [node, s] of Object.entries(r.wide)) item.body.push(`${node}: ${s}`);
  item.body.push(`${r.wideAnswered} of ${Object.keys(r.wide).length} answer at that width, and the observer needs two to agree. Over 1,000 blocks: ${Object.entries(r.narrow).map(([n, s]) => `${n} ${s}`).join("; ")}.`);
  if (/-32614|2,000 range/.test(r.wide.base ?? "")) {
    item.body.push(
      "Why, from the source: src/observer.ts asks 10,000 blocks a cycle when a keyed endpoint is set (OBSERVER_BLOCKS_PER_CYCLE_KEYED); its comment says Infura and mainnet.base.org both took that width when measured on 2026-09-08. mainnet.base.org now caps eth_getLogs at 2,000 (its answer above; uriel met the same cap on 2026-09-10, #4689), so the keyed voice has no second voice at 10,000 blocks. That is what “no two providers agreed (1 answered)” on each mark says. Asked in 2,000-block pages, the keyed voice and mainnet.base.org could both answer again."
    );
  } else item.body.push("From the source: src/observer.ts asks 10,000 blocks a cycle when a keyed endpoint is set (OBSERVER_BLOCKS_PER_CYCLE_KEYED). The answers above show which public providers accept that width from here, today.");
  const throttled = marks.filter((x) => /HTTP 429/.test(String(x.last_error ?? ""))).length;
  if (throttled) item.body.push(`${throttled} of the marks end their last_error with HTTP 429, the limit the maintainer traced to Cloudflare Workers' egress at mainnet.base.org on 2026-08-07 (c1574). last_error keeps only the last provider's message, and this browser does not share that egress.`);
  const cycle = cycleMinutesOf(ctx.docs.rail?.observer?.walk_note);
  const worst = Math.max(...behind.map((x) => ctx.minFinal - x.last_block));
  const fast = catchUp(worst, marks.length, cycle, KEYED_RANGE);
  const slow = catchUp(worst, marks.length, cycle, CAPPED_RANGE);
  if (fast && slow) item.body.push(`Catching up the furthest mark (${groupInt(worst)} blocks), as arithmetic on the rail's walk_note (one wallet per ${cycle}-minute cycle, ${marks.length} wallets): ${hoursText(fast.hours)} at ${groupInt(KEYED_RANGE)} blocks a cycle, ${hoursText(slow.hours)} at ${groupInt(CAPPED_RANGE)}.`);
  return item;
}

/** Items 1–3 from whatever has landed so far. Pure. */
export function todayItems(ctx, { observer, cLines, fLines, lLines }) {
  const items = [];
  if (observer) {
    const it = { ...observer, body: [...observer.body] };
    const pays = ctx.observerPayments;
    if (cLines && pays) {
      const who = new Set(pays.map((p) => p.handle)).size;
      if (pays.length) it.body.push(`Meanwhile Base shows ${plural(pays.length, "payment")} after the marks by the registry's own rule, tied at two nodes and with no receipt, to ${plural(who, "citizen")} (schedule C). The rail counts none of them yet.`);
    } else it.body.push("Schedule C is still walking these wallets; its count of payments after the marks lands below.");
    items.push(it);
  }
  for (const f of (fLines ?? []).filter((l) => l.ref.startsWith("F-") && l.ref !== "F-23").slice(0, 1)) items.push({ key: "due", ref: f.ref, route: f.route, head: f.sentence, body: [], line: f });
  const table = (lLines ?? []).find((l) => l.ref === "L-routes");
  if (table) items.push({ key: "l23", ref: "L", route: "#/l", head: table.sentence, body: ["Conflict: this page's author bids on listing 23. Its own row is printed first."], line: table });
  return items.slice(0, 3);
}
