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
  const lines = exhibits.slice(0, 24).map((e, i) =>
    line({
      ref: `G-${i + 1}`,
      schedule: "G",
      state: STATE.NIL,
      mark: "◆",
      why: "an exhibit, not a money claim",
      title: e.kind === "counterfeit" ? `a token that calls itself ${e.pretends}` : `a lookalike of ${e.mimic?.label ?? "a known address"}`,
      sentence:
        e.kind === "counterfeit"
          ? [`A token that is not ${e.pretends} calls itself `, { symbol: e.symbol }, `, and its Transfer names ${short(e.wallet.address)} (${e.wallet.label}).`]
          : [`A ${e.kind === "zero-value" ? "zero-value " : ""}${e.symbol} Transfer names ${short(e.wallet.address)} (${e.wallet.label}) next to an address that copies the first ${e.mimic.prefix} and last ${e.mimic.suffix} characters of ${e.mimic.label}.`],
      extra: e,
      notVerified: ["who made it or why: not read", "whether anyone was fooled: not read", "anything beyond what the indexer lists: one indexer page per wallet was read"],
    })
  );
  return { lines, notes, count: exhibits.length };
}

export { reveal };
