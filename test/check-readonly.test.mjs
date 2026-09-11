// scripts/check-readonly.mjs must be able to fail: its --self-test plants every violation it knows (a field, a
// second fetch, a POST in registry(), a hollow allowlist, a leaked secret, …) in a temporary copy of the repo and
// requires the check that owns each one to report it. A check that could not have failed is not a check (#4613).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanJs, scanHtml } from "../scripts/check-readonly.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/check-readonly.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 180_000 });

test("--self-test: every planted violation is caught, none missed", () => {
  const r = run("--self-test");
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const m = /self-test: (\d+)\/(\d+) planted violations caught, 0 missed/.exec(r.stdout);
  assert.ok(m, r.stdout);
  assert.equal(m[1], m[2]);
  assert.ok(Number(m[2]) >= 20, `only ${m[2]} planted violations`);
  assert.doesNotMatch(r.stdout, /MISSED|NOT PLANTED/);
});

test("a normal run never errors internally (exit 0 or 1, never 2), and every check reports", () => {
  const r = run("--json", "--no-self-test");
  assert.notEqual(r.status, 2, r.stderr);
  const j = JSON.parse(r.stdout);
  const ids = j.checks.map((c) => c.id);
  for (const id of ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "T1", "T2", "T3", "T4", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "H1", "H2", "H3", "H4"]) assert.ok(ids.includes(id), id);
  assert.deepEqual(j.checks.filter((c) => c.status === "ERROR"), []);
  assert.deepEqual(j.networkAttempts, []);
  assert.equal(j.exit, r.status);
});

test("the tokenizer: words in comments, strings and regex literals are not code", () => {
  const s = scanJs([
    '// the single fetch() call site',
    'const a = "fetch(x)"; /* fetch( */',
    "const r = /[\"']fetch(/g, d = (a + b) / 2;",
    "const t = `x ${fetch(1)} y`;",
  ].join("\n"));
  const sites = [...s.code.matchAll(/(?<![\w$])fetch\s*\(/g)].map((m) => s.lineOf(m.index));
  assert.deepEqual(sites, [4]);
  const h = scanHtml('<p>&lt;input&gt;</p><!-- <input> --><button type="button">x</button>');
  assert.deepEqual(h.tags.filter((t) => !t.closing).map((t) => t.name), ["p", "button"]);
});
