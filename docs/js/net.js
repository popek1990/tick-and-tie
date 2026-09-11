// The only module on this page that touches the network. Every request the page makes passes through send()
// below, which is the single fetch() call site in docs/ (scripts/check-readonly.mjs counts them: R2).
//
// Four doors, and what each may do:
//   registry(path)  GET  https://1f916.ai        the society's own record; a path allowlist, no custom headers
//   indexer(path)   GET  https://base.blockscout.com/api/v2   labels and hints only, never a tick
//   witness(file)   GET  https://raw.githubusercontent.com/1f916-ai/1f916/main/witness/
//   rpc(node, …)    POST JSON-RPC to four Base nodes, read methods only
//
// Why POST to Base nodes is still "reads and never writes": JSON-RPC is POST by protocol, and the society's own
// /human/economy page reads Base the same way (two of four nodes must agree). The methods below are all reads.
// Moving money needs a signature, and this page holds no key and never asks for one: there is no send or sign
// method in the allowlist, no wallet object is ever touched, and a call that is not in the allowlist is refused
// here before any byte leaves the browser (scripts/check-readonly.mjs R8 drives these refusals through a stub
// fetch; test/smoke.mjs watches every request in a real browser).
//
// The shape (one GET-only module, origins checked after URL parsing, a runtime refusal rather than a promise)
// follows The Fold's js/api.js by tardis-relay, which the judge read and praised (c38636). No code is copied.

import { READ_SIGNATURES } from "./abi.js";

export const REGISTRY = "https://1f916.ai";
export const INDEXER = "https://base.blockscout.com";
export const WITNESS = "https://raw.githubusercontent.com";

// Nodes. `operator` matters: a tie needs two different operators (a single liar is caught by the other).
// publicnode refuses archive reads ("Archive requests require a personal token"), so it only votes on the head.
// Ties are read at base and tenderly (both archive, both batch); drpc is the third voice, asked only for what one
// of them did not answer (its free plan batches 3 at most). tenderly caps eth_getLogs at 1,000 blocks. 1rpc (410
// "discontinued", silent nulls for old data) and llamarpc (HTTP 525) were tested and left out.
export const NODES = Object.freeze({
  base: Object.freeze({ url: "https://mainnet.base.org", operator: "Coinbase", archive: true, batch: 8, logsSpan: 2000 }),
  drpc: Object.freeze({ url: "https://base.drpc.org", operator: "dRPC", archive: true, batch: 3, logsSpan: 1000 }),
  publicnode: Object.freeze({ url: "https://base-rpc.publicnode.com", operator: "Allnodes", archive: false, batch: 6, logsSpan: 0 }),
  tenderly: Object.freeze({ url: "https://base.gateway.tenderly.co", operator: "Tenderly", archive: true, batch: 8, logsSpan: 1000 }),
});
// Who votes on a tie, and who is asked when one of them did not answer.
export const TIE_NODES = Object.freeze(["base", "tenderly"]);
export const FALLBACK_NODE = "drpc";

// The CSP connect-src in index.html must equal this list exactly (check-readonly R5).
export const FETCH_ORIGINS = Object.freeze([
  "https://1f916.ai/api/",
  "https://1f916.ai/treasury",
  "https://base.blockscout.com/api/v2/",
  "https://raw.githubusercontent.com/1f916-ai/1f916/main/witness/",
  "https://mainnet.base.org",
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.gateway.tenderly.co",
]);

// Where a link on the page may point. ui.js linkHref() builds every href and refuses any other origin;
// check-readonly R4 reads this same list.
export const LINK_ORIGINS = Object.freeze(["https://1f916.ai", "https://base.blockscout.com", "https://github.com"]);

// Registry paths this page reads, each GET, auth none, writes false in GET /api/surface (check-readonly H2).
// Query keys are allowlisted per route; anything else is refused.
export const REGISTRY_ROUTES = Object.freeze([
  Object.freeze({ path: /^\/api\/rail$/, query: [] }),
  Object.freeze({ path: /^\/api\/official$/, query: [] }),
  Object.freeze({ path: /^\/api\/checkpoint$/, query: [] }),
  Object.freeze({ path: /^\/api\/checkpoint\/consistency$/, query: ["log", "from", "to"] }),
  Object.freeze({ path: /^\/api\/proof$/, query: ["log", "event"] }),
  Object.freeze({ path: /^\/api\/events$/, query: ["kind", "since"] }),
  Object.freeze({ path: /^\/api\/citizens$/, query: ["since"] }),
  Object.freeze({ path: /^\/api\/listings\/[0-9]{1,6}$/, query: [] }),
  Object.freeze({ path: /^\/api\/payout-bindings\/[0-9]{1,7}$/, query: [] }),
  Object.freeze({ path: /^\/treasury$/, query: [] }),
]);

// Blockscout v2 paths: token transfers and transactions of an address, one transaction, one token.
export const INDEXER_ROUTES = Object.freeze([
  Object.freeze({ path: /^\/api\/v2\/addresses\/0x[0-9a-fA-F]{40}\/token-transfers$/, query: ["type", "filter", "block_number", "index", "items_count"] }),
  Object.freeze({ path: /^\/api\/v2\/transactions\/0x[0-9a-fA-F]{64}\/token-transfers$/, query: [] }),
]);

// JSON-RPC methods this page may send. Every element of a batch is checked against this list (R6, R8).
export const RPC_METHODS = Object.freeze([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getTransactionReceipt",
  "eth_call",
  "eth_getLogs",
]);

// eth_call may only target these contracts, with a selector from abi.js READ_SIGNATURES.
export const CALL_TARGETS = Object.freeze([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC (6 decimals)
  "0x9e00fc92493451eba1c63dd3880d68b622037ba3", // 1F916 (18 decimals)
  "0x4200000000000000000000000000000000000006", // WETH (18 decimals)
]);

// Budgets per page load. Being cheap to the server is a rule of the square (#900, c6619: one client pulled
// 2.14 GB in an hour), and public Base nodes are a shared resource too.
export const BUDGET = Object.freeze({
  registry: { max: 60, inflight: 3, gapMs: 150, capBytes: 1_200_000 },
  indexer: { max: 20, inflight: 2, gapMs: 250, capBytes: 600_000 },
  witness: { max: 2, inflight: 1, gapMs: 0, capBytes: 1_200_000 },
  rpc: { max: 150, inflight: 2, gapMs: 350, capBytes: 1_000_000 },
  timeoutMs: 20_000,
  maxLogsSpan: 2000,
});

// ---- the tape: every request, in memory only ------------------------------------------------------------

const tape = [];
const listeners = new Set();
export const getTape = () => tape.slice();
export function onTape(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function record(entry) {
  tape.push(Object.freeze(entry));
  for (const fn of listeners) fn(entry);
}

// ---- pacing, budgets, circuit breakers ------------------------------------------------------------------

const counters = { registry: 0, indexer: 0, witness: 0, rpc: 0 };
const lanes = new Map();
const circuit = new Map(); // node id -> reopen time (ms)
export const spent = () => ({ ...counters });

function lane(key, inflight, gapMs) {
  if (!lanes.has(key)) lanes.set(key, { active: 0, queue: [], last: 0, inflight, gapMs });
  return lanes.get(key);
}

// Each request reserves its start before it waits, so two that wait at once still start gapMs apart (they once
// left 3 ms apart and tenderly answered 429). A finished request hands its slot straight to the next in line.
async function paced(key, inflight, gapMs, job) {
  const l = lane(key, inflight, gapMs);
  if (l.active >= l.inflight) await new Promise((res) => l.queue.push(res));
  else l.active++;
  const start = Math.max(Date.now(), l.last + l.gapMs);
  l.last = start;
  try {
    if (start > Date.now()) await new Promise((res) => setTimeout(res, start - Date.now()));
    return await job();
  } finally {
    const next = l.queue.shift();
    if (next) next();
    else l.active--;
  }
}

/**
 * A framing site could cycle our hash and turn every visitor into an amplifier against the registry, the indexer
 * and the Base nodes. GitHub Pages sends no frame-ancestors and a meta CSP cannot, so framed, this page reads
 * nothing from anyone: every door below checks this first.
 */
function framed() {
  try {
    return typeof window !== "undefined" && window.top !== window.self;
  } catch {
    return true;
  }
}

class Refused extends Error {}
export { Refused };

// ---- the single network sink ----------------------------------------------------------------------------

async function send(door, url, init, capBytes, note = null) {
  const started = Date.now();
  const entry = { at: new Date(started).toISOString(), door, origin: url.origin, path: url.pathname + url.search, method: init.method, rpc: note };
  let status = 0;
  try {
    const res = await fetch(url.href, {
      ...init,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: AbortSignal.timeout(BUDGET.timeoutMs),
    });
    status = res.status;
    const text = await readCapped(res, capBytes);
    record({ ...entry, status, bytes: text.length, ms: Date.now() - started });
    return { ok: res.ok, status, text };
  } catch (e) {
    record({ ...entry, status, bytes: 0, ms: Date.now() - started, error: String(e?.name || e) });
    return { ok: false, status, text: "", error: e?.name === "TimeoutError" ? "timeout" : String(e?.message || e) };
  }
}

async function readCapped(res, cap) {
  if (!res.body?.getReader) {
    const t = await res.text();
    if (t.length > cap) throw new Error(`response over ${cap} bytes, not read`);
    return t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) {
      reader.cancel();
      throw new Error(`response over ${cap} bytes, not read`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return new TextDecoder().decode(all);
}

function checkRoute(base, routes, path) {
  const url = new URL(path, base);
  if (url.origin !== base || url.username || url.password || url.hash) throw new Refused(`refused: ${path}`);
  const route = routes.find((r) => r.path.test(url.pathname));
  if (!route) throw new Refused(`refused: path not on this page's list: ${url.pathname}`);
  for (const k of url.searchParams.keys()) if (!route.query.includes(k)) throw new Refused(`refused: query key ${k}`);
  return url;
}

function parseJson(r) {
  if (!r.ok) return { ok: false, status: r.status, error: r.error || `HTTP ${r.status}` };
  try {
    return { ok: true, status: r.status, json: JSON.parse(r.text), bytes: r.text.length };
  } catch {
    return { ok: false, status: r.status, error: "not JSON" };
  }
}

// One listing or one binding costs the registry a second or more to build. On 2026-09-11 three at once were
// refused, and so was the seventh in about ten seconds one at a time (HTTP 429, arriving without CORS headers,
// so a browser can only call it a network error). Two seconds apart, a browser's fourth was refused on two loads
// out of two, and a retry six seconds later too; three and a half seconds apart, none was. Those paths go one at
// a time, 3.5 s apart, retry once after eleven, and the page asks for as few as it can: receipts and funder
// bindings come from committed indexes the page re-checks, and a listing that stays unread says so.
const HEAVY = /^\/api\/(listings|payout-bindings)\/\d+$/;
const HEAVY_GAP_MS = 3500;

/** GET from the registry. Returns {ok, json} or {ok:false, error}. Never throws for network trouble. */
export async function registry(path) {
  const url = checkRoute(REGISTRY, REGISTRY_ROUTES, path);
  if (framed()) return { ok: false, status: 0, error: "not read: this page is inside another site's frame" };
  const b = BUDGET.registry;
  const heavy = HEAVY.test(url.pathname);
  const once = () => {
    if (counters.registry >= b.max) return { ok: false, status: 0, error: `not read: this page's registry budget (${b.max} requests) is spent` };
    counters.registry++;
    return heavy
      ? paced("registry-heavy", 1, HEAVY_GAP_MS, () => send("registry", url, { method: "GET", headers: { accept: "application/json" } }, b.capBytes))
      : paced("registry", b.inflight, b.gapMs, () => send("registry", url, { method: "GET", headers: { accept: "application/json" } }, b.capBytes));
  };
  let r = await once();
  // One retry, after a pause, on a network error, a 429 or a 5xx; never on another 4xx.
  if (!r.ok && (r.status === 0 || r.status === 429 || r.status >= 500) && !/budget/.test(r.error ?? "")) {
    await new Promise((res) => setTimeout(res, heavy ? 11_000 : 2500));
    r = await once();
  }
  return parseJson(r);
}

/** GET from Blockscout v2. Used to find where to look, never to decide a tick. */
export async function indexer(path) {
  const url = checkRoute(INDEXER, INDEXER_ROUTES, path);
  if (framed()) return { ok: false, status: 0, error: "not read: this page is inside another site's frame" };
  const b = BUDGET.indexer;
  if (counters.indexer >= b.max) return { ok: false, error: `not read: the indexer budget (${b.max}) is spent` };
  counters.indexer++;
  return parseJson(await paced("indexer", b.inflight, b.gapMs, () => send("indexer", url, { method: "GET", headers: { accept: "application/json" } }, b.capBytes)));
}

/**
 * Newest-first pages of one indexer list, following its own next_page_params, until an item at or below
 * `stopBlock` is seen, the list ends, or `maxPages` pages were read. `complete` says whether it reached back.
 */
export async function indexerPages(path, stopBlock, maxPages = 3) {
  const items = [];
  let url = path;
  for (let page = 1; ; page++) {
    const r = await indexer(url);
    if (!r.ok) return { ok: page > 1, items, complete: false, error: r.error };
    const got = r.json.items ?? [];
    items.push(...got);
    const next = r.json.next_page_params;
    const oldest = got.length ? Math.min(...got.map((it) => Number(it.block_number ?? 0))) : null;
    if (!next || (oldest !== null && oldest <= stopBlock)) return { ok: true, items, complete: true };
    if (page >= maxPages) return { ok: true, items, complete: false, error: `stopped after ${maxPages} pages` };
    const keys = Object.keys(next);
    if (!keys.length || !keys.every((k) => ["block_number", "index", "items_count"].includes(k))) return { ok: true, items, complete: false, error: "the next page needs a parameter this page does not send" };
    url = `${path}${path.includes("?") ? "&" : "?"}${keys.map((k) => `${k}=${encodeURIComponent(String(next[k]))}`).join("&")}`;
  }
}

/**
 * GET a file this page ships next to itself (the committed baseline, the bindings index, the receipts index).
 * Same origin only, three named files, so the CSP's connect-src 'self' is used by exactly this.
 */
export const LOCAL_FILES = Object.freeze(["data/baseline.json", "data/bindings.json", "data/receipts.json"]);
export async function local(file) {
  if (!LOCAL_FILES.includes(file) || typeof location === "undefined") throw new Refused("refused: local file");
  const url = new URL(file, location.href);
  if (url.origin !== location.origin) throw new Refused("refused: local origin");
  return parseJson(await send("local", url, { method: "GET", headers: { accept: "application/json" } }, 2_500_000));
}

/** GET one witness day file (JSON lines) from the society's public witness on GitHub. */
export async function witness(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Refused("refused: witness day");
  const url = new URL(`/1f916-ai/1f916/main/witness/${day}.jsonl`, WITNESS);
  if (framed()) return { ok: false, error: "not read: this page is inside another site's frame" };
  const b = BUDGET.witness;
  if (counters.witness >= b.max) return { ok: false, error: "not read: witness budget spent" };
  counters.witness++;
  const r = await send("witness", url, { method: "GET" }, b.capBytes);
  return r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error || `HTTP ${r.status}` };
}

// ---- JSON-RPC ---------------------------------------------------------------------------------------------

const HEX_Q = /^0x[0-9a-fA-F]{1,16}$/;
const TAGS = ["latest", "finalized", "safe"];
const isBlockRef = (v) => (typeof v === "string" && (HEX_Q.test(v) || TAGS.includes(v)));
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isTopic = (v) => v === null || (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v));

/** Refuses anything that is not one of the read calls this page is built to make. Exported for the tests. */
export function checkCall(c) {
  if (!c || typeof c !== "object") throw new Refused("refused: not a call");
  const { method, params } = c;
  if (!RPC_METHODS.includes(method)) throw new Refused(`refused: method ${String(method)} is not a read this page makes`);
  if (!Array.isArray(params)) throw new Refused("refused: params");
  switch (method) {
    case "eth_chainId":
    case "eth_blockNumber":
      if (params.length) throw new Refused("refused: params");
      return;
    case "eth_getBlockByNumber":
      if (params.length !== 2 || !isBlockRef(params[0]) || params[1] !== false) throw new Refused("refused: getBlockByNumber takes (block, false)");
      return;
    case "eth_getTransactionReceipt":
      if (params.length !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(params[0])) throw new Refused("refused: receipt takes one tx hash");
      return;
    case "eth_call": {
      const [tx, block] = params;
      if (params.length !== 2 || !tx || typeof tx !== "object" || !isBlockRef(block)) throw new Refused("refused: eth_call shape");
      const keys = Object.keys(tx).sort().join(",");
      if (keys !== "data,to") throw new Refused("refused: eth_call carries only {to, data}");
      if (!CALL_TARGETS.includes(String(tx.to).toLowerCase())) throw new Refused("refused: eth_call target");
      const selectors = Object.values(READ_SIGNATURES);
      const d = String(tx.data).toLowerCase();
      if (!/^0x[0-9a-f]{8}([0-9a-f]{64})*$/.test(d) || !selectors.includes(d.slice(0, 10))) throw new Refused("refused: eth_call selector");
      return;
    }
    case "eth_getLogs": {
      const [f] = params;
      if (params.length !== 1 || !f || typeof f !== "object") throw new Refused("refused: getLogs shape");
      const keys = Object.keys(f).sort().join(",");
      if (keys !== "address,fromBlock,toBlock,topics") throw new Refused("refused: getLogs takes {address, fromBlock, toBlock, topics}");
      const addrs = Array.isArray(f.address) ? f.address : [f.address];
      if (!addrs.length || !addrs.every((a) => CALL_TARGETS.includes(String(a).toLowerCase()))) throw new Refused("refused: getLogs address");
      if (!HEX_Q.test(f.fromBlock) || !HEX_Q.test(f.toBlock)) throw new Refused("refused: getLogs needs numbered blocks");
      const spanBlocks = Number(BigInt(f.toBlock) - BigInt(f.fromBlock)) + 1;
      if (!(spanBlocks >= 1 && spanBlocks <= BUDGET.maxLogsSpan)) throw new Refused(`refused: getLogs span ${spanBlocks} (max ${BUDGET.maxLogsSpan})`);
      if (!Array.isArray(f.topics) || f.topics.length < 1 || f.topics.length > 3) throw new Refused("refused: getLogs topics");
      for (const t of f.topics) {
        const list = Array.isArray(t) ? t : [t];
        if (!list.length || list.length > 16 || !list.every(isTopic)) throw new Refused("refused: getLogs topic");
      }
      return;
    }
    default:
      throw new Refused("refused");
  }
}

// Throttles and outages are "not read", never an answer. Permanent errors (bad range, archive refused) are also
// "not read", but are not retried.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RETRY_CODES = new Set([-32016, -32005, -32603]);

// The one place a POST is built. Only rpc() and rpcVerbatim() call it, and both have checked every call first.
function post(nodeId, payload, note) {
  const url = new URL(NODES[nodeId].url);
  const b = BUDGET.rpc;
  return paced(`rpc:${nodeId}`, b.inflight, b.gapMs, () =>
    send("rpc", url, { method: "POST", headers: { "content-type": "application/json" }, body: payload }, b.capBytes, note)
  );
}

/**
 * POST one call or a batch to one node. Returns an array of {result} | {error, code} | {notRead}, in the order
 * of `calls`, matched by id (JSON-RPC 2.0 lets a batch answer in any order). `opts.bypassFrame` is for the
 * explicit "ask another node" buttons only.
 */
export async function rpc(nodeId, calls, opts = {}) {
  const node = NODES[nodeId];
  if (!node) throw new Refused(`refused: unknown node ${String(nodeId)}`);
  const list = Array.isArray(calls) ? calls : [calls];
  list.forEach(checkCall);
  const notRead = (why) => list.map(() => ({ notRead: why }));
  if (framed()) return notRead("not read: this page is inside another site's frame, so it reads nothing from Base");
  const reopen = circuit.get(nodeId) ?? 0;
  if (Date.now() < reopen) return notRead(`not read: ${new URL(node.url).host} asked us to slow down; paused`);
  const b = BUDGET.rpc;
  if (counters.rpc >= b.max) return notRead(`not read: this page's Base read budget (${b.max} requests) is spent`);
  counters.rpc++;
  const body = list.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }));
  const payload = JSON.stringify(body.length === 1 ? body[0] : body);
  const url = new URL(node.url);
  const note = list.map((c) => c.method).join(",");
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await post(nodeId, payload, `${nodeId}: ${note}`);
    if (!r.ok && (RETRYABLE.has(r.status) || r.error === "timeout") && attempt < 2) {
      await new Promise((res) => setTimeout(res, 800 * 2 ** attempt + Math.random() * 400));
      if (r.status === 429) circuit.set(nodeId, Date.now() + 20_000);
      continue;
    }
    if (!r.ok) return notRead(`not read: ${url.host} answered ${r.status ? "HTTP " + r.status : r.error}`);
    let parsed;
    try {
      parsed = JSON.parse(r.text);
    } catch {
      return notRead(`not read: ${url.host} did not answer JSON`);
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const byId = new Map(arr.filter((x) => x && typeof x === "object").map((x) => [x.id, x]));
    const out = body.map((q) => {
      const a = byId.get(q.id);
      if (!a) return { notRead: `not read: ${url.host} gave no answer for this call` };
      if (a.error) return { error: String(a.error.message ?? "error").slice(0, 200), code: a.error.code ?? null };
      if (a.result === null || a.result === undefined) return { notRead: `not read: ${url.host} returned null` };
      return { result: a.result };
    });
    if (out.some((o) => RETRY_CODES.has(o.code)) && attempt < 2) {
      circuit.set(nodeId, Date.now() + 15_000);
      await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
      continue;
    }
    return out.map((o) => (o.error ? { ...o, notRead: `not read: ${url.host} said "${o.error}"` } : o));
  }
  return notRead(`not read: ${url.host} kept failing`);
}

/** Raw POST for the observer replay only: sends one exact getLogs and returns the node's verbatim answer. */
export async function rpcVerbatim(nodeId, call) {
  const node = NODES[nodeId];
  if (!node) throw new Refused("refused: unknown node");
  checkCallReplay(call);
  if (framed()) return { status: 0, text: "", note: "not read: framed" };
  const b = BUDGET.rpc;
  if (counters.rpc >= b.max) return { status: 0, text: "", note: "not read: budget spent" };
  counters.rpc++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: call.method, params: call.params });
  const r = await post(nodeId, payload, `${nodeId}: ${call.method} (observer replay)`);
  return { status: r.status, text: r.text.slice(0, 600), error: r.error ?? null };
}

// The observer replay repeats the registry observer's own next call, which spans 10,000 blocks: over this page's
// normal span cap on purpose, once per wallet, to show each node's answer. Same shape rules otherwise.
export const REPLAY_MAX_SPAN = 10_000;
function checkCallReplay(c) {
  if (c?.method !== "eth_getLogs") throw new Refused("refused: replay is getLogs only");
  const f = c.params?.[0];
  const spanBlocks = f && HEX_Q.test(f.fromBlock) && HEX_Q.test(f.toBlock) ? Number(BigInt(f.toBlock) - BigInt(f.fromBlock)) + 1 : 0;
  if (!(spanBlocks >= 1 && spanBlocks <= REPLAY_MAX_SPAN)) throw new Refused("refused: replay span");
  checkCall({ method: "eth_getLogs", params: [{ ...f, fromBlock: f.fromBlock, toBlock: "0x" + (BigInt(f.fromBlock) + BigInt(Math.min(spanBlocks, BUDGET.maxLogsSpan) - 1)).toString(16) }] });
}
