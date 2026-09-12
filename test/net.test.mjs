// The pacing under every door: requests to one node never start closer than its gap, and never exceed its
// in-flight limit, however many are asked at once. The fetch here is a stub; nothing leaves this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "../docs/js/net.js";
import { HEAVY } from "../docs/js/net.js";

test("requests to one node start at least gapMs apart and stay within inflight, even when several wait at once", async () => {
  const starts = [];
  let active = 0;
  let most = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    starts.push(Date.now());
    most = Math.max(most, ++active);
    await new Promise((r) => setTimeout(r, 60));
    active--;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2105" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const out = await Promise.all([1, 2, 3, 4].map(() => net.rpc("tenderly", { method: "eth_chainId", params: [] })));
    assert.ok(out.every((o) => o[0].result === "0x2105"));
  } finally {
    globalThis.fetch = saved;
  }
  const { gapMs, inflight } = net.BUDGET.rpc;
  assert.equal(starts.length, 4);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= gapMs - 5, `request ${i + 1} started ${starts[i] - starts[i - 1]} ms after the one before`);
  assert.ok(most <= inflight, `${most} in flight at once`);
});

test("the registry's expensive paths, including each page of the citizen list, are on the slow lane", () => {
  for (const p of ["/api/listings/23", "/api/payout-bindings/270", "/api/citizens"]) {
    assert.ok(HEAVY.test(p), `${p} must be paced on the slow lane with the long retry`);
  }
  for (const p of ["/api/rail", "/api/checkpoint", "/api/events", "/treasury", "/api/proof"]) {
    assert.equal(HEAVY.test(p), false, `${p} is cheap enough for the ordinary lane`);
  }
});
