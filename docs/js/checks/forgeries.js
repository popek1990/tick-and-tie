// Schedule G · FORGERIES: the ghosts around the society's wallets.
//
// Address poisoning plants lookalike addresses in a wallet's history (same first few and last four characters)
// so that someone who copies an address from history pays the wrong one. Counterfeit tokens copy a real symbol,
// sometimes with an invisible character in it. The maintainer's own rule: "Pay only to the address on the binding,
// never one copied from wallet history" (c47657).
//
// Folded into campaigns, not one line per address: lookalikes of listing 23's routes first (the next payment the
// judge makes), then one line per real token a counterfeit imitates, then zero-value transfers of real tokens.
// Each exhibit is counted in one line. The drawer lists every lookalike pair.
//
// This schedule never makes a forgery easier to copy: forged addresses are printed unselectable, labelled DO NOT
// PAY, and never put in a CITE block. It reports what the indexer lists; it cannot say who did it or why.

import { indexer } from "../net.js";
import { lc, isAddress, isLookalike, overlap, counterfeitOf, reveal, short, parseAtomic, plural, ASSETS } from "../codec.js";
import { line, STATE } from "../lines.js";

/** Up to `max` labels, then "and N more". */
function listOf(labels, max = 4) {
  const l = labels.length > max ? [...labels.slice(0, max), `${labels.length - max} more`] : labels;
  return l.length > 1 ? `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}` : l[0] ?? "";
}

/** Fold exhibits into campaign lines. Pure, so the tests can feed it hand-made exhibits. */
export function foldExhibits(exhibits) {
  const used = new Set();
  const groups = [];
  const take = (key, title, list, extra = {}) => {
    const fresh = list.filter((e) => !used.has(e));
    if (!fresh.length) return;
    fresh.forEach((e) => used.add(e));
    groups.push({ key, title, items: fresh, ...extra });
  };
  take("l23", "lookalikes of routes filed on listing 23", exhibits.filter((e) => e.mimic?.kind === "l23"));
  const byPretends = new Map();
  for (const e of exhibits) if (e.kind === "counterfeit") byPretends.set(e.pretends, [...(byPretends.get(e.pretends) ?? []), e]);
  for (const [pretends, list] of [...byPretends].sort((a, b) => b[1].length - a[1].length)) take(`fake-${pretends}`, `tokens that are not ${pretends} but call themselves ${pretends}`, list, { pretends });
  take("zero", "zero-value transfers of real tokens, next to lookalikes", exhibits.filter((e) => e.kind === "zero-value"));
  take("other", "other transfers involving lookalikes", exhibits);
  return groups;
}

function sentenceOf(g) {
  const mimics = [...new Map(g.items.filter((e) => e.mimic).map((e) => [e.mimic.fake, e.mimic])).values()];
  const reals = [...new Set(mimics.map((m) => m.label))];
  const n = g.items.length;
  if (g.key === "l23") {
    const handles = [...new Set(mimics.map((m) => m.handle).filter(Boolean))];
    return [`${plural(mimics.length, "lookalike address", "lookalike addresses")} copy routes filed on listing 23 (`, ...handles.flatMap((h, i) => [i ? ", " : "", { handle: h }]), `), in ${plural(n, "transfer")}. Whoever pays listing 23: pay the address on the binding, never one from wallet history (c47657).`];
  }
  if (g.pretends) {
    const symbols = [...new Set(g.items.map((e) => e.symbol))];
    const contracts = new Set(g.items.map((e) => e.token)).size;
    return [
      `A token that is not ${g.pretends} calls itself `,
      ...symbols.slice(0, 3).flatMap((s, i) => [i ? " / " : "", { symbol: s }]),
      symbols.length > 3 ? ` (and ${symbols.length - 3} more spellings)` : "",
      `: ${plural(n, "transfer")} from ${plural(contracts, "contract")}${mimics.length ? `, involving ${plural(mimics.length, "lookalike address", "lookalike addresses")} of ${listOf(reals)}` : ""}. Any contract can emit a Transfer that names any sender.`,
    ];
  }
  if (g.key === "zero") {
    const tokens = [...new Set(g.items.map((e) => ASSETS[e.token]?.symbol ?? short(e.token)))];
    return [`${plural(n, "zero-value transfer")} of real ${tokens.join(" and ")} between the society's wallets and ${plural(mimics.length, "lookalike address", "lookalike addresses")} of ${listOf(reals)}. A zero-value transfer puts the lookalike into the wallet's history, where a hurried copy picks it up.`];
  }
  return [`${plural(n, "other transfer")} involving ${plural(mimics.length, "lookalike address", "lookalike addresses")} of ${listOf(reals)}.`];
}

export async function scheduleG(ctx, wallets, knownPayees) {
  const known = new Map([...wallets.map((w) => [lc(w.address), { label: w.label, kind: "wallet" }]), ...knownPayees.map((p) => [lc(p.address), { label: p.label, kind: p.kind ?? "payee", handle: p.handle ?? null }])]);
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
      for (const [addr, k] of known) {
        for (const side of [to, from]) {
          if (isLookalike(side, addr)) mimic = { real: addr, fake: side, label: k.label, kind: k.kind, handle: k.handle ?? null, ...overlap(addr, side) };
        }
      }
      if (fake) exhibits.push({ kind: "counterfeit", token, symbol, pretends: fake, from, to, value, tx, block, wallet: w, mimic });
      else if (mimic && ASSETS[token] && value === 0n) exhibits.push({ kind: "zero-value", token, symbol: ASSETS[token].symbol, from, to, value, tx, block, wallet: w, mimic });
      else if (mimic) exhibits.push({ kind: "lookalike", token, symbol, from, to, value, tx, block, wallet: w, mimic });
    }
  }
  exhibits.sort((a, b) => b.block - a.block);
  const lines = foldExhibits(exhibits).map((g, i) => {
    const mimics = [...new Map(g.items.filter((e) => e.mimic).map((e) => [e.mimic.fake, e.mimic])).values()];
    return line({
      ref: `G-${i + 1}`,
      schedule: "G",
      route: `#/g/${i + 1}`,
      state: STATE.NIL,
      mark: "◆",
      why: "an exhibit, not a money claim",
      title: g.title,
      handles: g.key === "l23" ? [...new Set(mimics.map((m) => m.handle).filter(Boolean))] : [],
      sentence: sentenceOf(g),
      says: g.items.slice(0, 8).map((e) => ({
        label: `block ${e.block}`,
        value: `${e.kind}: ${e.symbol} ${e.value === 0n ? "0" : String(e.value)} atomic, ${short(e.from)} → ${short(e.to)}, token ${short(e.token)}, tx ${short(e.tx)}`,
        source: `GET base.blockscout.com /api/v2/addresses/${short(e.wallet.address)}/token-transfers`,
        kind: "indexer",
      })),
      extra: { exhibit: true, mimics, items: g.items },
      notVerified: ["who made these or why: not read", "whether anyone was fooled: not read", "anything beyond what the indexer lists: one indexer page per wallet was read", ...(g.items.length > 8 ? [`${g.items.length - 8} more transfers in this exhibit are counted, not listed`] : [])],
    });
  });
  return { lines, notes, count: exhibits.length };
}

export { reveal };
