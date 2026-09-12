#!/usr/bin/env node
// The same reading as the page, in a terminal: `node tools/tick.mjs` prints today's lines as text, `--json` prints
// them as data. It imports the page's own modules (docs/js/run.js and everything under it), so the doors, budgets,
// tie rules and controls are the page's, byte for byte. Node 22 or later; no dependencies.
//
// Usage: node tools/tick.mjs [--json] [--all]      (--all prints every line, not the first few per schedule)

import { readFileSync } from "node:fs";
import { newRun, runAll, summary, LOCAL } from "../docs/js/run.js";
import { reveal } from "../docs/js/codec.js";
import { LABEL, SHORT, footing, footingF } from "../docs/js/lines.js";
import { censusHeadline, populationLine } from "../docs/js/checks/census.js";

const json = process.argv.includes("--json");
const all = process.argv.includes("--all");
const docs = new URL("../docs/", import.meta.url);
const loadLocal = (file) => {
  if (!Object.values(LOCAL).includes(file)) return { ok: false, error: "not a file this page ships" };
  return { ok: true, json: JSON.parse(readFileSync(new URL(file, docs), "utf8")) };
};

// Untrusted text leaves as text with hidden characters spelled out, exactly as the page shows it.
const safe = (s, strict = false) => reveal(String(s ?? ""), 400, { strict }).map((x) => x.text ?? (x.hidden ? `⟨${x.hidden}⟩` : x.note)).join("");
const sentence = (parts) =>
  (typeof parts === "string" ? [parts] : parts ?? [])
    .map((p) => (typeof p === "string" ? p : p?.handle ? safe(p.handle) : p?.symbol !== undefined ? `"${safe(p.symbol, true)}"` : p?.addr ? p.addr : ""))
    .join("");
const plainLine = (l) => ({ ref: l.ref, state: l.state, mark: l.mark, title: safe(l.title), sentence: sentence(l.sentence), why: l.why, says: l.says, shows: l.shows, log: l.log, not_verified: l.notVerified, cite: l.cite });

const run = newRun();
await runAll(run, { loadLocal, status: (t) => json || process.stderr.write(`\r\x1b[K${t}`) });
if (!json) process.stderr.write("\r\x1b[K");
const { ctx, results, problems } = run;
const ORDER = [
  ["A", "Receipts"],
  ["C", "The observer"],
  ["L", "Listing 23"],
  ["F", "Clocks"],
  ["G", "Forgeries"],
  ["D", "The books"],
];

if (json) {
  const out = {
    kind: "tick-and-tie.reading.v1",
    read_at: ctx.readAt,
    finalized_head: ctx.finalHead,
    summary: summary(run),
    today: (results.today ?? []).map((t) => ({ ref: t.ref, head: sentence(t.head), body: t.body, not_verified: t.notVerified ?? null })),
    census: results.census?.summary ?? null,
    schedules: Object.fromEntries(ORDER.map(([k]) => [k, (results[k] ?? []).map(plainLine)])),
    controls: results.controls,
    problems,
  };
  process.stdout.write(JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
} else {
  const w = (s = "") => process.stdout.write(s + "\n");
  w(`TICK & TIE · ${summary(run)}`);
  w(`finalized head, two operators: ${ctx.finalHead ?? "not read"}`);
  // Everyone first, then the picked items — the same order as the page, for the same reason.
  if (results.census?.summary) {
    const s = results.census.summary;
    w();
    w(`EVERYONE: ${populationLine(s)}`);
    w(`  ${censusHeadline(s)}`);
    if (s.rail) w(`  the rail's own totals (records, not citizens): ${s.rail.submissions} submissions, ${s.rail.bindings} bindings, ${s.rail.receipts} receipts`);
  } else if (results.census?.error) w(`\nEVERYONE: not read (${results.census.error})`);
  w();
  w("TODAY ON THE RAIL");
  for (const [i, t] of (results.today ?? []).entries()) {
    w(`${i + 1}. ${sentence(t.head)}`);
    for (const b of t.body ?? []) w(`   ${b}`);
    if (t.notVerified) w(`   Not verified: ${t.notVerified}.`);
  }
  for (const [k, title] of ORDER) {
    const lines = results[k] ?? [];
    const f = footing(lines);
    w();
    const fF = footingF(lines);
    const count = k === "F" ? `${fF.clocks} clock${fF.clocks === 1 ? "" : "s"}, not in the footing${fF.unread ? ` · ${fF.unread} not read` : ""}` : k === "G" ? `${lines.length} exhibit${lines.length === 1 ? "" : "s"}, not in the footing` : Object.entries(f).filter(([, n]) => n).map(([s, n]) => `${n} ${SHORT[s]}`).join(" · ") || "no lines";
    w(`${k} · ${title.toUpperCase()} · ${count}`);
    for (const l of all ? lines : lines.slice(0, k === "D" ? 6 : 5)) w(`  ${l.mark} ${l.ref}  ${sentence(l.sentence)}${l.why ? `  [${l.why}]` : ""}`);
    if (!all && lines.length > (k === "D" ? 6 : 5)) w(`  … ${lines.length - (k === "D" ? 6 : 5)} more (--all)`);
  }
  w();
  w(`CONTROLS: ${(results.controls ?? []).map((c) => `${c.pass ? "✓" : "✗"} ${c.name}`).join("; ")}`);
  if (results.controlsSkipped?.length) w(`  did not run on this read: ${results.controlsSkipped.join("; ")}`);
  if (problems.length) {
    w();
    w("PROBLEMS ON THIS READ");
    for (const p of problems) w(`  ${p}`);
  }
  w();
  w(`Marks: ${Object.entries(LABEL).map(([s, t]) => `${SHORT[s]} = ${t}`).join("; ")}.`);
  w("Not an audit. Arithmetic in the shape of one.");
}
process.exit(0);
