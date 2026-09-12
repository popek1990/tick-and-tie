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
import { STATE } from "../chain.js";

const DAY_BLOCKS = 43_200; // one day at BLOCK_SECONDS

/**
 * A dated reading of the observer's own next question, recorded from an ordinary host on 2026-09-12, each cell
 * asked twice. It is here because the explanation must not depend on what one reader's network is told: from a
 * datacenter, or behind a throttle, mainnet.base.org answers HTTP 429 instead of naming its 2,000-block cap —
 * the same limit the maintainer traced to Cloudflare Workers' egress (c1574) — and a reader who got the 429
 * would otherwise lose the source citation along with it. Verbatim, and never used in place of a live answer.
 */
export const RECORDED = Object.freeze({
  at: "2026-09-12T15:00Z",
  query: "eth_getLogs { address: the 1F916 token, all topics }, one window, each width asked twice",
  wide: Object.freeze({
    "mainnet.base.org": "HTTP 413, error -32614: eth_getLogs is limited to a 2,000 range",
    "base-rpc.publicnode.com": "HTTP 403, error -32602: Archive requests require a personal token",
    "base.gateway.tenderly.co": "HTTP 200, error -32602: invalid params",
    "base.drpc.org": "HTTP 400, error 35: ranges over 10000 blocks are not supported on free plan",
  }),
  caps: Object.freeze({
    "mainnet.base.org": "2,001 blocks pass and 2,500 refuse, so its cap is on toBlock − fromBlock ≤ 2,000",
    "base-rpc.publicnode.com": "answers at 5,000, refuses at 10,000",
    "base.gateway.tenderly.co": "answers at 1,000, refuses at 1,500",
    "base.drpc.org": "refuses 500, 1,000, 2,000, 5,000 and 10,000 with that same sentence, so its refusal is not about this width at all",
  }),
  keyed: "An Infura-backed endpoint, reached through a third party's proxy, answered the same 10,000-block question in 282 ms with 261 logs, twice. This page holds no key and cannot repeat that for you; what the registry's own keyed endpoint answers is still not read.",
});

/**
 * Why the observer cannot get two voices, in words that hold whatever this browser was told. `liveBase` is
 * mainnet.base.org's live answer, or null when it was not reached. Pure, so the reader can call it.
 */
export function observerWhy(liveBase) {
  const out = [
    "Why, from the source: src/observer.ts asks 10,000 blocks a cycle when a keyed endpoint is set (OBSERVER_BLOCKS_PER_CYCLE_KEYED); its comment says Infura and mainnet.base.org both took that width when measured on 2026-09-08. mainnet.base.org caps eth_getLogs at 2,000 today (uriel met the same cap on 2026-09-10, #4689), so at 10,000 blocks the keyed voice has no second voice. That is what “no two providers agreed (1 answered)” on each mark says.",
  ];
  const namesTheCap = /-32614|2,000 range/.test(String(liveBase ?? ""));
  if (!namesTheCap) {
    // The reader did not get the cap in words. Say what was recorded, say it is recorded, and say why they may
    // have been told something else — never present the recording as this visit's reading.
    out.push(
      `Your reading above does not carry that cap in words${liveBase ? `: mainnet.base.org told this browser “${String(liveBase).slice(0, 120)}”` : ", because mainnet.base.org was not reached from this browser"}. A throttle answers before a cap does, and HTTP 429 is exactly what the maintainer traced to Workers' egress (c1574). So here is the same question recorded from an ordinary host on ${RECORDED.at}, which is a record and not your reading: ` +
        Object.entries(RECORDED.wide)
          .map(([n, s]) => `${n} — ${s}`)
          .join("; ") +
        "."
    );
  }
  out.push(
    `Each provider's own width, measured the same day: ` +
      Object.entries(RECORDED.caps)
        .map(([n, s]) => `${n} ${s}`)
        .join("; ") +
      ". Asked in pages of 1,000 instead of one question of 10,000, all three of mainnet.base.org, publicnode and tenderly can answer, so two operators could agree again without anyone paying for a node."
  );
  out.push(RECORDED.keyed);
  return out;
}

/**
 * The healed state, printed as a headline instead of as a silence.
 *
 * This function exists because the alternative was returning null: the moment every mark caught up, the page's
 * main finding vanished and Today fell through to the next rule, so the registry fixing the thing this page
 * reported would have read as the page having nothing to say. Good news is news, and it is the one item here that
 * can be checked the same way the complaint was: the block each mark has reached, and whether the rail's own count
 * of observed payments matches what this page finds before that mark. The count arrives with schedule C; until
 * then this says only what the marks themselves say.
 */
function currentItem(ctx, marks) {
  const lowest = Math.min(...marks.map((m) => m.last_block));
  const mins = Math.round(((ctx.finalHead - lowest) * BLOCK_SECONDS) / 60);
  return {
    key: "observer",
    ref: "C",
    route: "#/c",
    healed: true,
    head: `The registry's payment observer is current. It watches ${plural(marks.length, "wallet")} and has read every one of them to within a day of finality; the furthest behind sits at block ${groupInt(lowest)}, about ${groupInt(mins)} minutes off the finalized head this page read.`,
    body: [],
    notVerified: "what the observer's keyed endpoint answers, and whether Cloudflare's egress sees the same limits as this browser: not read",
  };
}

/** Item 1, with its replay: needs only GET /api/rail and the finalized head. Null when the rail has no marks. */
export async function observerItem(ctx) {
  const marks = ctx.docs.rail?.observer?.marks ?? [];
  if (!ctx.finalHead || !marks.length) return null;
  const never = marks.filter((m) => !Number.isInteger(m.last_block));
  const behind = marks.filter((m) => Number.isInteger(m.last_block) && ctx.finalHead - m.last_block > DAY_BLOCKS).sort((a, b) => b.last_block - a.last_block);
  if (!behind.length && !never.length) return currentItem(ctx, marks);
  const current = marks.length - behind.length - never.length;
  // Blocks → days assumes Base's 2-second block, so this is an estimate and says so, exactly as schedule C does.
  const days = behind.map((x) => Math.round(((ctx.finalHead - x.last_block) * BLOCK_SECONDS) / 86400));
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
  const r = await replay(m, ctx.finalHead); // the most recent mark: its next call is the one the observer is making now
  item.replay = r;
  item.body.push(`Its next question (eth_getLogs over ${groupInt(KEYED_RANGE)} blocks from ${short(m.funder_address)}), put just now to its own public providers, in its order:`);
  for (const [node, s] of Object.entries(r.wide)) item.body.push(`${node}: ${s}`);
  item.body.push(`${r.wideAnswered} of ${Object.keys(r.wide).length} answer at that width, and the observer needs two to agree. Over 1,000 blocks: ${Object.entries(r.narrow).map(([n, s]) => `${n} ${s}`).join("; ")}.`);
  for (const l of observerWhy(r.wide.base)) item.body.push(l);
  const throttled = marks.filter((x) => /HTTP 429/.test(String(x.last_error ?? ""))).length;
  if (throttled) item.body.push(`${throttled} of the marks end their last_error with HTTP 429, the limit the maintainer traced to Cloudflare Workers' egress at mainnet.base.org on 2026-08-07 (c1574). last_error keeps only the last provider's message, and this browser does not share that egress.`);
  const cycle = cycleMinutesOf(ctx.docs.rail?.observer?.walk_note);
  const worst = Math.max(...behind.map((x) => ctx.finalHead - x.last_block));
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
    if (observer.healed) {
      // Current is a claim, not a relief, so it gets the same treatment the complaint got: a count, its source,
      // and the schedule that produced it. Comparability comes per wallet from schedule C, because a wallet this
      // page could not walk is not a wallet the rail agrees with.
      const cl = (cLines ?? []).filter((l) => String(l.ref ?? "").startsWith("C-"));
      const ws = (ctx.observerWallets ?? []).filter((w) => w.comparable);
      if (!cl.length) it.body.push("Schedule C is still comparing the rail's own counts against this page's; the result lands below.");
      else if (!ws.length) it.body.push("Schedule C could not compare the rail's counts on this read, so being current is all that is checked here; the reason is on its lines.");
      else {
        const tied = cl.filter((l) => l.state === STATE.TIED).length;
        const railTotal = ws.reduce((s, w) => s + (w.railTotal ?? 0), 0);
        const expectedTotal = ws.reduce((s, w) => s + (w.expectedTotal ?? 0), 0);
        it.body.push(
          tied === cl.length
            ? `Schedule C ties on all ${cl.length}: before each mark this page finds ${plural(expectedTotal, "payment")} the rail must have counted, and the rail counts ${groupInt(railTotal)} on ${plural(ws.length, "wallet")}.`
            : `Schedule C ties on ${tied} of ${cl.length}, and the rest say why on their own lines. Before the marks this page finds ${plural(expectedTotal, "payment")} the rail must have counted, against the rail's ${groupInt(railTotal)}.`
        );
      }
      if (pays?.length) it.body.push(`Base still shows ${plural(pays.length, "payment")} after the marks with no receipt. That is not the observer's debt: a mark only promises what is behind it.`);
    } else if (cLines && pays) {
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
