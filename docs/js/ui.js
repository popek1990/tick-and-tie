// DOM building. Every node is made with createElement and every string goes in through textContent; there is no
// innerHTML anywhere on this page, and the CSP enforces Trusted Types so an accident would throw instead of render.
// Citizen text (handles, titles, token symbols, ledger descriptions) is untrusted: it is isolated in <bdi>, hidden
// characters are shown as visible tokens (⟨U+202C POP DIRECTIONAL FORMATTING⟩), and URLs in it stay inert text.
// Links are built only by safeLink() from validated parts.

import { reveal, isAddress, lc, short, overlap, isTxHash } from "./codec.js";
import { LABEL, SHORT, STATE, footing } from "./lines.js";
import { NODES } from "./net.js";

const SVGNS = "http://www.w3.org/2000/svg";
const HANDLE = /^[A-Za-z0-9_.-]{1,64}$/;

export function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "href") throw new Error("links go through safeLink()");
      else if (k.startsWith("on")) throw new Error("no inline handlers");
      else n.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    n.append(typeof k === "string" || typeof k === "number" ? document.createTextNode(String(k)) : k);
  }
  return n;
}

/**
 * Where a link may point, or null: an internal #/ route, a citizen's record, a tx or address on the explorer, a
 * registry path. Pure, so the tests can throw hostile values at it.
 */
export function linkHref(kind, value) {
  if (typeof value !== "string") return null;
  if (kind === "route") return /^#\/[A-Za-z0-9/_.-]*$/.test(value) ? { href: value, external: false } : null;
  if (kind === "citizen") return HANDLE.test(value) && !/^\.+$/.test(value) ? { href: `https://1f916.ai/api/citizen/${encodeURIComponent(value)}`, external: true } : null;
  if (kind === "tx") return isTxHash(value) ? { href: `https://base.blockscout.com/tx/${lc(value)}`, external: true } : null;
  if (kind === "address") return isAddress(value) ? { href: `https://base.blockscout.com/address/${lc(value)}`, external: true } : null;
  if (kind === "api") return /^\/(api\/[A-Za-z0-9/_.?=&-]+|treasury)$/.test(value) && !value.includes("..") ? { href: `https://1f916.ai${value}`, external: true } : null;
  return null;
}

/** The only way a link is made. A value linkHref() refuses becomes inert text in an <a> with no href. */
export function safeLink(kind, value, label) {
  const target = linkHref(kind, value);
  const href = target?.href ?? null;
  const external = target?.external ?? false;
  const a = document.createElement("a");
  if (!href) {
    a.textContent = label ?? String(value);
    return a;
  }
  a.setAttribute("href", href);
  if (external) {
    a.setAttribute("rel", "noopener noreferrer");
    a.setAttribute("referrerpolicy", "no-referrer");
    a.className = "ext";
  }
  a.textContent = label ?? String(value);
  return a;
}

/** Untrusted text, isolated and with hidden characters made visible. */
export function bdi(text, max = 400, cls = "quoted", { strict = false } = {}) {
  const b = el("bdi", { class: cls });
  for (const seg of reveal(text, max, { strict })) {
    if (seg.text !== undefined) b.append(document.createTextNode(seg.text));
    else if (seg.hidden) b.append(el("span", { class: "cp", title: seg.hidden, text: `⟨${seg.hidden}⟩` }));
    else if (seg.note) b.append(el("span", { class: "trunc", text: seg.note }));
  }
  return b;
}

export function glyph(state, label) {
  const name = { [STATE.TIED]: "tied", [STATE.BROKEN]: "broken", [STATE.BLIND]: "blind", [STATE.UNREAD]: "unread", [STATE.PENDING]: "pending", [STATE.NIL]: "nil", clock: "clock", forgery: "forgery", sealed: "sealed" }[state] ?? "nil";
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", `glyph g-${name}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label ?? LABEL[state] ?? name);
  const use = document.createElementNS(SVGNS, "use");
  use.setAttribute("href", `#g-${name}`);
  svg.append(use);
  return svg;
}

/** A mark: the glyph plus, for ½ and ≠, the small sign that says why it is not a tick. */
export function markEl(line) {
  const state = line.mark === "⏱" ? "clock" : line.mark === "◆" ? "forgery" : line.state;
  const wrap = el("span", { class: `mark m-${line.state}`, title: line.why || LABEL[line.state] });
  wrap.append(glyph(state, `${LABEL[line.state] ?? line.state}${line.why ? ": " + line.why : ""}`));
  if (line.mark === "½" || line.mark === "≠") wrap.append(el("span", { class: "sub", text: line.mark }));
  return wrap;
}

let knownHandles = new Set();
export const setKnownHandles = (s) => (knownHandles = s);

/** A handle: an internal link to the trail when the handle is in the data this page read; inert text otherwise. */
export function handleEl(h) {
  const wrap = el("span", { class: "handle" });
  if (typeof h === "string" && HANDLE.test(h) && knownHandles.has(h)) {
    wrap.append(safeLink("route", `#/p/${h}`, h));
  } else wrap.append(bdi(h, 64));
  return wrap;
}

/** An address. Forgeries are unselectable, never linked, and say DO NOT PAY. */
export function addrEl(a, { full = false, forgery = false, compareTo = null } = {}) {
  if (!isAddress(a)) return bdi(String(a), 64);
  if (forgery) {
    const w = el("span", { class: "addr forged", "aria-label": `forged address ending ${a.slice(-4)}; do not pay` });
    const x = lc(a).slice(2);
    const ov = compareTo ? overlap(compareTo, a) : { prefix: 0, suffix: 0 };
    w.append("0x");
    for (let i = 0; i < 40; i++) {
      const same = i < ov.prefix || i >= 40 - ov.suffix;
      w.append(el("span", { class: same ? "copied" : "diff", text: x[i] }));
      if (i % 4 === 3 && i < 39) w.append(el("span", { class: "gap", text: " " }));
    }
    w.append(el("span", { class: "dnp", text: "DO NOT PAY" }));
    return w;
  }
  const s = el("span", { class: "addr", title: lc(a) });
  s.append(safeLink("address", a, full ? lc(a) : short(lc(a))));
  return s;
}

export function sentenceEl(parts) {
  const p = el("p", { class: "sentence" });
  for (const part of parts) {
    if (typeof part === "string") p.append(part);
    else if (part?.handle) p.append(handleEl(part.handle));
    else if (part?.symbol !== undefined) p.append(bdi(part.symbol, 32, "quoted symbol", { strict: true }));
    else if (part?.addr) p.append(addrEl(part.addr));
  }
  return p;
}

export function footingEl(lines, label = "footing", code = "") {
  const bar = el("p", { class: "footing", "aria-label": label });
  // Clocks (F) and forgery exhibits (G) are not money claims, so they are counted, not footed.
  if (code === "F") return bar.append(el("span", { class: "ft" }, glyph("clock"), ` ${lines.length} clock${lines.length === 1 ? "" : "s"}, not in the footing`)), bar;
  if (code === "G") return bar.append(el("span", { class: "ft m-broken" }, glyph("forgery"), ` ${lines.length} exhibit${lines.length === 1 ? "" : "s"}, not in the footing`)), bar;
  const f = footing(lines);
  for (const s of [STATE.TIED, STATE.BROKEN, STATE.BLIND, STATE.UNREAD, STATE.PENDING, STATE.NIL]) {
    if (!f[s]) continue;
    bar.append(el("span", { class: `ft m-${s}` }, glyph(s), ` ${f[s]} ${SHORT[s]}`));
  }
  return bar;
}

// ---- lines ------------------------------------------------------------------------------------------------

let drawerLines = [];
export function renderLine(line, { onOpen } = {}) {
  const art = el("article", { class: `line s-${line.state}${line.folded ? " folded" : ""}`, id: `line-${line.ref}` });
  const ref = safeLink("route", line.route, line.ref);
  ref.className = "ref";
  const openBtn = el("button", { type: "button", class: "proof", "aria-label": `open the proof for ${line.ref}` }, "proof ›");
  openBtn.addEventListener("click", () => onOpen?.(line));
  art.append(el("div", { class: "gutter" }, markEl(line), line.sealed ? el("span", { class: "sealmark", title: "sealed in the society's signed log" }, glyph("sealed", "sealed in the society's signed log")) : null));
  art.append(
    el(
      "div",
      { class: "body" },
      el("h3", { class: "ltitle" }, ref, " · ", bdi(line.title, 160, "title")),
      sentenceEl(line.sentence),
      line.why ? el("p", { class: "why", text: line.why }) : null
    )
  );
  art.append(el("div", { class: "act" }, openBtn));
  return art;
}

/** A forgery exhibit: the real address and the forgery stacked, copied characters dimmed, differing ones red. */
function exhibitEl(x) {
  const sec = el("section", { class: "d-exhibit" }, el("h4", { text: "THE EXHIBIT" }));
  const row = (k, ...v) => sec.append(el("div", { class: "row" }, el("span", { class: "k", text: k }), el("span", { class: "v" }, ...v)));
  if (x.mimic) {
    row("the real one", addrEl(x.mimic.real, { full: true }), el("span", { class: "muted", text: ` ${x.mimic.label}` }));
    row("the forgery", addrEl(x.mimic.fake, { forgery: true, compareTo: x.mimic.real }));
    row("what it copies", el("span", { class: "mono", text: `the first ${x.mimic.prefix} and the last ${x.mimic.suffix} of 40 hex characters, the ones a hurried eye checks` }));
  }
  const seen = new Set();
  for (const e of x.items ?? []) {
    if (e.kind !== "counterfeit" || seen.has(e.token)) continue;
    seen.add(e.token);
    row("the token", `${short(e.token)} calls itself `, bdi(e.symbol, 32, "quoted symbol", { strict: true }), `. It is not ${e.pretends}. Any contract can emit a Transfer that names any sender.`);
  }
  return sec;
}

// ---- the proof drawer (native <dialog>: Esc closes it, focus returns) ---------------------------------------

export function openDrawer(line, all = drawerLines) {
  drawerLines = all;
  const d = document.getElementById("drawer");
  d.replaceChildren();
  const idx = all.indexOf(line);
  const close = el("button", { type: "button", class: "close", "aria-label": "close" }, "✕ close");
  close.addEventListener("click", () => d.close());
  const prev = el("button", { type: "button", class: "nav", disabled: idx <= 0 }, "‹ prev");
  const next = el("button", { type: "button", class: "nav", disabled: idx < 0 || idx >= all.length - 1 }, "next ›");
  prev.addEventListener("click", () => openDrawer(all[idx - 1], all));
  next.addEventListener("click", () => openDrawer(all[idx + 1], all));

  const says = el("section", { class: "d-says" }, el("h4", { text: "THE SOCIETY SAYS" }));
  for (const s of line.says) says.append(el("div", { class: "row" }, el("span", { class: "k", text: s.label }), el("span", { class: "v" }, bdi(s.value, 1200, "quoted")), el("span", { class: "src", text: `${s.source}${s.readAt ? " · read " + s.readAt : ""}` })));
  const shows = el("section", { class: "d-shows" }, el("h4", { text: "THE CHAIN SHOWS" }));
  if (!line.shows.length) shows.append(el("p", { class: "muted", text: "nothing read on Base for this line" }));
  const nodeName = (id) => (NODES[id] ? `${new URL(NODES[id].url).host} (${NODES[id].operator})` : id);
  for (const s of line.shows) shows.append(el("div", { class: "row" }, el("span", { class: "k", text: nodeName(s.node) }), el("span", { class: "v mono", text: s.text })));
  const log = el("section", { class: "d-log" }, el("h4", { text: "THE SOCIETY'S LOG" }));
  if (!line.log.length) log.append(el("p", { class: "muted", text: "no log check on this line" }));
  for (const s of line.log) log.append(el("div", { class: `row ${s.ok === true ? "ok" : s.ok === false ? "bad" : "unk"}` }, el("span", { class: "k" }, glyph(s.ok === true ? STATE.TIED : s.ok === false ? STATE.BROKEN : STATE.UNREAD)), el("span", { class: "v", text: s.label })));
  const nv = el("section", { class: "d-nv" }, el("h4", { text: "NOT VERIFIED" }), el("ul", null, line.notVerified.map((t) => el("li", { text: t }))));
  const extra = line.extra?.exhibit ? exhibitEl(line.extra) : null;
  const cite = line.cite ? el("section", { class: "d-cite" }, el("h4", { text: "CITE" }), el("pre", { text: `${line.cite}\n${location.origin}${location.pathname}${line.route}` })) : null;

  d.append(
    ...[
      el("header", { class: "d-head" }, el("h2", { id: "drawer-title", tabindex: "-1" }, markEl(line), ` ${line.ref} · `, bdi(line.title, 160, "title")), el("div", { class: "d-nav" }, prev, next, close)),
      el("p", { class: "d-why", text: `${LABEL[line.state]}${line.why ? ": " + line.why : ""}` }),
      extra,
      says,
      shows,
      log,
      nv,
      cite,
    ].filter(Boolean)
  );
  if (!d.open) d.showModal();
  d.querySelector("h2")?.focus?.();
}

/** A schedule: heading, the footing over ALL its lines, then the first `show` lines (all when omitted). */
export function scheduleSection(code, title, sub, lines, { onOpen, intro, show } = {}) {
  const s = el("section", { class: "schedule", id: `sched-${code}`, "aria-labelledby": `h-${code}` });
  s.append(el("h2", { id: `h-${code}` }, el("span", { class: "code", text: code }), ` ${title}`));
  if (sub) s.append(el("p", { class: "sub", text: sub }));
  if (intro) s.append(intro);
  if (lines?.length) {
    s.append(footingEl(lines, `${code} footing`, code));
    for (const l of lines.slice(0, show ?? lines.length)) s.append(renderLine(l, { onOpen: (x) => onOpen?.(x, lines) }));
  }
  return s;
}

export function stamp(text, cls = "") {
  return el("span", { class: `stamp ${cls}`, text });
}

export function table(headers, rows, cls = "") {
  const t = el("table", { class: cls });
  t.append(el("thead", null, el("tr", null, headers.map((h) => el("th", { scope: "col", text: h })))));
  const tb = el("tbody");
  for (const r of rows) tb.append(el("tr", null, r.map((c) => el("td", null, c))));
  t.append(tb);
  return el("div", { class: "scroll" }, t);
}
