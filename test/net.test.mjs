// The pacing under every door: requests to one node never start closer than its gap, and never exceed its
// in-flight limit, however many are asked at once. The fetch here is a stub; nothing leaves this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "../docs/js/net.js";
import { HEAVY, heavyLaneOf } from "../docs/js/net.js";

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

test("the citizen list does not queue behind the listing and binding reads", () => {
  // Both classes need the long gap, but sharing one queue cost the page its own first sentence: the population
  // line is built from the citizen list, and behind a queue of detail reads it landed last, under the section that
  // sits at the top of the page. Same lane for the two detail paths, a lane of its own for the list.
  assert.equal(heavyLaneOf("/api/listings/23"), heavyLaneOf("/api/payout-bindings/270"), "the two detail classes still share one queue");
  assert.notEqual(heavyLaneOf("/api/citizens"), heavyLaneOf("/api/listings/23"), "the citizen list must not wait behind listing reads");
  // Every page of the list is one path (the cursor is in the query), so all of them share the list lane.
  assert.equal(heavyLaneOf("/api/citizens"), "registry-list");
});

test("local(): a throttled or blipped read of this page's own data file is retried, not lost", async () => {
  // Every other door retries. This one asked once, and one 503 on a file we ship ourselves took out D-4,
  // D-5 and all of schedule C — the page reporting "not read" about its own bytes.
  const saved = globalThis.fetch;
  const savedLoc = globalThis.location;
  globalThis.location = { href: "https://example.test/index.html", origin: "https://example.test" };
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 3) return new Response("slow down", { status: 503 });
    return new Response(JSON.stringify({ to_block: 51_181_236, logs: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await net.local("data/baseline.json");
    assert.equal(r.ok, true, "the third attempt answered, so the file is read");
    assert.equal(r.json.to_block, 51_181_236);
    assert.equal(calls, 3, "two retries, then the answer");
  } finally {
    globalThis.fetch = saved;
    if (savedLoc === undefined) delete globalThis.location;
    else globalThis.location = savedLoc;
  }
});

test("local(): a permanent refusal is not retried, and stays 'not read'", async () => {
  const saved = globalThis.fetch;
  const savedLoc = globalThis.location;
  globalThis.location = { href: "https://example.test/index.html", origin: "https://example.test" };
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("nope", { status: 404 });
  };
  try {
    const r = await net.local("data/receipts.json");
    assert.equal(r.ok, false);
    assert.equal(calls, 1, "404 is an answer, not a blip: asked once");
  } finally {
    globalThis.fetch = saved;
    if (savedLoc === undefined) delete globalThis.location;
    else globalThis.location = savedLoc;
  }
});
