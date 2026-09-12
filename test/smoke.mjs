#!/usr/bin/env node
// test/smoke.mjs · TICK & TIE · a headless Chromium smoke test over the DevTools protocol. It is the run-time half of
// scripts/check-readonly.mjs: what a file cannot show (a name assembled at run time, a listener that really exists, a
// request that is really made, what is left in storage afterwards) is what this watches.
// Node >= 22 standard library only: node:http serves docs/, the global WebSocket speaks CDP.
//
// What it proves in a real browser, from the live DOM, the listener tape and the network log (not from the source):
//   - nowhere to type: after every route of the router — the ten named views plus one #/p/<handle> trail and one
//     #/<k>/<sub> drawer — with every <details> opened, there are 0 input/textarea/select/form/option/datalist/output/
//     label/fieldset/legend/iframe/object/embed/foreignObject/[contenteditable]/textbox roles, every <button> is
//     type="button", and document.designMode is "off";
//   - nothing listens for typing: addEventListener is replaced before the page loads with a recorder that cannot be
//     put back, so every listener registered anywhere (document, window, any element) is named whatever its event name
//     was built from — and only "click" and "hashchange" are allowed. DOMDebugger.getEventListeners asks the browser
//     the same question about window, document and <body>. This is the answer to names a static scan cannot read;
//   - the CSP holds: 0 securitypolicyviolation events, and assigning innerHTML throws (Trusted Types);
//   - reads only: every request to 1f916.ai, base.blockscout.com and raw.githubusercontent.com is GET; every POST goes
//     to a node in net.js NODES and its JSON body uses only net.js RPC_METHODS; nothing leaves the CSP's connect-src
//     (plus 'self'); no worker or frame is created; no request carries a cookie or authorization header;
//   - nothing is stored: after the run localStorage and sessionStorage are empty, indexedDB.databases() is empty, and
//     document.cookie is empty;
//   - no polling: once the page has settled, --idle seconds pass with zero new requests.
// What it does not prove: that the page is honest about Base (that is the two-node rule), that the registry serves
// every reader the same documents, or anything about a route or a listener that no run here reached. It exercises one
// browser, one viewport pair, and whatever the fixtures (or the live registry) answered on the day.
// It prints a method × origin table and the listener tape, saves screenshots at 1280×900 and 400×860 in
// test/screenshots/ (git-ignored), and exits 0 on PASS, 1 on FAIL (including "docs/index.html does not exist yet"),
// 2 if it cannot run (no Chromium).
//
// Usage:  node test/smoke.mjs [--fixtures | --live] [--idle <s>] [--docs <dir>] [--chrome <path>] [--no-shots]
//   --fixtures (default)  nothing leaves this machine: the Fetch domain answers every non-local request from
//                         test/fixtures/, and Chromium resolves no host name at all (a second fence)
//   --live                the page reads the real registry (GET) and Base nodes (JSON-RPC reads); run it deliberately
//   --idle                quiet period after settling, in seconds: 5 with fixtures, 60 live
//
// Fixture mapping (--fixtures). A missing fixture answers HTTP 503, so the page prints "not read", never a guess.
//   GET  https://<host>/<path>?<query> → test/fixtures/web/<host>/<path>[__<query>].json, where <query> is the raw
//        query with [^\w.=&-] replaced by "_" (witness days: web/raw.githubusercontent.com/…/<day>.jsonl). Aliases for
//        the files already in test/fixtures/: /api/checkpoint → checkpoint.json · /treasury → treasury.json ·
//        /api/payout-bindings/<n> → binding-<n>.json · /api/proof?…event=<n> → proof-<n>.json ·
//        /api/checkpoint/consistency?…from=<a>&to=<b> → consistency-<a>-<b>.json · /api/events?kind=payout-receipt
//        → events-payout-receipt.json
//   POST (one JSON-RPC call or a batch): each call → test/fixtures/rpc/<method>__<key>.json holding the bare `result`,
//        key = the tx hash for eth_getTransactionReceipt, else sha256(JSON.stringify(params)) cut to 16 hex. Receipts
//        also come from receipts-8.json for the node that served them. eth_chainId answers 0x2105 (built in). In a
//        batch, calls without a fixture get a JSON-RPC error; a request with none found gets 503.
//   CORS preflights (OPTIONS) are answered 204 with the headers a public node sends.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, extname, sep } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const LIVE = args.includes("--live");
const DOCS = resolve(opt("--docs", join(ROOT, "docs")));
const IDLE_S = Number(opt("--idle", LIVE ? 60 : 5));
const FIX = join(ROOT, "test/fixtures");
const SHOTS = join(ROOT, "test/screenshots");
// Every route the page has: the ten named views, plus the two the router builds from a value — #/p/<handle> (a
// citizen's trail) and #/<k>/<sub> (a line's drawer). The last two are taken from the page's own links when it offers
// them, so the handle and the line ref are real ones, and fall back to a literal route when a fixture run has neither.
const ROUTES = ["#/", "#/a", "#/c", "#/l", "#/f", "#/g", "#/d", "#/people", "#/tape", "#/legend"];
const ROUTE_FALLBACK = { trail: "#/p/popek1990", drawer: "#/a/A-1" };
const FIELDS = "input,textarea,select,form,option,optgroup,datalist,output,label,fieldset,legend,iframe,frame,object,embed,portal,foreignObject,[contenteditable],[role~=textbox],[role~=searchbox],[role~=combobox],[role~=spinbutton]";
// Listeners the page is allowed to register, and the kinds that would mean it takes typing, a paste or a message.
const LISTENER_OK = new Set(["click", "hashchange"]);
const LISTENER_OURS = new Set(["securitypolicyviolation"]); // this file's own probe, added before the recorder
const TYPING_LISTENER = /^(key(down|up|press)|beforeinput|input|change|paste|cut|copy|composition(start|update|end)|message|messageerror)$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = new Map(); // message → times seen
const fail = (msg) => failures.set(msg, (failures.get(msg) ?? 0) + 1);

// ---- preconditions ------------------------------------------------------------------------------------------------
if (!existsSync(join(DOCS, "index.html"))) {
  console.log(`smoke · TICK & TIE · ${LIVE ? "live" : "fixtures"}\nFAIL  ${join(DOCS, "index.html")} does not exist yet: there is no page to load.\nRESULT: FAIL · exit 1`);
  process.exit(1);
}
let net;
try {
  net = await import(pathToFileURL(join(DOCS, "js/net.js")).href);
} catch (e) {
  console.log(`FAIL  docs/js/net.js did not import in Node (${e.message}); its allowlists are the reference.\nRESULT: FAIL · exit 1`);
  process.exit(1);
}
const home = join(homedir(), ".cache/ms-playwright");
const CHROME = [opt("--chrome"), process.env.CHROME_BIN, join(home, "chromium-1208/chrome-linux64/chrome"), join(home, "chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell")].find((p) => p && existsSync(p));
if (!CHROME) {
  console.error("smoke: no Chromium found (tried --chrome, $CHROME_BIN and ~/.cache/ms-playwright/…-1208); cannot run");
  process.exit(2);
}
const ORIGINS = net.FETCH_ORIGINS;
const NODE_ORIGINS = new Map(Object.entries(net.NODES).map(([id, n]) => [new URL(n.url).origin, id]));
const GET_ONLY = new Set(ORIGINS.map((o) => new URL(o).origin).filter((o) => !NODE_ORIGINS.has(o)));
// A GET must also be one net.js would send: a REGISTRY_ROUTES / INDEXER_ROUTES path with allowlisted query keys, or
// a witness day file. The same lists net.js enforces, read from net.js itself.
const WITNESS_PREFIX = ORIGINS.find((o) => o.startsWith(net.WITNESS ?? "https://raw.githubusercontent.com"));
function routeProblem(u) {
  const list = u.origin === new URL(net.REGISTRY).origin ? net.REGISTRY_ROUTES : u.origin === new URL(net.INDEXER).origin ? net.INDEXER_ROUTES : null;
  if (list) {
    const r = list.find((x) => x.path.test(u.pathname));
    if (!r) return "a path on no route list in net.js";
    const extra = [...u.searchParams.keys()].filter((k) => !r.query.includes(k));
    return extra.length ? `query key(s) ${extra.join(", ")} not allowlisted for that route` : null;
  }
  if (WITNESS_PREFIX && u.origin === new URL(WITNESS_PREFIX).origin) return u.href.startsWith(WITNESS_PREFIX) && /\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(u.pathname) && !u.search ? null : "not a witness day file";
  return null;
}

// ---- a static server for docs/, like GitHub Pages (no CSP header: the page carries its own in a meta tag) ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" };
const server = createServer((req, res) => {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    return res.writeHead(400).end();
  }
  if (p.endsWith("/")) p += "index.html";
  const file = resolve(DOCS, "." + p);
  if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
  if (!file.startsWith(DOCS + sep) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : readFileSync(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const SELF = `http://127.0.0.1:${server.address().port}`;

// ---- Chromium and a small CDP client --------------------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), "smoke-chrome-"));
const flags = [CHROME.includes("headless-shell") ? "--headless" : "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-extensions", "--disable-sync", "--metrics-recording-only", "--mute-audio", "--hide-scrollbars", "--window-size=1280,900"];
if (!LIVE) flags.push("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
if (process.env.SMOKE_NO_SANDBOX) flags.push("--no-sandbox");
const proc = spawn(CHROME, [...flags, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try {
    proc.kill("SIGKILL");
  } catch {}
  try {
    server.close();
  } catch {}
  // The browser may still be writing its profile as it dies; a temporary directory that outlives this run is not a
  // finding about the page, so it never decides the exit code.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {}
};
process.on("exit", cleanup); // any exit, including an unexpected CDP error, leaves no browser and no profile behind
const giveUp = (why) => {
  console.error(`smoke: ${why}`);
  cleanup();
  process.exit(2);
};
setTimeout(() => giveUp("gave up after 10 minutes"), 600_000).unref();
process.on("SIGINT", () => giveUp("interrupted"));
process.on("SIGTERM", () => giveUp("terminated"));
const wsUrl = await new Promise((ok, bad) => {
  let buf = "";
  const t = setTimeout(() => bad(new Error(`Chromium did not start: ${buf.slice(-300)}`)), 20_000);
  proc.stderr.on("data", (d) => {
    if (buf === null) return;
    buf += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) {
      clearTimeout(t);
      buf = null;
      ok(m[1]);
    }
  });
  proc.on("exit", (c) => bad(new Error(`Chromium exited with ${c}`)));
}).catch((e) => {
  console.error(`smoke: ${e.message}`);
  cleanup();
  process.exit(2);
});
const ws = new WebSocket(wsUrl);
await new Promise((ok, bad) => {
  ws.addEventListener("open", ok);
  ws.addEventListener("error", () => bad(new Error("CDP websocket error")));
});
let seq = 0;
const pending = new Map();
const handlers = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.bad(new Error(`${p.method}: ${m.error.message}`));
    else p.ok(m.result);
  } else for (const h of handlers) h(m);
});
const call = (method, params = {}, sessionId) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((ok, bad) => pending.set(id, { ok, bad, method }));
};

// ---- the page session -------------------------------------------------------------------------------------------------
const { targetId } = await call("Target.createTarget", { url: "about:blank" });
const { sessionId: S } = await call("Target.attachToTarget", { targetId, flatten: true });
const send = (method, params) => call(method, params, S);
const requests = [];
const inflight = new Set();
let lastNet = Date.now();
let phase = "load";
const cspLog = [];
const exceptions = [];
const children = [];
handlers.push((m) => {
  const p = m.params ?? {};
  if (m.sessionId !== S) return;
  if (m.method === "Target.attachedToTarget") return children.push(`${p.targetInfo?.type} ${p.targetInfo?.url}`); // auto-attached under the page
  if (m.method === "Network.requestWillBeSent") {
    const r = p.request;
    requests.push({ id: p.requestId, url: r.url, method: r.method, post: r.postData ?? null, hasPost: !!r.hasPostData, headers: r.headers ?? {}, type: p.type, phase });
    inflight.add(p.requestId);
    lastNet = Date.now();
  } else if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") {
    inflight.delete(p.requestId);
    lastNet = Date.now();
  } else if (m.method === "Log.entryAdded" && /Content Security Policy|Trusted Type/i.test(p.entry?.text ?? "")) cspLog.push(p.entry.text.slice(0, 200));
  else if (m.method === "Runtime.exceptionThrown") exceptions.push(String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text).split("\n")[0]);
  else if (m.method === "Fetch.requestPaused") answer(p).catch(() => send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Failed" }).catch(() => {}));
});

// ---- fixtures ---------------------------------------------------------------------------------------------------------------
const CORS = [{ name: "access-control-allow-origin", value: "*" }, { name: "access-control-allow-headers", value: "content-type, accept" }, { name: "access-control-allow-methods", value: "GET, POST" }];
const receipts = existsSync(join(FIX, "receipts-8.json")) ? JSON.parse(readFileSync(join(FIX, "receipts-8.json"), "utf8")) : {};
function webCandidates(u) {
  const q = u.search ? "__" + u.search.slice(1).replace(/[^\w.=&-]/g, "_") : "";
  const c = [join(FIX, "web", u.host, ...u.pathname.split("/").filter(Boolean)) + q + (u.pathname.endsWith(".jsonl") ? "" : ".json")];
  if (u.host === "1f916.ai") {
    const qp = u.searchParams;
    const b = /^\/api\/payout-bindings\/(\d+)$/.exec(u.pathname);
    if (u.pathname === "/api/checkpoint") c.push(join(FIX, "checkpoint.json"));
    if (u.pathname === "/treasury") c.push(join(FIX, "treasury.json"));
    if (b) c.push(join(FIX, `binding-${b[1]}.json`));
    if (u.pathname === "/api/proof" && qp.get("event")) c.push(join(FIX, `proof-${qp.get("event")}.json`));
    if (u.pathname === "/api/checkpoint/consistency") c.push(join(FIX, `consistency-${qp.get("from")}-${qp.get("to")}.json`));
    if (u.pathname === "/api/events" && qp.get("kind") === "payout-receipt" && [...qp.keys()].length === 1) c.push(join(FIX, "events-payout-receipt.json"));
  }
  return c;
}
function rpcOne(host, q) {
  if (q?.method === "eth_chainId") return { result: "0x2105" };
  const receipt = q?.method === "eth_getTransactionReceipt";
  const key = receipt ? String(q.params?.[0]).toLowerCase() : createHash("sha256").update(JSON.stringify(q?.params ?? [])).digest("hex").slice(0, 16);
  if (!/^\w{1,64}$/.test(String(q?.method)) || !/^[0-9a-fx]{1,66}$/.test(key)) return null; // names from the request never walk the disk
  const f = join(FIX, "rpc", `${q.method}__${key}.json`);
  if (existsSync(f)) return { result: JSON.parse(readFileSync(f, "utf8")) };
  const a = receipt ? receipts[NODE_ORIGINS.get(`https://${host}`)]?.[key] : null;
  return a?.result ? { result: a.result } : null;
}
function rpcAnswer(u, text) {
  let b;
  try {
    b = JSON.parse(text);
  } catch {
    return [400, '{"error":"not JSON"}'];
  }
  const list = Array.isArray(b) ? b : [b];
  const got = list.map((q) => rpcOne(u.host, q));
  if (got.every((a) => a === null)) return [503, '{"error":"no fixture"}'];
  const out = got.map((a, i) => ({ jsonrpc: "2.0", id: list[i]?.id ?? null, ...(a ?? { error: { code: -32000, message: "no fixture for this call" } }) }));
  return [200, JSON.stringify(Array.isArray(b) ? out : out[0])];
}
async function answer(p) {
  const { requestId, request } = p;
  const u = new URL(request.url);
  if (u.origin === SELF) return send("Fetch.continueRequest", { requestId });
  let status = 204;
  let body = "";
  if (request.method === "GET") {
    const f = webCandidates(u).find((x) => resolve(x).startsWith(FIX + sep) && existsSync(x));
    [status, body] = f ? [200, readFileSync(f, "utf8")] : [503, '{"error":"no fixture"}'];
  } else if (request.method === "POST") {
    const text = request.postDataEntries ? request.postDataEntries.map((e) => Buffer.from(e.bytes ?? "", "base64").toString("utf8")).join("") : request.postData ?? "";
    [status, body] = rpcAnswer(u, text);
  } else if (request.method !== "OPTIONS") return send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
  const type = u.pathname.endsWith(".jsonl") ? "application/x-ndjson" : "application/json";
  return send("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: [...CORS, { name: "content-type", value: type }], body: Buffer.from(body).toString("base64") });
}

// ---- drive the page -------------------------------------------------------------------------------------------------------
// Runs before any page script, in every document. It records CSP violations, then replaces
// EventTarget.prototype.addEventListener with a recorder, so that every listener the page registers — on document, on
// window, on any element — is named and counted. The replacement is not writable and not configurable: page code
// cannot put the original back. Its own securitypolicyviolation listener is added first, so it is not in the tape.
const PROBE = [
  'Object.defineProperty(window, "__smokeCsp", { value: [] });',
  'document.addEventListener("securitypolicyviolation", (e) => window.__smokeCsp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile || ""}:${e.lineNumber || ""}`), true);',
  'Object.defineProperty(window, "__smokeListeners", { value: [] });',
  "(() => {",
  "  const add = EventTarget.prototype.addEventListener;",
  "  const where = (t) => {",
  "    try {",
  '      if (t === window) return "window";',
  '      if (t === document) return "document";',
  '      if (t && t.nodeType === 9) return "a document";',
  '      if (t && t.nodeType === 1) return t.tagName.toLowerCase() + (t.id ? "#" + t.id : "") + (typeof t.className === "string" && t.className ? "." + t.className.trim().split(/\\s+/)[0] : "");',
  "      return Object.prototype.toString.call(t);",
  '    } catch (e) { return "?"; }',
  "  };",
  '  Object.defineProperty(EventTarget.prototype, "addEventListener", {',
  "    value: function (type, fn, opts) {",
  '      try { window.__smokeListeners.push(String(type) + " on " + where(this)); } catch (e) {}',
  "      return add.apply(this, arguments);",
  "    },",
  "    writable: false, configurable: false, enumerable: false,",
  "  });",
  "})();",
].join("\n");
const DOM = `(() => {
  const found = [], roots = [document];
  while (roots.length) { const r = roots.pop(); for (const e of r.querySelectorAll("*")) if (e.shadowRoot) roots.push(e.shadowRoot); for (const e of r.querySelectorAll(${JSON.stringify(FIELDS)})) found.push(e.outerHTML.slice(0, 100)); }
  const buttons = [...document.querySelectorAll("button")];
  return { found, designMode: document.designMode, untyped: buttons.filter((b) => b.getAttribute("type") !== "button").map((b) => b.outerHTML.slice(0, 100)), buttons: buttons.length, details: document.querySelectorAll("details").length, dialogs: document.querySelectorAll("dialog").length, csp: window.__smokeCsp.slice() };
})()`;
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
// Waits until nothing is in flight and nothing new was sent for quietMs. A page that never goes quiet is already a
// failure; after the first timeout the remaining waits are cut to 5 s so the run still ends in minutes.
let noisy = false;
async function settle(quietMs, capMs) {
  const t0 = Date.now();
  const cap = noisy ? Math.min(capMs, 5000) : capMs;
  for (;;) {
    await sleep(250);
    if (!inflight.size && Date.now() - lastNet >= quietMs) return true;
    if (Date.now() - t0 > cap) {
      noisy = true;
      return false;
    }
  }
}
const metrics = (w, h, mobile) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable", { maxPostDataSize: 1 << 20 });
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
if (!LIVE) await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
await metrics(1280, 900, false);
const nav = await send("Page.navigate", { url: `${SELF}/` });
if (nav.errorText) fail(`navigation failed: ${nav.errorText}`);
if (!(await settle(5000, 90_000))) fail("the first load did not settle (5 s without a request) within 90 s");
if (!args.includes("--no-shots")) mkdirSync(SHOTS, { recursive: true });
const perRoute = [];
const linked = { trail: null, drawer: null };
const firstHref = (re) => `(() => { for (const a of document.querySelectorAll("a[href]")) { const h = a.getAttribute("href"); if (${re}.test(h)) return h; } return null; })()`;
async function visit(route) {
  phase = route;
  await evaluate(`location.hash = ${JSON.stringify(route)}`);
  if (!(await settle(2000, 45_000))) fail(`${route}: the network never went quiet for 2 s`);
  await evaluate('document.querySelectorAll("details").forEach((d) => { d.open = true; })');
  await settle(1000, 30_000);
  const d = await evaluate(DOM);
  perRoute.push({ route, ...d });
  if (d.found.length) fail(`${route}: ${d.found.length} field-like element(s): ${d.found.slice(0, 2).join(" | ")}`);
  if (d.untyped.length) fail(`${route}: <button> without type="button": ${d.untyped[0]}`);
  if (d.designMode !== "off") fail(`${route}: document.designMode is ${d.designMode}`);
  linked.trail ??= await evaluate(firstHref("/^#\\/p\\/[^/]+$/"));
  linked.drawer ??= await evaluate(firstHref("/^#\\/[acdfgl]\\/.+$/"));
  if (!args.includes("--no-shots")) {
    const name = (route.slice(2) || "today").replace(/[^\w.-]+/g, "-");
    for (const [w, h, mobile] of [[1280, 900, false], [400, 860, true]]) {
      await metrics(w, h, mobile);
      await sleep(300);
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(SHOTS, `${name}-${w}.png`), Buffer.from(data, "base64"));
    }
    await metrics(1280, 900, false);
  }
}
for (const route of ROUTES) await visit(route);
// The two routes built from a value. A drawer route also opens the <dialog>, so the fields count covers what it builds.
await visit(linked.trail ?? ROUTE_FALLBACK.trail);
await visit(linked.drawer ?? ROUTE_FALLBACK.drawer);
phase = "settle";
await settle(5000, 60_000);
phase = "idle";
const before = requests.length;
await sleep(IDLE_S * 1000);
const idle = requests.slice(before);
if (idle.length) fail(`${idle.length} request(s) in the ${IDLE_S} s after the page settled (polling?): ${idle.slice(0, 3).map((r) => `${r.method} ${r.url}`).join(", ")}`);
const csp = (await evaluate("window.__smokeCsp.slice()")) ?? [];
if (csp.length || cspLog.length) fail(`${csp.length} securitypolicyviolation event(s), ${cspLog.length} CSP console message(s): ${[...csp, ...cspLog].slice(0, 3).join(" | ")}`);
const tt = await evaluate('(() => { try { document.createElement("div").innerHTML = "x"; return "assigned"; } catch (e) { return e.name; } })()');
if (tt !== "TypeError") fail(`Trusted Types: assigning innerHTML ${tt === "assigned" ? "was allowed" : `gave ${tt}`}`);
if (children.length) fail(`child targets created (worker-src/frame-src are 'none'): ${children.join(", ")}`);

// ---- which listeners exist, from the run itself ---------------------------------------------------------------------
// The static scan cannot read an event name assembled at run time (["key","down"].join("")); this can. Every
// addEventListener call the page made is in the tape, whatever the name was built from, and the kinds are the whole
// claim: clicks and hashchange, nothing that takes typing, a paste or a message.
const tape = new Map();
for (const entry of (await evaluate("window.__smokeListeners.slice()")) ?? []) tape.set(entry, (tape.get(entry) ?? 0) + 1);
for (const [entry, n] of tape) {
  const type = entry.split(" on ")[0];
  if (TYPING_LISTENER.test(type)) fail(`a "${type}" listener was registered at run time (${entry}${n > 1 ? ` ×${n}` : ""}): this page takes no typing, paste or message input`);
  else if (!LISTENER_OK.has(type)) fail(`an unexpected listener kind registered at run time: "${entry}" (this page needs only ${[...LISTENER_OK].join(" and ")})`);
}
// The same question asked of the browser instead of the page, in case something reached addEventListener another way.
const cdpListeners = async (expression) => {
  const r = await send("Runtime.evaluate", { expression }).catch(() => null);
  const objectId = r?.result?.objectId;
  if (!objectId) return null;
  const got = await send("DOMDebugger.getEventListeners", { objectId, depth: -1, pierce: true }).catch(() => null);
  await send("Runtime.releaseObject", { objectId }).catch(() => {});
  return got ? (got.listeners ?? []).map((l) => l.type) : null;
};
const cdpSeen = [];
for (const [what, expression] of [["window", "window"], ["document and its subtree", "document"], ["<body> and its subtree", "document.body"]]) {
  const types = await cdpListeners(expression);
  if (types === null) {
    cdpSeen.push(`${what}: not read`);
    continue;
  }
  const counted = new Map();
  for (const t of types) if (!LISTENER_OURS.has(t)) counted.set(t, (counted.get(t) ?? 0) + 1);
  cdpSeen.push(`${what}: ${[...counted].map(([t, n]) => `${t} ×${n}`).join(", ") || "none"}`);
  for (const t of types) {
    if (LISTENER_OURS.has(t)) continue;
    if (TYPING_LISTENER.test(t)) fail(`DOMDebugger: a "${t}" listener is attached to ${what}`);
    else if (!LISTENER_OK.has(t)) fail(`DOMDebugger: an unexpected "${t}" listener is attached to ${what}`);
  }
}

// ---- nothing was stored ---------------------------------------------------------------------------------------------
const storage = (await evaluate(`(async () => {
  const out = { local: null, session: null, cookie: document.cookie, dbs: null, notes: [] };
  try { out.local = localStorage.length; } catch (e) { out.notes.push("localStorage " + e.name); }
  try { out.session = sessionStorage.length; } catch (e) { out.notes.push("sessionStorage " + e.name); }
  try { out.dbs = (await indexedDB.databases()).map((d) => d.name); } catch (e) { out.notes.push("indexedDB.databases() " + e.name); }
  return out;
})()`)) ?? {};
if (storage.local) fail(`localStorage holds ${storage.local} key(s) after the run`);
if (storage.session) fail(`sessionStorage holds ${storage.session} key(s) after the run`);
if (Array.isArray(storage.dbs) && storage.dbs.length) fail(`${storage.dbs.length} IndexedDB database(s) after the run: ${storage.dbs.join(", ")}`);
if (storage.cookie) fail(`document.cookie is not empty after the run: ${String(storage.cookie).slice(0, 80)}`);

// ---- the network log -------------------------------------------------------------------------------------------------------
const inCsp = (url) => {
  const u = new URL(url);
  if (u.origin === SELF) return true;
  return ORIGINS.some((s) => {
    const su = new URL(s);
    if (su.origin !== u.origin) return false;
    if (s.endsWith("/")) return u.href.startsWith(s);
    return su.pathname === "/" ? true : u.origin + u.pathname === s;
  });
};
const table = new Map();
for (const r of requests) {
  let origin = "(unparseable)";
  try {
    origin = new URL(r.url).origin;
  } catch {}
  const key = `${r.method} ${origin === "null" ? r.url.slice(0, 30) : origin}`;
  table.set(key, (table.get(key) ?? 0) + 1);
  if (origin === "null" || !inCsp(r.url)) fail(`outside connect-src: ${r.method} ${r.url.slice(0, 120)}`);
  if (GET_ONLY.has(origin) && r.method !== "GET") fail(`${r.method} to ${origin} (GET only): ${r.url.slice(0, 120)}`);
  if (NODE_ORIGINS.has(origin) && !["POST", "OPTIONS"].includes(r.method)) fail(`${r.method} to the Base node ${origin} (JSON-RPC POSTs only)`);
  if (r.method === "GET" && GET_ONLY.has(origin)) {
    const why = routeProblem(new URL(r.url));
    if (why) fail(`GET ${r.url.slice(0, 120)}: ${why}`);
  }
  if (Object.keys(r.headers).some((h) => /^(authorization|cookie)$/i.test(h))) fail(`credentials sent with ${r.method} ${r.url.slice(0, 100)}`);
  if (r.method === "POST") {
    if (!NODE_ORIGINS.has(origin)) fail(`POST to ${origin}, which is not a Base node in net.js NODES`);
    let body = r.post;
    if (body === null && r.hasPost) body = (await send("Network.getRequestPostData", { requestId: r.id }).catch(() => ({}))).postData ?? null;
    let methods = null;
    try {
      const b = JSON.parse(body);
      methods = (Array.isArray(b) ? b : [b]).map((x) => x?.method);
    } catch {}
    if (!methods) fail(`POST to ${origin} without a readable JSON-RPC body`);
    else if (methods.some((m) => !net.RPC_METHODS.includes(m))) fail(`POST to ${origin} carries ${methods.filter((m) => !net.RPC_METHODS.includes(m)).join(", ")}, outside RPC_METHODS`);
  } else if (r.method === "OPTIONS") {
    if (!NODE_ORIGINS.has(origin)) fail(`a CORS preflight to ${origin} (only JSON-RPC POSTs to nodes should need one)`);
  } else if (r.method !== "GET") fail(`${r.method} ${r.url.slice(0, 120)}`);
}

// ---- report ---------------------------------------------------------------------------------------------------------------------
const out = [`smoke · TICK & TIE · ${LIVE ? "live" : "fixtures (nothing left this machine)"} · ${CHROME.split("/").slice(-1)[0]} · ${SELF}`];
out.push("routes (fields · untyped buttons · designMode · buttons/details/dialogs):");
for (const r of perRoute) out.push(`  ${r.route.padEnd(14)} ${r.found.length} · ${r.untyped.length} · ${r.designMode} · ${r.buttons}/${r.details}/${r.dialogs}`);
out.push(`requests: ${requests.length} (method × origin)`);
for (const [k, n] of [...table].sort()) out.push(`  ${String(n).padStart(4)}  ${k}`);
out.push(`idle ${IDLE_S} s after settling: ${idle.length} new requests · securitypolicyviolation events: ${csp.length} (CSP console messages: ${cspLog.length}) · Trusted Types: innerHTML ${tt === "TypeError" ? "throws" : tt}`);
out.push(`listeners registered during the run: ${[...tape.values()].reduce((a, b) => a + b, 0)} (every addEventListener call, whatever built its name)`);
for (const [entry, n] of [...tape].sort()) out.push(`  ${String(n).padStart(4)}  ${entry}`);
out.push(`  DOMDebugger, asked of the browser: ${cdpSeen.join(" · ")}`);
out.push(`storage after the run: localStorage ${storage.local ?? "?"} keys · sessionStorage ${storage.session ?? "?"} keys · indexedDB ${Array.isArray(storage.dbs) ? `${storage.dbs.length} databases` : storage.dbs ?? "?"} · document.cookie ${storage.cookie ? storage.cookie.length + " bytes" : "empty"}${storage.notes?.length ? ` · ${storage.notes.join("; ")}` : ""}`);
if (exceptions.length) out.push(`page exceptions (not a failure by themselves): ${exceptions.length}: ${[...new Set(exceptions)].slice(0, 3).join(" | ")}`);
if (!args.includes("--no-shots")) out.push(`screenshots: ${perRoute.length * 2} in test/screenshots/ (1280×900 and 400×860)`);
for (const [f, n] of failures) out.push(`FAIL  ${n > 1 ? `(×${n}) ` : ""}${f}`);
out.push(`RESULT: ${failures.size ? "FAIL" : "PASS"} · exit ${failures.size ? 1 : 0}`);
console.log(out.join("\n"));
await call("Browser.close").catch(() => {});
cleanup();
process.exit(failures.size ? 1 : 0);
