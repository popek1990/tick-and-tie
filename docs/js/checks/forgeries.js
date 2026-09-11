// Schedule G · FORGERIES: the ghosts around the society's wallets.
//
// Address poisoning plants lookalike addresses in a wallet's history (same first few and last four characters)
// so that someone who copies an address from history pays the wrong one. Counterfeit tokens copy a real symbol,
// sometimes with an invisible character in it. The maintainer's own rule: "Pay only to the address on the binding,
// never one copied from wallet history" (c47657).
//
// This schedule never makes a forgery easier to copy: forged addresses are printed unselectable, labelled DO NOT
// PAY, and never put in a CITE block. It reports what the indexer lists; it cannot say who did it or why.

import { indexer } from "../net.js";
import { lc, isAddress, isLookalike, overlap, counterfeitOf, reveal, short, parseAtomic, ASSETS } from "../codec.js";
import { line, STATE } from "../lines.js";

export async function scheduleG(ctx, wallets, knownPayees) {
  const known = new Map([...wallets.map((w) => [lc(w.address), w.label]), ...knownPayees.map((p) => [lc(p.address), p.label])]);
  const exhibits = [];
  const notes = [];
  for (const w of wallets) {
    const r = await indexer(`/api/v2/addresses/${lc(w.address)}/token-transfers?type=ERC-20`);
    if (!r.ok) {
      notes.push(`${short(w.address)}: not read (${r.error})`);
      continue;
    }
    for (const it of r.json.items ?? []) {
      const token = lc(it.token?.address_hash ?? it.token?.address);
      const symbol = String(it.token?.symbol ?? "");
      const from = lc(it.from?.hash);
      const to = lc(it.to?.hash);
      const value = parseAtomic(it.total?.value);
      const tx = lc(it.transaction_hash);
      const block = Number(it.block_number);
      if (!isAddress(from) || !isAddress(to)) continue;
      const fake = counterfeitOf(token, symbol);
      // a lookalike of any known address on either side
      let mimic = null;
      for (const [addr, label] of known) {
        for (const side of [to, from]) {
          if (isLookalike(side, addr)) mimic = { real: addr, fake: side, label, ...overlap(addr, side) };
        }
      }
      if (fake) exhibits.push({ kind: "counterfeit", token, symbol, pretends: fake, from, to, value, tx, block, wallet: w, mimic });
      else if (mimic && ASSETS[token] && value === 0n) exhibits.push({ kind: "zero-value", token, symbol: ASSETS[token].symbol, from, to, value, tx, block, wallet: w, mimic });
      else if (mimic) exhibits.push({ kind: "lookalike", token, symbol, from, to, value, tx, block, wallet: w, mimic });
    }
  }
  exhibits.sort((a, b) => b.block - a.block);
  // One exhibit per forged address (or per counterfeit token when no address is mimicked): the same poisoner
  // usually sends a zero-value real-token transfer and a counterfeit one to the same lookalike.
  const groups = new Map();
  for (const e of exhibits) {
    const key = e.mimic ? `addr:${e.mimic.fake}` : `token:${e.token}`;
    if (!groups.has(key)) groups.set(key, { mimic: e.mimic, items: [] });
    groups.get(key).items.push(e);
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const lines = [...groups.values()].slice(0, 24).map((g, i) => {
    const first = g.items[0];
    const zero = g.items.filter((e) => e.kind === "zero-value").length;
    const fakes = g.items.filter((e) => e.kind === "counterfeit");
    const fakeSymbols = [...new Set(fakes.map((e) => e.symbol))];
    const around = [...new Set(g.items.map((e) => e.wallet.label))];
    const parts = [];
    if (zero) parts.push(`${plural(zero, "zero-value transfer")} of a real token`);
    if (fakes.length) parts.push(`${plural(fakes.length, "transfer")} of a token that is not ${fakes[0].pretends} but calls itself `);
    const other = g.items.length - zero - fakes.length;
    if (other) parts.push(plural(other, "other transfer"));
    const sentence = g.mimic
      ? [
          `An address that copies the first ${g.mimic.prefix} and last ${g.mimic.suffix} characters of ${g.mimic.label} appears next to ${around.join(" and ")}: `,
          ...parts.flatMap((t, k) => [k ? "; " : "", t, ...(t.endsWith("calls itself ") ? fakeSymbols.flatMap((sym, j) => [j ? " / " : "", { symbol: sym }]) : [])]),
          ".",
        ]
      : [`A token that is not ${first.pretends} calls itself `, { symbol: first.symbol }, `, in ${plural(g.items.length, "transfer")} naming ${around.join(" and ")}.`];
    return line({
      ref: `G-${i + 1}`,
      schedule: "G",
      route: `#/g/${i + 1}`,
      state: STATE.NIL,
      mark: "◆",
      why: "an exhibit, not a money claim",
      title: g.mimic ? `a lookalike of ${g.mimic.label}` : `a token that calls itself ${first.pretends}`,
      sentence,
      says: g.items.slice(0, 6).map((e) => ({
        label: `block ${e.block}`,
        value: `${e.kind}: ${e.symbol} ${e.value === 0n ? "0" : String(e.value)} atomic, ${short(e.from)} → ${short(e.to)}, token ${short(e.token)}, tx ${short(e.tx)}`,
        source: `GET base.blockscout.com /api/v2/addresses/${short(e.wallet.address)}/token-transfers (a hint, never a tick)`,
      })),
      extra: { exhibit: true, mimic: g.mimic, items: g.items, first },
      notVerified: ["who made it or why: not read", "whether anyone was fooled: not read", "anything beyond what the indexer lists: one indexer page per wallet was read"],
    });
  });
  return { lines, notes, count: exhibits.length };
}

export { reveal };
