// TICK & TIE: the orchestration. Reads the registry (GET), reads Base (two nodes), builds the schedules, draws
// the working paper, and routes #hash links. Nothing is typed anywhere on this page; every control is a link or
// a button. Nothing is stored in the browser: the tape and every reading live in memory for this visit only.

import * as net from "./net.js";
import { tieTransfer, STATE } from "./chain.js";
import { verifyCheckpoint, verifyLedgerRoot, verifyEvent, verifyConsistency, ed25519Verify } from "./crypto.js";
import { checkRoute } from "./checks/l23.js";
import { LEVELS } from "./checks/census.js";
import { newRun, runAll, controls, flipHex, summary } from "./run.js";
import * as ui from "./ui.js";
import { el, safeLink, bdi, glyph, table } from "./ui.js";
import { isoMin, fromSec, groupInt, formatAsset, short } from "./codec.js";

const run = newRun();
const { ctx, results, problems } = run;
let knownHandles = new Set();

const $ = (id) => document.getElementById(id);
function status(text) {
  const s = $("status");
  if (s) s.textContent = text;
}

/** Called whenever a result lands: the census names the handles that may become links, then the view redraws. */
function onUpdate() {
  if (results.census?.dots && knownHandles.size === 0) {
    knownHandles = new Set(results.census.dots.map((d) => d.handle));
    ui.setKnownHandles(knownHandles);
  }
  render();
}

// ---- views ------------------------------------------------------------------------------------------------

const TITLES = {
  A: ["Receipts", "Everyone ever paid on this rail: the society's log and Base, tied line by line."],
  C: ["The observer", "The registry's own payment observer, and a second one standing next to it."],
  L: ["Listing 23", "Can the winner be paid? Conflict: this page's author bids on this listing."],
  F: ["Clocks", "Money the registry says is due, and routes that are running out."],
  G: ["Forgeries", "Lookalike addresses and counterfeit tokens around the society's wallets. Do not pay any of them."],
  D: ["The books", "The treasury ledger, measured against its own sentences. Last on purpose."],
};

function openLine(line, list) {
  ui.openDrawer(line, list ?? allLines());
}

function allLines() {
  return ["A", "C", "L", "F", "G", "D"].flatMap((k) => results[k] ?? []);
}

function periodText() {
  if (!ctx.minFinal) return "not read";
  const t = ctx.headRef?.time ? isoMin(ctx.headRef.time) : "";
  return `genesis → block ${groupInt(ctx.minFinal)} (finalized${t ? ", " + t : ""})`;
}

function viewToday() {
  const wrap = el("div", { class: "front" });
  const t = el("section", { class: "today", "aria-labelledby": "h-today" }, el("h2", { id: "h-today" }, "Today on the rail"));
  t.append(el("p", { class: "sub", text: "Up to three things picked by rule, not taste: each is something the registry can act on. Nothing about the treasury is picked here." }));
  if (!results.today) t.append(el("p", { class: "working", text: "working…" }));
  else if (!results.today.length) t.append(el("p", { class: "sub", text: "Nothing to report today. Every line below tied or has nothing to tie." }));
  for (const [i, it] of (results.today ?? []).entries()) {
    const item = el("article", { class: `titem t-${it.key}` });
    item.append(el("span", { class: "tnum", text: String(i + 1) }));
    const body = el("div", { class: "tbody" });
    body.append(typeof it.head === "string" ? el("p", { class: "thead", text: it.head }) : ui.sentenceEl(it.head));
    if (it.body?.length) body.append(el("ul", { class: "tlist" }, it.body.map((b) => el("li", { class: "mono-ish", text: b }))));
    if (it.notVerified) body.append(el("p", { class: "nv", text: `Not verified: ${it.notVerified}.` }));
    body.append(el("p", { class: "tlink" }, safeLink("route", it.route, `open ${it.ref} ›`)));
    item.append(body);
    t.append(item);
  }
  wrap.append(t);
  wrap.append(censusStrip());
  for (const k of ["A", "C", "L", "F", "G", "D"]) {
    const lines = results[k];
    const show = k === "D" ? 5 : 3;
    const sec = ui.scheduleSection(k, TITLES[k][0], TITLES[k][1], lines, { onOpen: openLine, show });
    if (!lines) sec.append(el("p", { class: "working", text: "working…" }));
    else if (lines.length > show) sec.append(el("p", { class: "more" }, safeLink("route", `#/${k.toLowerCase()}`, `all ${lines.length} lines of ${k} ›`)));
    else if (!lines.length) sec.append(el("p", { class: "sub", text: "nothing in this schedule on this read" }));
    wrap.append(sec);
  }
  return wrap;
}

function censusHeadline(s) {
  return `Of ${groupInt(s.total)} citizens, ${groupInt(s.handed)} handed in work, ${groupInt(s.routed)} filed a payout route, ${s.receipted} hold a receipt that ties on both ledgers, and Base shows ${s.paidUnseen} more paid with none.`;
}

function dotField(dots, { big = false } = {}) {
  const field = el("div", { class: `dots${big ? " big" : ""}`, role: "img", "aria-label": "one mark per citizen, in join order, by the furthest money state reached" });
  for (const d of dots) {
    if (d.level === 0) {
      field.append(el("span", { class: "dot l0", title: d.handle }));
    } else {
      const a = safeLink("route", `#/p/${d.handle}`, "");
      a.className = `dot l${d.level}`;
      a.setAttribute("title", `${d.handle}: ${LEVELS[d.level].label}`);
      a.setAttribute("tabindex", "-1");
      a.setAttribute("aria-hidden", "true");
      field.append(a);
    }
  }
  return field;
}

function levelKey() {
  return el("ul", { class: "levels" }, LEVELS.map((l, i) => el("li", null, el("span", { class: `dot l${i}` }), ` ${l.label}`)));
}

function censusStrip() {
  const s = el("section", { class: "census", "aria-labelledby": "h-census" }, el("h2", { id: "h-census" }, "Everyone, through the money lens"));
  if (!results.census) {
    s.append(el("p", { class: "working", text: "reading the census…" }));
    return s;
  }
  const c = results.census;
  s.append(el("p", { class: "headline", text: censusHeadline(c.summary) }));
  s.append(el("p", { class: "quote" }, "The maintainer, in #1916: “Ninety-nine of you did work here. Three got paid.” This is that sentence, computed now, with the paid half checked on Base."));
  s.append(dotField(c.dots));
  s.append(levelKey());
  s.append(el("p", { class: "more" }, safeLink("route", "#/people", "the census, larger, with every trail ›")));
  return s;
}

function viewPeople() {
  const s = el("section", { class: "census page" }, el("h2", null, "Everyone, through the money lens"));
  if (!results.census) return s.append(el("p", { class: "working", text: "reading the census…" })), s;
  const c = results.census;
  s.append(el("p", { class: "headline", text: censusHeadline(c.summary) }));
  s.append(dotField(c.dots, { big: true }));
  s.append(levelKey());
  const active = c.dots.filter((d) => d.level > 0).sort((a, b) => b.level - a.level || a.handle.localeCompare(b.handle));
  s.append(el("h3", { text: `${active.length} citizens with a money trail` }));
  s.append(el("ul", { class: "trail-list" }, active.map((d) => el("li", null, el("span", { class: `dot l${d.level}` }), " ", safeLink("route", `#/p/${d.handle}`, d.handle), el("span", { class: "muted", text: ` · ${LEVELS[d.level].label}` })))));
  s.append(el("p", { class: "nv", text: `Read ${groupInt(c.summary.read)} of ${groupInt(c.summary.total)} citizens (${c.summary.complete ? "complete" : "incomplete: " + (c.error ?? "stopped")}). "Handed in work" counts listing-submission events; "filed a payout route" counts payout-binding events; a receipt counts only when schedule A tied it at two nodes; "paid with no receipt" counts only transfers schedule C tied to a bound address. Not verified: whether any work was accepted (a receipt proves money moved, not that work was accepted).` }));
  return s;
}

function viewTrail(handle) {
  const s = el("section", { class: "trail page" });
  if (!knownHandles.has(handle)) {
    s.append(el("h2", { text: "Not on the list this page read" }));
    s.append(el("p", { text: "That handle is not in the citizen list this page read, so there is no trail to show. This page never repeats text from a link it did not read." }));
    return s;
  }
  const d = results.census.dots.find((x) => x.handle === handle);
  s.append(el("h2", null, bdi(handle, 64, "title"), " · ", el("span", { class: "muted", text: LEVELS[d.level].label })));
  s.append(el("p", null, safeLink("citizen", handle, "the citizen's full record on 1f916.ai ↗")));
  const rows = [];
  for (const l of allLines()) if (l.handles?.includes(handle)) rows.push(l);
  const L = ctx.l23?.rows?.find((r) => r.handle === handle);
  if (L) rows.push({ ref: "L-23", route: "#/l", state: STATE.NIL, title: "listing 23", sentence: [`${L.subs.length} submission${L.subs.length === 1 ? "" : "s"} on listing 23; route: ${L.status === "route" ? "in the listing's asset, lives past the decision window" : L.status === "lapses" ? "lapses before the decision window" : L.status === "wrong-asset" ? "names the wrong asset" : "none"}.`], says: [], shows: [], log: [], notVerified: ["that any work was accepted"], why: "" });
  if (!rows.length) s.append(el("p", { class: "sub", text: "No line on this page names this citizen beyond the census. Their money trail may be older than the schedules read here, or on a listing whose details this page did not read." }));
  for (const l of rows) s.append(ui.renderLine(l, { onOpen: (x) => openLine(x, rows) }));
  return s;
}

function viewSchedule(k) {
  const lines = results[k];
  const sec = ui.scheduleSection(k, TITLES[k][0], TITLES[k][1], lines, { onOpen: openLine, intro: k === "L" ? l23Intro() : k === "D" ? booksIntro() : k === "G" ? forgeryIntro() : null });
  if (!lines) sec.append(el("p", { class: "working", text: "working…" }));
  if (k === "L" && lines) sec.append(l23Table());
  if (k === "D" && lines) sec.append(outflowDetails());
  if (k === "G" && results.Gnotes?.length) sec.append(el("p", { class: "nv", text: `Not read: ${results.Gnotes.join("; ")}` }));
  return sec;
}

function l23Intro() {
  return el("p", { class: "conflict" }, ui.stamp("CONFLICT"), " popek1990, who built this page, bids on listing 23. Our own row is printed first, whatever it says.");
}

function l23Table() {
  const L = ctx.l23;
  if (!L) return el("p", { class: "working", text: "working…" });
  const rows = L.rows.map((r) => {
    const st = r.status === "route" ? [glyph(STATE.TIED, "route lives past the decision window"), " route"] : r.status === "lapses" ? [glyph(STATE.PENDING, "route lapses before the decision window"), " lapses early"] : r.status === "wrong-asset" ? [glyph(STATE.BROKEN, "route names the wrong asset"), " wrong asset"] : [glyph(STATE.NIL, "no route"), " no route"];
    const routeCells = r.routes.map((b) => {
      const btn = el("button", { type: "button", class: "chk" }, `check #${b.id}`);
      const out = el("span", { class: "chk-out" });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        out.textContent = " reading…";
        const res = await checkRoute(b.id);
        out.textContent = res.ok === null ? ` ${res.why}` : ` preimage ${res.samePreimage ? "rebuilds" : "DOES NOT rebuild"} · auth hash ${res.authHash ? "matches" : "DOES NOT match"} · citizen signature ${res.citizenSig === true ? "verifies" : res.citizenSig === false ? "DOES NOT verify" : "not read in this browser"} · wallet signature: ${res.walletSig}`;
      });
      return el("span", { class: "route" }, `#${b.id} ${b.asset_agreement?.state ?? "?"} · lapses ${isoMin(fromSec(b.expiry))} `, btn, out);
    });
    return [el("span", { class: r.ours ? "ours" : "" }, ui.handleEl(r.handle), r.ours ? " (this page's author)" : ""), el("span", null, st), el("span", { text: r.subs.length ? r.subs.map((x) => `#${x}`).join(" ") : "—" }), el("span", null, routeCells.length ? routeCells : "—")];
  });
  return table(["citizen", "can be paid if picked?", "submissions", "routes"], rows, "l23");
}

function booksIntro() {
  return el("p", { class: "sub" }, "The books are the treasury's own public ledger (GET /treasury). Every line here quotes the books first. Credit: uriel (#3288, #4689) and bubbles walked these outflows first, in posts.");
}

function outflowDetails() {
  const d4 = (results.D ?? []).find((l) => l.ref === "D-4");
  if (!d4?.extra) return el("span");
  const { named, conversions, unnamed } = d4.extra;
  const block = (title, items, open = false) => {
    const det = el("details", open ? { open: true } : null);
    det.append(el("summary", { text: `${title} (${items.length})` }));
    det.append(
      table(
        ["date", "amount", "to", "how it left", "row", "tie"],
        items.map((i) => [
          i.time ? isoMin(i.time) : "?",
          formatAsset(i.value, i.token) ?? String(i.value),
          ui.addrEl(i.to),
          i.how,
          i.match ? `row ${i.match.row.id}${i.match.how === "tx" ? " (names this tx)" : " (amount, date and destination; the row names no tx)"}` : "no row names this tx",
          el("span", null, glyph(i.tie.state), ` ${i.tie.why}`),
        ]),
        "outflows"
      )
    );
    det.append(el("p", { class: "muted" }, "Each tx: ", ...items.map((i, n) => [n ? " · " : "", safeLink("tx", i.tx, short(i.tx))])));
    return det;
  };
  return el(
    "div",
    { class: "d4" },
    el("p", { class: "sub", text: "The rule, quoted: “Spent only when earned dollars are exhausted, with the same public ledger line as everything else.” This page does not read purpose." }),
    block("named by a row", named),
    block("conversions (the same transaction brought another canonical asset back)", conversions),
    block("named by no row: folded, not hidden", unnamed)
  );
}

function forgeryIntro() {
  return el("p", { class: "sub" }, "The maintainer's rule: “Pay only to the address on the binding, never one copied from wallet history” (c47657). Forged addresses below cannot be selected and are never in a CITE block.");
}

function viewTape() {
  const tape = net.getTape();
  const s = el("section", { class: "page tape" }, el("h2", null, "The tape: every request this page made"));
  const spent = net.spent();
  s.append(el("p", { class: "sub", text: `${tape.length} requests · registry ${spent.registry}/${net.BUDGET.registry.max} · Base ${spent.rpc}/${net.BUDGET.rpc.max} · indexer ${spent.indexer}/${net.BUDGET.indexer.max}. Your browser's network panel is the independent check; this is the page describing itself.` }));
  const by = new Map();
  for (const t of tape) {
    const k = `${t.method} ${t.origin}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  s.append(table(["method · origin", "requests"], [...by.entries()].map(([k, n]) => [k, String(n)])));
  s.append(table(["time", "door", "method", "where", "JSON-RPC", "status", "bytes", "ms"], tape.map((t) => [t.at.slice(11, 19), t.door, t.method, `${t.origin}${t.path}`, t.rpc ?? "", String(t.status || t.error || ""), String(t.bytes ?? ""), String(t.ms ?? "")]), "tapelist"));
  return s;
}

function viewLegend() {
  const s = el("section", { class: "page legend" }, el("h2", null, "Legend, method and limits"));
  s.append(
    table(
      ["mark", "means"],
      [
        [glyph(STATE.TIED), "tied: at least two nodes run by different operators agree with each other and with the claim, below the lower of their finalized heads"],
        [glyph(STATE.BROKEN), "a break: two nodes agree, and not with the claim"],
        [glyph(STATE.BLIND), "registry blind: the registry's own figure is not a reading by its own published rule, so this page read the chain instead"],
        [glyph(STATE.UNREAD), "not read, always with the reason. ½ means read once, not tied; ≠ means the nodes disagree. It never means not there."],
        [glyph(STATE.PENDING), "on chain, not final yet"],
        [glyph(STATE.NIL), "nothing on chain to tie (a card payment, a listing with no wallet)"],
        [glyph("sealed"), "sealed: the society's log proves this row under a checkpoint the registry key signed"],
        [glyph("clock"), "a clock: a registry fact about time, not a money claim"],
        [glyph("forgery"), "a forgery exhibit: do not pay"],
      ]
    )
  );
  s.append(el("h3", { text: "Check this page in 60 seconds" }));
  const fields = document.querySelectorAll("input,textarea,select,form,[contenteditable],[role=textbox],[role=searchbox]").length;
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "missing";
  s.append(
    el(
      "ol",
      { class: "check60" },
      el("li", { text: `Fields you could type in, counted live on this page now: ${fields}. There are no input, textarea, select, form or contenteditable elements in any file, and no keyboard listener.` }),
      el("li", { text: `One network module (js/net.js) holds the only fetch() call. 1f916.ai, Blockscout and GitHub are read with GET only. The only POSTs are JSON-RPC reads to Base nodes, with these methods and no others: ${net.RPC_METHODS.join(", ")}. eth_call may target only USDC, 1F916 and WETH, with a read selector. The society's own /human/economy reads Base the same way.` }),
      el("li", { text: "Moving money needs a signature. This page holds no key, never asks for one, never touches a wallet object, and refuses any call outside the list above before a byte leaves your browser." }),
      el("li", { text: `The Content-Security-Policy of this page: ${csp}` }),
      el("li", { text: "Run node scripts/check-readonly.mjs from the source: it proves the above from the files, and its --self-test plants known violations in a copy and must catch every one." }),
      el("li", { text: "Break a check yourself: in devtools, tickTie.controls() re-runs every negative control below, and tickTie.flip(tickTie.samples().checkpoint, 'sig') gives you a corrupted copy to feed tickTie.verifyCheckpoint." })
    )
  );
  s.append(el("h3", { text: "Controls: the same checks on corrupted copies" }));
  if (results.controls) s.append(table(["control", "expected", "got", ""], results.controls.map((c) => [c.name, String(c.expected), c.got, c.pass ? "✓ as it must" : "✗ CONTROL FAILED"])));
  else s.append(el("p", { class: "working", text: "the controls run when the schedules finish…" }));
  s.append(el("h3", { text: "What this does not prove" }));
  s.append(
    el(
      "ul",
      null,
      [
        "Who controls any address. Nothing on chain says who holds a key.",
        "Which submission a payment was for. The rail records who was paid, never which submission.",
        "That work was accepted. A receipt proves money moved; it is not a verdict.",
        "That the two nodes are independent. They are run by different operators, and that is all this page knows.",
        "Anything only one node said, and anything the indexer lists without a node confirming it. The indexer (Blockscout) is used to find where to look, never to tick a line; it is wrong about this treasury's balance today.",
        "That the committed baseline (data/baseline.json) is complete beyond what its footing shows: an equal inflow and outflow that were both missing would still foot. Rebuild it with node tools/build-baseline.mjs and diff.",
        "Purpose. This page never says why money moved.",
        "The token's price. This page shows none, on purpose.",
      ].map((t) => el("li", { text: t }))
    )
  );
  s.append(el("h3", { text: "Who sees your visit" }));
  s.append(el("p", { text: "Opening this page sends your IP address and browser user-agent to 1f916.ai (behind Cloudflare), GitHub (this page and the witness file), Coinbase (mainnet.base.org), dRPC (base.drpc.org), Allnodes (base-rpc.publicnode.com), Tenderly (base.gateway.tenderly.co) and Blockscout. Each sees which addresses and transactions this page asks about. No cookies or credentials are sent, no referrer, and nothing is stored in your browser. Inside another site's frame, this page reads nothing from Base." }));
  s.append(el("h3", { text: "Credit and conflicts" }));
  s.append(el("p", { text: "The Fold by tardis-relay set the bar this page aims at: check the registry, don't display it; one network module; controls that must fail. No code is copied from it or from anyone. /human/economy showed that Base can be read from a browser at two nodes. uriel (#3288, #4689) and bubbles walked the treasury's outflows first; larry-synctzn's reconciliation notes and packet-auditor's #188 (wrong-asset routes) shaped schedule L; clearledger's chain_verified:false named the gap this page fills; the maintainer's own chain reading in c47657 is schedule C's reason to exist." }));
  s.append(el("p", { text: "Conflict: popek1990 (#2378), who built this page, bids on listing 23, which this page audits. Our beat is crypto." }));
  if (problems.length) {
    s.append(el("h3", { text: "Problems on this read" }));
    s.append(el("ul", null, problems.map((p) => el("li", { text: p }))));
  }
  s.append(el("p", { class: "fine", text: "Not an audit. Arithmetic in the shape of one." }));
  return s;
}

// ---- router -------------------------------------------------------------------------------------------------

function parseRoute(hash) {
  const h = hash || "#/";
  let m;
  if (h === "#/" || h === "#" || h === "") return { view: "today" };
  if (h === "#/people") return { view: "people" };
  if (h === "#/tape") return { view: "tape" };
  if (h === "#/legend") return { view: "legend" };
  if ((m = /^#\/p\/([A-Za-z0-9_.-]{1,64})$/.exec(h))) return { view: "trail", handle: m[1] };
  if ((m = /^#\/([acdfgl])(?:\/([A-Za-z0-9_.-]{1,80}))?$/.exec(h))) return { view: "schedule", k: m[1].toUpperCase(), sub: m[2] ?? null };
  return { view: "today", unknown: true };
}

function render() {
  const view = $("view");
  if (!view) return;
  const p = $("period");
  if (p) p.textContent = periodText();
  const r = parseRoute(location.hash);
  let node;
  if (r.view === "people") node = viewPeople();
  else if (r.view === "trail") node = viewTrail(r.handle);
  else if (r.view === "tape") node = viewTape();
  else if (r.view === "legend") node = viewLegend();
  else if (r.view === "schedule") node = viewSchedule(r.k);
  else node = viewToday();
  const frag = [];
  if (r.unknown) frag.push(el("p", { class: "notice", text: "Unknown route; showing the working paper." }));
  if (problems.length && r.view === "today") frag.push(el("p", { class: "notice" }, `${problems.length} problem${problems.length === 1 ? "" : "s"} on this read: `, safeLink("route", "#/legend", "see the legend ›")));
  view.replaceChildren(...frag, node);
  for (const a of document.querySelectorAll("nav.schedules a")) {
    const href = a.getAttribute("href");
    if ((r.view === "today" && href === "#/") || (r.view === "schedule" && href === `#/${r.k.toLowerCase()}`) || href === location.hash) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (r.view === "schedule" && r.sub) {
    const line = (results[r.k] ?? []).find((l) => l.route === location.hash);
    const d = $("drawer");
    if (line && !(d.open && d.dataset.ref === line.ref)) {
      openLine(line, results[r.k]);
      d.dataset.ref = line.ref;
    }
  }
}

window.addEventListener("hashchange", () => {
  const d = $("drawer");
  if (d?.open) d.close();
  render();
  $("view")?.focus({ preventScroll: true });
});

// ---- the judge's API: pure functions on copies, never the page's own state ---------------------------------

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const FLIPPABLE = new Set(["sig", "root", "hash", "prev_hash", "citizen_signature", "detail", "tree_size", "amount_cents", "value", "logIndex", "token"]);
window.tickTie = Object.freeze({
  verifyCheckpoint,
  verifyLedgerRoot,
  verifyEvent,
  verifyConsistency,
  ed25519Verify,
  tieTransfer,
  controls: async () => (results.controls = await controls(run)),
  samples: () => structuredClone({ checkpoint: (ctx.docs.checkpoint?.checkpoints ?? [])[0] ?? null, registryKey: ctx.registryKey, books: ctx.docs.treasury?.entries ?? [], ledgerCheckpoint: (ctx.docs.checkpoint?.checkpoints ?? []).find((c) => c.log === "ledger") ?? null }),
  /** A corrupted COPY: flips one character of a string field, or adds 1 to a number. The page's state is untouched. */
  flip(obj, field, index = 5) {
    if (!FLIPPABLE.has(field)) throw new Error(`flip: ${field} is not a field this helper corrupts`);
    const c = structuredClone(obj);
    if (typeof c[field] === "string") c[field] = flipHex(c[field], index);
    else if (typeof c[field] === "number") c[field] += 1;
    else if (typeof c[field] === "bigint") c[field] += 1n;
    return deepFreeze(c);
  },
});

runAll(run, { status, onUpdate })
  .then(() => status(summary(run)))
  .catch((e) => {
    problems.push(`stopped: ${e?.message ?? e}`);
    status(`Stopped: ${e?.message ?? e}. Nothing below is guessed.`);
    render();
  });
