// One reading of the rail, with no DOM: the registry's documents (GET), the finalized head, the committed files,
// every schedule as soon as its own inputs land, the census, "today", and the negative controls. The page
// (app.js) draws it; the command line (tools/tick.mjs) prints it. Same modules, same rules, same doors.

import * as net from "./net.js";
import { selfTest } from "./abi.js";
import { heads, tieTransfer, STATE } from "./chain.js";
import { verifyCheckpoint, verifyLedgerRoot, verifyConsistency, NotSupported } from "./crypto.js";
import { scheduleA } from "./checks/receipts.js";
import { scheduleC } from "./checks/observer.js";
import { scheduleL } from "./checks/l23.js";
import { scheduleF } from "./checks/clocks.js";
import { scheduleG } from "./checks/forgeries.js";
import { scheduleD, TREASURY, PAYOUT_WALLET } from "./checks/books.js";
import { census, readCensusInputs } from "./checks/census.js";
import { observerItem, todayItems } from "./checks/today.js";
import { isoSec, fromMs, short, lc, isLookalike, TOKEN } from "./codec.js";

export const LOCAL = Object.freeze({ baseline: "data/baseline.json", bindings: "data/bindings.json", receipts: "data/receipts.json" });

export function newRun() {
  const ctx = { docs: {}, finalHead: null, headRef: null, baseline: null, bindingsIndex: null, readAt: isoSec(new Date()), registryKey: null };
  const detailCache = new Map();
  ctx.listingDetail = (id) => {
    if (!detailCache.has(id)) detailCache.set(id, net.registry(`/api/listings/${id}`));
    return detailCache.get(id);
  };
  return { ctx, results: { A: null, C: null, L: null, F: null, G: null, D: null, census: null, today: null, todayPending: true, controls: null, controlsSkipped: [], Gnotes: [] }, problems: [] };
}

/**
 * @param run      from newRun()
 * @param loadLocal (file) → {ok, json} | {ok:false, error}; the page uses net.local (same origin), the CLI reads disk
 * @param status   (text) → void, progress in words
 * @param onUpdate () → void, called whenever a result lands
 */
export async function runAll(run, { loadLocal = (f) => net.local(f), status = () => {}, onUpdate = () => {} } = {}) {
  const { ctx, results, problems } = run;
  const bad = selfTest();
  if (bad.length) problems.push(`keccak self-test failed for ${bad.join(", ")}: those calls are disabled`);
  const running = new Set(["the registry", "Base's finalized head"]);
  const showRunning = () => status(running.size ? `Reading ${[...running].join(", ")} …` : "Finishing …");
  showRunning();

  // Everything with no input starts at once; each door keeps its own pacing, so this changes the wall time, not
  // the load on any server. /treasury is slow to build and only schedule D needs it, so nothing else waits for it.
  const doc = (name, p) =>
    p.then((r) => {
      if (r.ok) ctx.docs[name] = r.json;
      else problems.push(`GET ${name}: not read (${r.error})`);
      return r;
    });
  const pRail = doc("rail", net.registry("/api/rail")).then((r) => {
    if (r.ok) ctx.readAt = isoSec(fromMs(r.json?.now) ?? new Date());
    running.delete("the registry");
    showRunning();
  });
  const pCheckpoint = doc("checkpoint", net.registry("/api/checkpoint")).then((r) => (ctx.registryKey = r.json?.registry_public_key?.x ?? null));
  const pEvents = doc("receiptEvents", net.registry("/api/events?kind=payout-receipt"));
  const pL23 = doc("listing23", ctx.listingDetail(23)).then((r) => (ctx.docs.listing23Now = r.json?.now));
  const pOfficial = doc("official", net.registry("/api/official")).then((r) => {
    const offTreasury = lc(r.json?.treasury?.address);
    if (offTreasury && offTreasury !== TREASURY) problems.push(`the treasury address this page watches (${short(TREASURY)}) differs from GET /api/official (${short(offTreasury)}): check before trusting schedule D`);
  });
  const pTreasury = doc("treasury", net.registry("/treasury"));
  const pHeads = heads().then((h) => {
    ctx.finalHead = h.finalHead;
    ctx.heads = h;
    ctx.headRef = ["base", "tenderly", "drpc"].map((id) => h.per[id]).find((v) => v?.number) ?? null;
    if (!ctx.finalHead) problems.push("no archive node answered the finalized head: chain lines below read as not read");
    for (const p of h.problems ?? []) problems.push(p);
    running.delete("Base's finalized head");
    showRunning();
  });
  const loaded = Promise.all([LOCAL.baseline, LOCAL.bindings, LOCAL.receipts].map((f) => Promise.resolve(loadLocal(f)).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))));
  const pLocal = loaded.then(([b, bi]) => {
    if (b.ok && b.json?.kind === "tick-and-tie.baseline.v1") ctx.baseline = b.json;
    else problems.push(`${LOCAL.baseline}: not read (${b.error ?? "unexpected kind"})`);
    if (bi.ok && bi.json?.kind === "tick-and-tie.bindings.v1") ctx.bindingsIndex = bi.json;
    else problems.push(`${LOCAL.bindings}: not read (${bi.error ?? "unexpected kind"}); schedule C reads every listing live`);
  });
  const pReceiptsIndex = loaded.then(([, , rc]) => {
    if (rc.ok && rc.json?.kind === "tick-and-tie.receipts.v1") ctx.receiptsIndex = rc.json;
    else problems.push(`${LOCAL.receipts}: not read (${rc.error ?? "unexpected kind"}); schedule A reads every receipt live`);
  });

  // "Today" is rebuilt whenever one of its inputs lands, so its first item shows in seconds, not at the end.
  let observer = null;
  const refreshToday = () => (results.today = todayItems(ctx, { observer, cLines: results.C, fLines: results.F, lLines: results.L }));
  const step = async (key, deps, fn) => {
    await Promise.all(deps);
    running.add(`schedule ${key}`);
    showRunning();
    try {
      results[key] = await fn();
    } catch (e) {
      problems.push(`schedule ${key} stopped: ${e?.message ?? e}`);
      results[key] = [];
    }
    running.delete(`schedule ${key}`);
    showRunning();
    refreshToday();
    onUpdate();
  };
  // L before F (F reads L's clocks); A before C (C sets receipts apart) and before G (G watches A's payees).
  const pL = step("L", [pRail, pL23], async () => scheduleL(ctx));
  const pObserver = Promise.all([pRail, pHeads]).then(async () => {
    try {
      observer = await observerItem(ctx);
    } catch (e) {
      problems.push(`today: ${e?.message ?? e}`);
    }
    refreshToday();
    onUpdate();
  });
  const pF = step("F", [pRail, pHeads, pL], () => scheduleF(ctx));
  const pA = step("A", [pRail, pEvents, pCheckpoint, pHeads, pReceiptsIndex], () => scheduleA(ctx));
  const pC = step("C", [pA, pLocal], () => scheduleC(ctx));
  const pG = step("G", [pA, pL23], () => forgeries(run));
  const pD = step("D", [pTreasury, pLocal, pHeads, pCheckpoint], () => scheduleD(ctx));
  // The citizen list is not behind the rail: it does not need it, it is what the page's first sentence is built
  // from, and it reaches the slow list lane before anything else wants a turn (the listing and binding reads
  // cannot start until the rail lands anyway). Its two event lists ARE held until the rail has landed, because
  // they share the ordinary lane with it and starting them at zero delays every schedule. The rail's own totals
  // are printed beside the census when they are there, and left out until they are.
  const pCensusIn = readCensusInputs({ eventsAfter: pRail });
  // The population is the page's first claim, and it needs only the citizen list and the two event lists — not the
  // money half, which waits on A and C at the end of the reading. So the census is computed twice from one set of
  // reads: an early pass that puts the whole population on screen in seconds with the paid states marked unread,
  // then the full pass that fills them in. No extra request: census() does no reads when it is handed its inputs.
  const pCensusEarly = pCensusIn.then(async (inputs) => {
    try {
      results.census = await census(ctx, inputs, { money: false });
    } catch (e) {
      problems.push(`census stopped: ${e?.message ?? e}`);
    }
    onUpdate();
  });
  // pCensusEarly is a dependency, not just a sibling: without it the two passes race and the early one could land
  // last, leaving the finished reading showing "still being read".
  const pCensus = Promise.all([pCensusIn, pC, pCensusEarly]).then(async ([inputs]) => {
    try {
      results.census = await census(ctx, inputs);
    } catch (e) {
      problems.push(`census stopped: ${e?.message ?? e}`);
    }
    onUpdate();
  });
  await Promise.all([pL, pObserver, pF, pA, pC, pG, pD, pCensus, pOfficial]);
  results.todayPending = false;
  refreshToday();
  results.controls = await controls(run);
  onUpdate();
  return run;
}

/** Schedule G's inputs: the society's wallets, plus every payee address A tied and every route on listing 23. */
async function forgeries(run) {
  const { ctx, results } = run;
  const wallets = [
    { address: TREASURY, label: "the treasury" },
    { address: PAYOUT_WALLET, label: "the society's payout wallet" },
    ...(ctx.docs.rail?.observer?.marks ?? []).filter((m) => ![TREASURY, PAYOUT_WALLET].includes(lc(m.funder_address))).map((m) => ({ address: lc(m.funder_address), label: `funder wallet ${short(m.funder_address)}` })),
  ];
  const payees = [];
  for (const l of results.A ?? []) if (l.extra?.claim?.to) payees.push({ address: l.extra.claim.to, label: `${l.handles[0]}'s payout address`, kind: "payee", handle: l.handles[0] });
  for (const bnd of ctx.docs.listing23?.bindings ?? []) payees.push({ address: bnd.payout_address, label: `${bnd.handle}'s route on listing 23`, kind: "l23", handle: bnd.handle });
  const g = await scheduleG(ctx, wallets, payees);
  results.Gnotes = g.notes;
  return g.lines;
}

/** The status line: what was read, what it cost, and whether every corrupted copy failed. */
export function summary(run) {
  const { ctx, results, problems } = run;
  const spent = net.spent();
  const c = results.controls ?? [];
  const failed = c.filter((x) => !x.pass).length;
  // Controls that never ran prove nothing: 0 of 0 is a skipped self-test, and must never read as a passed one.
  const missed = results.controlsSkipped ?? [];
  const controls = !c.length
    ? "controls: none ran on this read (their inputs were not read), so nothing here was proved by a corrupted copy"
    : `controls: ${c.length - failed}/${c.length} as they must${failed ? `, ${failed} not (see Legend)` : " (every corrupted copy failed, every copy as served passed)"}${missed.length ? `, and ${missed.length} group${missed.length === 1 ? "" : "s"} did not run (see Legend)` : ""}`;
  return `Read at ${ctx.readAt} · ${spent.registry} registry GETs · ${spent.rpc} Base reads · ${spent.indexer} indexer GETs · ${controls}${problems.length ? ` · ${problems.length} problem${problems.length === 1 ? "" : "s"} (see Legend)` : ""}.`;
}

// ---- negative controls: every green here must be able to go red ------------------------------------------

export function flipHex(s, i = 5) {
  const c = s[i];
  const n = c === "0" ? "1" : c === "a" ? "b" : c === "A" ? "B" : c === "-" ? "_" : "0";
  return s.slice(0, i) + n + s.slice(i + 1);
}

export async function controls(run) {
  const { ctx, results } = run;
  const out = [];
  // A control group whose inputs were not read did not run. It is neither a pass nor a failure, and the status line
  // has to say it is missing: "11/11 as they must" over a set that quietly lost three proves less than it looks.
  const skipped = [];
  const add = (name, expected, got) => out.push({ name, expected, got: String(got), pass: String(got) === String(expected) });
  const cps = ctx.docs.checkpoint?.checkpoints ?? [];
  const idCp = cps.find((c) => c.log === "identity_events");
  const ledgerCp = cps.find((c) => c.log === "ledger");
  try {
    if (idCp && ctx.registryKey) {
      add("identity checkpoint, as served", true, await verifyCheckpoint(ctx.registryKey, "identity_events", idCp));
      add("identity checkpoint, one signature character changed", false, await verifyCheckpoint(ctx.registryKey, "identity_events", { ...idCp, sig: flipHex(idCp.sig) }));
      add("identity checkpoint, tree size + 1", false, await verifyCheckpoint(ctx.registryKey, "identity_events", { ...idCp, tree_size: idCp.tree_size + 1 }));
    } else skipped.push("the identity checkpoint (3): GET /api/checkpoint or the registry key was not read");
    if (ledgerCp && ctx.docs.treasury) {
      const rows = ctx.docs.treasury.entries ?? [];
      const sealed = rows.filter((r) => r.hash);
      const target = sealed[Math.floor(sealed.length / 2)];
      const tampered = rows.map((r) => (r === target ? { ...r, amount_cents: r.amount_cents + 1 } : r));
      add("books fold, as served", true, (await verifyLedgerRoot(ctx.registryKey, rows, ledgerCp)).ok);
      add(`books fold, row ${target?.id} amount + 1 cent`, false, (await verifyLedgerRoot(ctx.registryKey, tampered, ledgerCp)).ok);
    } else skipped.push("the books' fold (2): the ledger checkpoint or GET /treasury was not read");
    const a = (results.A ?? []).find((l) => l.state === STATE.TIED && l.extra?.claim);
    if (a && ctx.samples?.receipts) {
      const claim = a.extra.claim;
      add(`${a.ref} tie, as served`, STATE.TIED, tieTransfer(claim, ctx.samples.receipts, ctx.finalHead).state);
      add(`${a.ref} tie, amount + 1 atomic unit`, STATE.BROKEN, tieTransfer({ ...claim, value: claim.value + 1n }, ctx.samples.receipts, ctx.finalHead).state);
      add(`${a.ref} tie, wrong token`, STATE.BROKEN, tieTransfer({ ...claim, token: TOKEN }, ctx.samples.receipts, ctx.finalHead).state);
      add(`${a.ref} tie, log index + 1`, STATE.BROKEN, tieTransfer({ ...claim, logIndex: claim.logIndex + 1 }, ctx.samples.receipts, ctx.finalHead).state);
    } else skipped.push("a receipt tie (4): no receipt tied at two nodes on this read, so there was nothing to corrupt");
    const cs = ctx.samples?.consistency;
    if (cs && cs.proof.length) {
      add(`witness consistency ${cs.first} → ${cs.second}, as served`, true, await verifyConsistency(cs.first, cs.second, cs.firstRoot, cs.secondRoot, cs.proof));
      add("witness consistency, one proof hash changed", false, await verifyConsistency(cs.first, cs.second, cs.firstRoot, cs.secondRoot, [flipHex(cs.proof[0]), ...cs.proof.slice(1)]));
      add("witness consistency, the witnessed root changed", false, await verifyConsistency(cs.first, cs.second, flipHex(cs.firstRoot), cs.secondRoot, cs.proof));
    } else skipped.push("the witness consistency proof (3): the witness day file or GET /api/checkpoint/consistency was not read");
    add("lookalike: a real poisoning pair", true, isLookalike("0x4B010DeaCd6aA30D6674b0624ad5aAD935B44D28", "0x4b086F5Df2a15394a3b2FD83Db90764F25134d28"));
    add("lookalike: an address against itself", false, isLookalike("0x4B010DeaCd6aA30D6674b0624ad5aAD935B44D28", "0x4b010deacd6aa30d6674b0624ad5aad935b44d28"));
  } catch (e) {
    if (e instanceof NotSupported) add("Ed25519 in this browser", "available", "not available: signature lines read as not read");
    else add("controls", "ran", `stopped: ${e?.message ?? e}`);
  }
  results.controlsSkipped = skipped;
  return out;
}
