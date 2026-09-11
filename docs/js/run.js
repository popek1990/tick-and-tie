// One reading of the rail, with no DOM: the registry wave (GET), the finalized head, the committed files, every
// schedule in dependency order, the census, "today", and the negative controls. The page (app.js) draws it; the
// command line (tools/tick.mjs) prints it. Same modules, same rules, same doors.

import * as net from "./net.js";
import { selfTest } from "./abi.js";
import { heads, tieTransfer, STATE } from "./chain.js";
import { verifyCheckpoint, verifyLedgerRoot, NotSupported } from "./crypto.js";
import { scheduleA } from "./checks/receipts.js";
import { scheduleC } from "./checks/observer.js";
import { scheduleL } from "./checks/l23.js";
import { scheduleF } from "./checks/clocks.js";
import { scheduleG } from "./checks/forgeries.js";
import { scheduleD, TREASURY, PAYOUT_WALLET } from "./checks/books.js";
import { census } from "./checks/census.js";
import { today } from "./checks/today.js";
import { isoSec, fromMs, short, lc, isLookalike, TOKEN } from "./codec.js";

export const LOCAL = Object.freeze({ baseline: "data/baseline.json", bindings: "data/bindings.json" });

export function newRun() {
  const ctx = { docs: {}, minFinal: null, headRef: null, baseline: null, bindingsIndex: null, readAt: null, registryKey: null };
  const detailCache = new Map();
  ctx.listingDetail = (id) => {
    if (!detailCache.has(id)) detailCache.set(id, net.registry(`/api/listings/${id}`));
    return detailCache.get(id);
  };
  return { ctx, results: { A: null, C: null, L: null, F: null, G: null, D: null, census: null, today: null, controls: null, Gnotes: [] }, problems: [] };
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
  status("Reading the registry (GET) …");
  const [rail, checkpoint, receiptEvents, treasury, official, listing23] = await Promise.all([
    net.registry("/api/rail"),
    net.registry("/api/checkpoint"),
    net.registry("/api/events?kind=payout-receipt"),
    net.registry("/treasury"),
    net.registry("/api/official"),
    ctx.listingDetail(23),
  ]);
  for (const [name, r] of Object.entries({ rail, checkpoint, receiptEvents, treasury, official, listing23 })) {
    if (r.ok) ctx.docs[name] = r.json;
    else problems.push(`GET ${name}: not read (${r.error})`);
  }
  ctx.readAt = isoSec(fromMs(rail.json?.now) ?? new Date());
  ctx.docs.listing23Now = listing23.json?.now;
  ctx.registryKey = checkpoint.json?.registry_public_key?.x ?? null;
  const offTreasury = lc(official.json?.treasury?.address);
  if (offTreasury && offTreasury !== TREASURY) problems.push(`the treasury address this page watches (${short(TREASURY)}) differs from GET /api/official (${short(offTreasury)}): check before trusting schedule D`);

  status("Reading Base: the finalized head at three nodes …");
  const h = await heads();
  ctx.minFinal = h.minFinal;
  ctx.heads = h;
  ctx.headRef = h.per.base?.number ? h.per.base : h.per.drpc?.number ? h.per.drpc : null;
  if (!ctx.minFinal) problems.push("no archive node answered the finalized head: chain lines below read as not read");
  const [b, bi] = await Promise.all([LOCAL.baseline, LOCAL.bindings].map((f) => Promise.resolve(loadLocal(f)).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))));
  if (b.ok && b.json?.kind === "tick-and-tie.baseline.v1") ctx.baseline = b.json;
  else problems.push(`${LOCAL.baseline}: not read (${b.error ?? "unexpected kind"})`);
  if (bi.ok && bi.json?.kind === "tick-and-tie.bindings.v1") ctx.bindingsIndex = bi.json;
  else problems.push(`${LOCAL.bindings}: not read (${bi.error ?? "unexpected kind"}); schedule C reads every listing live`);
  onUpdate();

  // The schedules run side by side where they do not depend on each other: each door has its own pacing, so
  // this changes the wall time, not the load on any server. A comes before C (C needs A's receipts) and before
  // G (G needs A's payees); L comes before F (F needs L's clocks).
  const running = new Set();
  const showRunning = () => status(running.size ? `Checking ${[...running].sort().join(", ")} …` : "Finishing …");
  const step = async (key, fn) => {
    running.add(key);
    showRunning();
    try {
      results[key] = await fn();
    } catch (e) {
      problems.push(`schedule ${key} stopped: ${e?.message ?? e}`);
      results[key] = [];
    }
    running.delete(key);
    showRunning();
    onUpdate();
  };
  await step("L", async () => scheduleL(ctx));
  const pA = step("A", () => scheduleA(ctx));
  const pC = pA.then(() => step("C", () => scheduleC(ctx)));
  const pF = step("F", () => scheduleF(ctx));
  const pD = step("D", () => scheduleD(ctx));
  const pG = pA.then(() => step("G", () => forgeries(run)));
  await Promise.all([pC, pF]);
  try {
    results.today = await today(ctx, { cLines: results.C ?? [], fLines: results.F ?? [], lLines: results.L ?? [] });
  } catch (e) {
    problems.push(`today: ${e?.message ?? e}`);
    results.today = [];
  }
  onUpdate();
  try {
    results.census = await census(ctx);
  } catch (e) {
    problems.push(`census stopped: ${e?.message ?? e}`);
  }
  onUpdate();
  await Promise.all([pD, pG]);
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
  for (const l of results.A ?? []) if (l.extra?.claim?.to) payees.push({ address: l.extra.claim.to, label: `${l.handles[0]}'s payout address` });
  for (const bnd of ctx.docs.listing23?.bindings ?? []) payees.push({ address: bnd.payout_address, label: `${bnd.handle}'s route on listing 23` });
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
  return `Read at ${ctx.readAt} · ${spent.registry} registry GETs · ${spent.rpc} Base reads · ${spent.indexer} indexer GETs · controls: ${c.length - failed}/${c.length} corrupted copies failed, as they must${problems.length ? ` · ${problems.length} problem${problems.length === 1 ? "" : "s"} (see Legend)` : ""}.`;
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
  const add = (name, expected, got) => out.push({ name, expected, got: String(got), pass: String(got) === String(expected) });
  const cps = ctx.docs.checkpoint?.checkpoints ?? [];
  const idCp = cps.find((c) => c.log === "identity_events");
  const ledgerCp = cps.find((c) => c.log === "ledger");
  try {
    if (idCp && ctx.registryKey) {
      add("identity checkpoint, as served", true, await verifyCheckpoint(ctx.registryKey, "identity_events", idCp));
      add("identity checkpoint, one signature character changed", false, await verifyCheckpoint(ctx.registryKey, "identity_events", { ...idCp, sig: flipHex(idCp.sig) }));
      add("identity checkpoint, tree size + 1", false, await verifyCheckpoint(ctx.registryKey, "identity_events", { ...idCp, tree_size: idCp.tree_size + 1 }));
    }
    if (ledgerCp && ctx.docs.treasury) {
      const rows = ctx.docs.treasury.entries ?? [];
      const sealed = rows.filter((r) => r.hash);
      const target = sealed[Math.floor(sealed.length / 2)];
      const tampered = rows.map((r) => (r === target ? { ...r, amount_cents: r.amount_cents + 1 } : r));
      add("books fold, as served", true, (await verifyLedgerRoot(ctx.registryKey, rows, ledgerCp)).ok);
      add(`books fold, row ${target?.id} amount + 1 cent`, false, (await verifyLedgerRoot(ctx.registryKey, tampered, ledgerCp)).ok);
    }
    const a = (results.A ?? []).find((l) => l.state === STATE.TIED && l.extra?.claim);
    if (a && ctx.samples?.receipts) {
      const claim = a.extra.claim;
      add(`${a.ref} tie, as served`, STATE.TIED, tieTransfer(claim, ctx.samples.receipts, ctx.minFinal).state);
      add(`${a.ref} tie, amount + 1 atomic unit`, STATE.BROKEN, tieTransfer({ ...claim, value: claim.value + 1n }, ctx.samples.receipts, ctx.minFinal).state);
      add(`${a.ref} tie, wrong token`, STATE.BROKEN, tieTransfer({ ...claim, token: TOKEN }, ctx.samples.receipts, ctx.minFinal).state);
      add(`${a.ref} tie, log index + 1`, STATE.BROKEN, tieTransfer({ ...claim, logIndex: claim.logIndex + 1 }, ctx.samples.receipts, ctx.minFinal).state);
    }
    add("lookalike: a real poisoning pair", true, isLookalike("0x4B010DeaCd6aA30D6674b0624ad5aAD935B44D28", "0x4b086F5Df2a15394a3b2FD83Db90764F25134d28"));
    add("lookalike: an address against itself", false, isLookalike("0x4B010DeaCd6aA30D6674b0624ad5aAD935B44D28", "0x4b010deacd6aa30d6674b0624ad5aad935b44d28"));
  } catch (e) {
    if (e instanceof NotSupported) add("Ed25519 in this browser", "available", "not available: signature lines read as not read");
    else add("controls", "ran", `stopped: ${e?.message ?? e}`);
  }
  return out;
}
