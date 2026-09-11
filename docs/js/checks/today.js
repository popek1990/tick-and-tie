// "Today on the rail": at most three items, picked by rule rather than taste, each something the maintainer can
// act on. The rule, in order:
//   1. any observer mark more than a day behind finality → the observer, diagnosed (its own next call, replayed);
//   2. any award the registry marks owed with no receipt → who is owed, since when;
//   3. listing 23's routes against its clocks → who cannot be paid if picked.
// Nothing about the treasury is ever picked here; the books are schedule D, last.

import { replay, KEYED_RANGE } from "./observer.js";
import { groupInt, short } from "../codec.js";

export async function today(ctx, { cLines, fLines, lLines }) {
  const items = [];
  const marks = ctx.docs.rail?.observer?.marks ?? [];
  const never = marks.filter((m) => !Number.isInteger(m.last_block)).length;
  const behind = marks.filter((m) => Number.isInteger(m.last_block) && ctx.minFinal && ctx.minFinal - m.last_block > 43_200).sort((a, b) => b.last_block - a.last_block);
  if (behind.length) {
    const m = behind[0]; // the most recent mark: its next call is the one the observer is making now
    const r = await replay(m, ctx.minFinal);
    const days = behind.map((x) => Math.round(((ctx.minFinal - x.last_block) * 2) / 86400));
    const lo = Math.min(...days);
    const hi = Math.max(...days);
    const span = lo === hi ? `${lo} days` : `${lo} to ${hi} days`;
    const unseen = (ctx.observerPayments ?? []).length;
    items.push({
      key: "observer",
      ref: "C",
      route: `#/c/${m.funder_address.toLowerCase()}`,
      head: `The registry's payment observer is ${span} behind on ${behind.length} of the ${marks.length} wallets it watches${never ? `, and has never finished a read of ${never === 1 ? "one more" : `${never} more`}` : ""}.`,
      body: [
        `Its next question (eth_getLogs over ${groupInt(KEYED_RANGE)} blocks from ${short(m.funder_address)}), asked here just now:`,
        ...Object.entries(r.wide).map(([node, s]) => `${node}: ${s}`),
        `${r.wideAnswered} of ${Object.keys(r.wide).length} public nodes answer at that width, and the observer needs two to agree. Over 1,000 blocks: ${Object.entries(r.narrow).map(([n, s]) => `${n} ${s}`).join("; ")}.`,
        unseen ? `Meanwhile Base shows ${unseen} payment${unseen === 1 ? "" : "s"} to bound addresses that the rail does not (schedule C).` : "",
      ].filter(Boolean),
      notVerified: "what the observer's keyed endpoint answers, and whether Cloudflare's egress sees the same limits as this browser: not read",
      replay: r,
    });
  }
  for (const f of fLines.filter((l) => l.ref.startsWith("F-") && l.ref !== "F-23").slice(0, 1)) {
    items.push({ key: "owed", ref: f.ref, route: f.route, head: f.sentence, body: [], line: f });
  }
  const table = lLines.find((l) => l.ref === "L-routes");
  if (table) items.push({ key: "l23", ref: "L", route: "#/l", head: table.sentence, body: ["Conflict: this page's author bids on listing 23. Its own row is printed first."], line: table });
  return items.slice(0, 3);
}
