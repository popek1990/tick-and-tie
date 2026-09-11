// The unit of this page: one line per money claim. A line says what the registry SAYS (quoted, with the
// endpoint and read time), what Base SHOWS (per node), what the society's own log proves, one state, and a NOT
// VERIFIED list that is never empty. The UI draws lines; the checks only build them.

import { STATE } from "./chain.js";

export { STATE };

export const MARK = Object.freeze({
  [STATE.TIED]: "✓",
  [STATE.BROKEN]: "✗",
  [STATE.BLIND]: "◐",
  [STATE.UNREAD]: "?",
  [STATE.PENDING]: "◔",
  [STATE.NIL]: "—",
});

export const LABEL = Object.freeze({
  [STATE.TIED]: "tied at two nodes, behind finality",
  [STATE.BROKEN]: "two nodes agree, and not with the claim",
  [STATE.BLIND]: "the registry's figure is not a reading by its own rule",
  [STATE.UNREAD]: "not read (reason given)",
  [STATE.PENDING]: "on chain, not final yet",
  [STATE.NIL]: "nothing on chain to tie",
});

export const SHORT = Object.freeze({
  [STATE.TIED]: "tied",
  [STATE.BROKEN]: "break",
  [STATE.BLIND]: "registry blind",
  [STATE.UNREAD]: "not read",
  [STATE.PENDING]: "pending",
  [STATE.NIL]: "nothing to tie",
});

/**
 * @param {object} p
 * @param {string} p.ref       stable reference, e.g. "A-2"; also the route #/a/2
 * @param {string} p.schedule  "A" | "C" | "L" | "F" | "G" | "D"
 * @param {string} p.state     one of STATE
 * @param {string} p.title     short title (may contain untrusted text; the UI renders it as text)
 * @param {Array}  p.sentence  the one-line finding: an array of parts, strings or {handle}/{addr}/{amount} tokens
 */
export function line(p) {
  const l = {
    ref: p.ref,
    schedule: p.schedule,
    route: p.route ?? `#/${p.schedule.toLowerCase()}/${p.ref.split("-").slice(1).join("-")}`,
    state: p.state,
    mark: p.mark ?? MARK[p.state],
    why: p.why ?? "",
    title: p.title ?? "",
    sentence: p.sentence ?? [],
    says: p.says ?? [], // [{label, value, source}]
    shows: p.shows ?? [], // [{label, perNode: {node: text}, verdict}]
    log: p.log ?? [], // [{label, ok: true|false|null, detail}]
    sealed: p.sealed ?? null, // true when the society-log proof passed
    notVerified: p.notVerified?.length ? p.notVerified : ["that the nodes that answered are independent: assumed"],
    calls: p.calls ?? [],
    handles: p.handles ?? [],
    cite: p.cite ?? "",
    extra: p.extra ?? null,
    folded: p.folded ?? false,
  };
  return Object.freeze(l);
}

/** Footing: counts per state for a list of lines. */
export function footing(lines) {
  const f = { [STATE.TIED]: 0, [STATE.BROKEN]: 0, [STATE.BLIND]: 0, [STATE.UNREAD]: 0, [STATE.PENDING]: 0, [STATE.NIL]: 0 };
  for (const l of lines) f[l.state]++;
  return f;
}
