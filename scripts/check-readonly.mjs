#!/usr/bin/env node
// check-readonly.mjs · TICK & TIE
//
// Checks, from the files alone (no network by default), the three conditions of listing 23:
//   1. the page reads and never writes ........ R1–R10
//   2. there is nowhere to type ................ T1–T4
//   3. it is signed and its source is open ..... S1–S7
//   plus hygiene ............................... H1–H4
// The live DOM, the listeners a run really registers and the network log of a real browser are test/smoke.mjs; this
// script cannot stand in for it, and says so in LIMITS.
// Every check prints its ID. Every FAIL prints file:line and the offending line.
//
// Usage (Node >= 22, standard library only; exit 0 = pass, 1 = a check failed, 2 = usage or internal error):
//   node scripts/check-readonly.mjs                  every check, then the planted-violation self-test
//   node scripts/check-readonly.mjs --json           the same, as JSON on stdout
//   node scripts/check-readonly.mjs --self-test      only the self-test (plants each violation in a temp copy)
//   node scripts/check-readonly.mjs --no-self-test   every check, without the self-test
//   node scripts/check-readonly.mjs --deployed URL   also GET every docs/ file from the live site, compare sha256
//   node scripts/check-readonly.mjs --live-surface   also GET https://1f916.ai/api/surface once and re-check H2
//   node scripts/check-readonly.mjs --root DIR       check another checkout
//
// How: JS is read by a small tokenizer that knows comments, strings, template literals and regex literals, so a
// word inside a comment (net.js's header literally says "fetch() call site") never counts as code. Markup is read
// twice: once with an exact attribute parser, once permissively, because `<input name=a"b>` and `<input data/x>`
// defeat the first and Chromium builds a real field from both. Served .svg files are read in their own right: the
// CSP is a <meta> tag inside index.html and does not reach a file Pages serves at its own URL. docs/js/net.js
// is IMPORTED, not grepped: the CSP, the RPC allowlist and the selectors are compared with the values the page
// really runs, and R8 drives net.js through a stub fetch with 60+ cases, so no byte leaves this machine. Planted
// violations live as strings in this file and are only ever written into a temporary copy under os.tmpdir().
//
// Credit: the idea of a script that fails the build when a read-only page could write or take input is The Fold's
// check-readonly.py, by tardis-relay. This is a separate implementation for a different design (it allows exactly
// one POST site and proves what that site can and cannot send). No code is copied.
//
// Do not trust this script; it sits next to what it audits. The LIMITS paragraph at the end of each run says what it
// cannot see.

import { readFileSync, readdirSync, lstatSync, existsSync, mkdtempSync, cpSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, sep, extname, basename, dirname, resolve } from "node:path";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setDefaultResultOrder } from "node:dns";

// github.io publishes AAAA records. On a host with no IPv6 route, Node's happy-eyeballs picks one often enough
// that --deployed reported "fetch failed" on a handful of files per run, which reads as a failed audit of the
// published page when the bytes are in fact identical. Prefer A records; Node still falls back either way. This
// changes how this script reaches the network and nothing about what it checks.
setDefaultResultOrder("ipv4first");

const SELF = fileURLToPath(import.meta.url);
const realFetch = globalThis.fetch;
// Network off: once main() starts, any fetch() (including one net.js might make at import time) throws and is counted.
const netAttempts = [];
const offline = async (u) => {
  netAttempts.push(String(u));
  throw new Error("check-readonly: the network is off in this run");
};

// ---- pinned expectations (independent of the files under test) ---------------------------------------------
const PIN = {
  handle: "popek1990",
  citizen: "#2378",
  key: "zl98d2fgq22xnL0EoE0PhyryQsSEhY0OU7PcWWc9Y_o", // GET /api/keys/popek1990, 2026-09-11
  thumbprint: "aHNshzoake5VHs5aJJbsx9GBNPwh-hIB_weUpka7K4k",
  listing: "https://1f916.ai/api/listings/23",
};
const PAGES = ["index.html"]; // the only HTML Pages may serve: a 404.html would be a second page (critique §2.6)
const DECLARED = ["index.html", "style.css"]; // entry points (design.md §5.13)
const CAP = { ".html": 1e5, ".js": 1e5, ".css": 1e5, ".json": 2.5e6, ".svg": 1e5, ".woff2": 3e5, ".woff": 3e5, ".txt": 1e5, ".md": 1e5, ".ico": 5e4, ".png": 5e5 };
const NOEXT = new Set([".nojekyll", "CNAME"]);
const TEXT = new Set([".html", ".js", ".css", ".json", ".svg", ".txt", ".md"]);
// Read-only JSON-RPC methods a line may use (critique §6 R6; eth_getBalance/eth_getTransactionCount only if used).
const RPC_READS = ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_call", "eth_getLogs", "eth_getCode", "eth_getBalance", "eth_getTransactionCount"];
const RPC_BANNED = /\b(?:eth_(?:send|sign)\w*|personal_\w+|wallet_\w+|eth_accounts|eth_requestAccounts|\w*signTypedData\w*|eth_subscribe|eth_newFilter|eth_newBlockFilter|eth_newPendingTransactionFilter|debug_\w+|admin_\w+|txpool_\w+|engine_\w+|miner_\w+)\b/g;
// Read signatures with their selectors, computed by the security review's independent keccak (critique §5.7).
const READS = {
  "balanceOf(address)": "0x70a08231", "totalSupply()": "0x18160ddd", "decimals()": "0x313ce567", "symbol()": "0x95d89b41",
  "allowance(address,address)": "0xdd62ed3e", "totalAllocatedOf(address)": "0xf5009604", "vestingStart()": "0x254800d4",
  "computeAvailableVestedAmount(address)": "0x4c869795", "getScheduleIdsOf(address)": "0xd2482469",
  "vestingOf(address,uint256)": "0x6f503e67", "vestingSchedules(uint256)": "0x6d3cbe21",
  "vestedTotalAmount()": "0xf68d90d8", "vestedTotalAmount(address)": "0xa7e62537",
};
// Write selectors that must appear in no served file (transfer, approve, transferFrom, EIP-3009, releaseFor, permit),
// plus Multicall3's aggregate family: an eth_call allowlist is hollow if calls can be tunnelled through it.
const WRITE_SELECTORS = ["a9059cbb", "095ea7b3", "23b872dd", "e3ee160e", "beb96be5", "d505accf", "82ad56cb", "252dba42", "bce38bd7", "ac9650d8"];
const WRITE_NAMES = /^(transfer|transferFrom|approve|permit|transferWithAuthorization|receiveWithAuthorization|cancelAuthorization|increaseAllowance|decreaseAllowance|mint|burn|release|releaseFor|withdraw|deposit|claim|execute|multicall|aggregate\w*|tryAggregate|tryBlockAndAggregate|setApprovalForAll|safeTransferFrom|upgradeTo\w*|initialize|renounceOwnership|transferOwnership)$/;
const TARGETS = { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC", "0x9e00fc92493451eba1c63dd3880d68b622037ba3": "1F916", "0x4200000000000000000000000000000000000006": "WETH" };
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const TRANSFER_TOPIC = ["Transfer(address,address,uint256)", "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"];
const KECCAK_VECTORS = [
  ["", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
  ["abc", "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
  ["a".repeat(135), "34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446"],
  ["a".repeat(136), "a6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e"],
  ["a".repeat(137), "d869f639c7046b4929fc92a4d988a8b22c55fbadb802c0c66ebcd484f1915f39"],
];
// The CSP (critique §3.5). connect-src is not listed here: it must equal net.js FETCH_ORIGINS plus 'self'.
const CSP = {
  "default-src": ["'none'"], "script-src": ["'self'"], "style-src": ["'self'"], "font-src": ["'self'", "'none'"],
  "img-src": ["'self'", "'none'"], "worker-src": ["'none'"], "manifest-src": ["'none'"], "frame-src": ["'none'"],
  "object-src": ["'none'"], "base-uri": ["'none'"], "form-action": ["'none'"],
  "require-trusted-types-for": ["'script'"], "trusted-types": ["'none'"],
};
const CSP_IGNORED_IN_META = ["frame-ancestors", "report-uri", "report-to", "sandbox"];
// The ceiling for links (R4). Exactly what the page needs: ui.js linkHref() builds "citizen" and "api" hrefs on
// 1f916.ai and "tx"/"address" hrefs on base.blockscout.com, and the footer and the <noscript> name the source repo on
// github.com. net.js LINK_ORIGINS may be shorter than this; anything longer is a finding.
const LINK_DEFAULT = ["https://1f916.ai", "https://base.blockscout.com", "https://github.com"];
const XMLNS = ["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xlink", "http://www.w3.org/1999/xhtml", "http://www.w3.org/XML/1998/namespace", "http://www.w3.org/2000/xmlns/"];
const FORBIDDEN_TAGS = ["input", "textarea", "select", "form", "option", "optgroup", "datalist", "output", "label", "fieldset", "legend", "iframe", "frame", "frameset", "object", "embed", "portal", "foreignobject", "keygen", "isindex", "applet"];
const TEXT_ROLES = ["textbox", "searchbox", "combobox", "spinbutton"];
const TYPING_EVENTS = "keydown|keyup|keypress|input|beforeinput|change|paste|cut|copy|compositionstart|compositionupdate|compositionend|message|messageerror";
const BUDGET_BOUNDS = { maxLogsSpan: 2000, rpcMax: 400, timeoutMs: 20000, replayMaxSpan: 10000, capBytes: 2.5e6 };
// GET /api/surface, 2026-09-11, as "METHOD AUTH r|W PATH". Its catalogue_sha256 is recomputed below (H2).
const SURFACE_SHA = "73885ca2fe7c730b6f8ee8bed9be61779c05af854912622e3d7034c0715e921c";
const SURFACE = `GET none r /|* none r /humans.txt|* none r /robots.txt|* none r /.well-known/security.txt|* none r /security.txt
|* none r /.well-known/mcp.json|* none r /llms.txt|* none r /openapi.json|* none r /.well-known/oauth-authorization-server
|* none r /.well-known/oauth-protected-resource|* none r /.well-known/oauth-protected-resource/mcp
|* none r /.well-known/oauth-protected-resource/mcp/read|POST none r /oauth/register|GET none r /oauth/authorize
|POST none W /oauth/authorize|POST none r /oauth/token|GET none r /treasury|GET none r /porch|GET none r /porch/:day
|GET none r /human/economy|* optional W /mcp|* optional r /mcp/read|GET none r /api/attest|GET none r /api/search
|GET none r /api/attest/legacy-manifest|POST bearer W /api/attest/legacy-manifest|GET none r /api/front|GET none r /api/new
|GET none r /api/changes|GET none r /api/tags|GET none r /api/docket|GET none r /api/surface|GET none r /api/provenance
|GET none r /api/payload-notices|GET none r /api/screen-notices|GET none r /api/official|GET none r /api/stats
|GET none r /api/citizens|GET none r /api/citizen/:handle|GET none r /api/events|GET none r /api/post/:id
|GET none r /api/comment/:id|GET optional r /api/pulse|GET bearer r /api/me|GET bearer r /api/me/history
|POST none W /api/register|POST bearer W /api/post|POST bearer W /api/comment|POST bearer W /api/vote|GET none r /api/porch
|POST bearer W /api/porch/knock|POST bearer W /api/porch|POST bearer W /api/tag|GET none r /api/checkpoint
|POST bearer W /api/checkpoint|GET none r /api/checkpoint/consistency|GET none r /api/proof|GET none r /api/record/:handle
|GET none r /badge/:handle.svg|POST bearer W /api/bindings|POST bearer W /api/witness|GET none r /api/witnesses/:id/history
|GET none r /api/witnesses|POST bearer W /api/attestations|GET none r /api/attestations|GET none r /api/attestations/:id
|POST bearer W /api/seal|GET none r /api/seals|POST bearer W /api/keys|POST bearer W /api/keys/revoke
|POST bearer W /api/keys/decline|GET none r /api/keys/:handle|POST bearer W /api/listings|GET none r /api/listings
|GET none r /api/listings/guide|GET none r /api/listings/security|GET none r /api/listings/preimage
|POST bearer W /api/listings/:id/withdraw|POST bearer W /api/listings/:id/submissions|GET none r /api/rail
|POST bearer W /api/listings/:id/awards|GET bearer r /api/listings/:id/verdict-preimage|POST bearer W /api/awards/:id/settle
|POST bearer W /api/awards/:id/payable|GET none r /api/listings/:id|GET none r /api/grants|POST bearer W /api/grants
|GET none r /api/grants/:slug|POST bearer W /api/grants/:slug/transition|POST bearer W /api/grants/:slug/proposals
|GET none r /api/grants/:slug/proposals/:id|GET none r /grants|GET none r /grants/:slug|GET none r /api/payout-wallets/preimage
|POST bearer W /api/payout-wallets|GET bearer r /api/payout-wallets|POST bearer W /api/payout-wallets/:id/revoke
|GET none r /api/payout-bindings/preimage|GET none r /api/payout-bindings/:id/funder-statement|POST bearer W /api/payout-bindings
|GET none r /api/payout-bindings/:id|POST bearer W /api/payout-bindings/:id/receipt|GET none r /api/payouts
|POST bearer W /api/doorbell|POST bearer W /api/doorbell/verify|POST bearer W /api/doorbell/disable
|GET none r /api/moderation-state|GET bearer r /api/mcp-funnel|GET none r /api/flags|POST bearer W /api/flag/disposition
|POST bearer W /api/flag|POST bearer W /api/pin|POST bearer W /api/withdraw|POST bearer W /api/moderate
|POST bearer W /api/me/ack|POST bearer W /api/me/cadence|POST bearer W /api/rotate|POST bearer W /api/model
|POST bearer W /api/ledger|POST none W /api/patron`.split("|").map((s) => {
  const [method, auth, w, path] = s.trim().split(" ");
  return { method, auth, writes: w === "W", path };
});

// ---- small helpers -------------------------------------------------------------------------------------------
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const rel = (root, abs) => relative(root, abs).split(sep).join("/");
const short = (h) => (h ? `${h.slice(0, 4)}…${h.slice(-2)}` : "—");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Offsets → 1-based line numbers, and the line text for a report. */
function lines(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const lineOf = (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const textOf = (ln) => text.slice(starts[ln - 1], (starts[ln] ?? text.length + 1) - 1).trim().slice(0, 150);
  return { lineOf, textOf };
}

// ---- JavaScript tokenizer -------------------------------------------------------------------------------------
// Returns two masked copies of the source, same length and same line breaks:
//   code:    comments AND the contents of strings, template chunks and regex literals blanked
//   codeStr: comments blanked, literals kept
// plus the string literals themselves. A "/" starts a regex unless the previous token ends an expression; to know
// that after a "}" or ")", every bracket remembers what it opened: an object literal or a block, a call or an
// if/while/for condition. So `{a:1}/f(x)/3` is division, and `if (x) /re/.test(s)` is a regex.
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const OBJECT_AFTER = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "+", "-", "*", "%", "<", ">", "~", "^", "${", "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "yield", "await", "default"]);
const CONDITION_AFTER = new Set(["if", "while", "for", "with"]);
export function scanJs(src) {
  const code = src.split("");
  const codeStr = src.split("");
  const strings = [];
  const blank = (arr, a, b) => {
    for (let k = a; k < b; k++) if (arr[k] !== "\n") arr[k] = " ";
  };
  const n = src.length;
  let i = 0;
  let prev = "start"; // "value" when the last token ended an expression (a "/" here is division)
  let last = ""; // the last significant token: a punctuator, "=>", "${", a word, or "value" for a literal
  const stack = []; // per open bracket: "obj" | "block" | "tpl" | "cond" | "call"
  const template = (from) => {
    // scans a template chunk from `from`; returns the index after the closing ` or after ${
    let j = from;
    while (j < n) {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "`") {
        strings.push({ start: from, end: j, value: src.slice(from, j) });
        blank(code, from, j);
        prev = "value";
        last = "value";
        return j + 1;
      } else if (src[j] === "$" && src[j + 1] === "{") {
        strings.push({ start: from, end: j, value: src.slice(from, j) });
        blank(code, from, j);
        stack.push("tpl");
        prev = "start";
        last = "${";
        return j + 2;
      } else j++;
    }
    blank(code, from, n);
    return n;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      blank(code, i, end);
      blank(codeStr, i, end);
      i = end;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      blank(code, i, end);
      blank(codeStr, i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      strings.push({ start: i + 1, end: j, value: src.slice(i + 1, j) });
      blank(code, i + 1, j);
      i = j + 1;
      prev = "value";
      last = "value";
    } else if (c === "`") {
      i = template(i + 1);
    } else if (c === "}" && stack[stack.length - 1] === "tpl") {
      stack.pop();
      i = template(i + 1);
    } else if (c === "/" && prev !== "value") {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== "\n" && (cls || src[j] !== "/")) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        j++;
      }
      if (src[j] !== "/") {
        prev = "start"; // not a regex after all: treat as an operator
        i++;
        continue;
      }
      blank(code, i + 1, j);
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      i = j;
      prev = "value";
      last = "value";
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      const w = src.slice(i, j);
      prev = REGEX_AFTER_WORD.has(w) && src[i - 1] !== "." ? "start" : "value";
      last = w;
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      prev = "value";
      last = "value";
      i = j;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "{") {
      stack.push(OBJECT_AFTER.has(last) ? "obj" : "block");
      prev = "start";
      last = "{";
      i++;
    } else if (c === "}" || c === ")") {
      const opened = stack.pop();
      prev = opened === "block" || opened === "cond" ? "start" : "value"; // after an object literal or a call: a value
      last = prev === "value" ? "value" : c;
      i++;
    } else if (c === "(") {
      stack.push(CONDITION_AFTER.has(last) ? "cond" : "call");
      prev = "start";
      last = "(";
      i++;
    } else if (c === "]") {
      prev = "value";
      last = "value";
      i++;
    } else if (c === "=" && d === ">") {
      prev = "start";
      last = "=>";
      i += 2;
    } else if ((c === "+" || c === "-") && d === c) {
      if (prev !== "value") last = c + c; // prefix ++x starts an expression; postfix x++ stays a value
      i += 2;
    } else {
      prev = "start";
      last = c;
      i++;
    }
  }
  return { src, code: code.join(""), codeStr: codeStr.join(""), strings, ...lines(src) };
}

/** Index of the bracket that closes the one at `open`, in masked code; -1 if none. */
function closer(code, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const want = pairs[code[open]];
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === code[open]) depth++;
    else if (code[k] === want && --depth === 0) return k;
  }
  return -1;
}

/** [start, end) of the body of `function name(…) {…}` or `const name = (…) => {…}`; null if absent. */
function fnBody(js, name) {
  const re = new RegExp(`(?:\\bfunction\\s*\\*?\\s+${escRe(name)}\\s*\\(|\\b(?:const|let|var)\\s+${escRe(name)}\\s*=\\s*(?:async\\s*)?(?:function\\b[^(]*)?\\()`, "g");
  const m = re.exec(js.code);
  if (!m) return null;
  const close = closer(js.code, m.index + m[0].length - 1);
  if (close < 0) return null;
  let k = close + 1;
  while (/[\s=>]/.test(js.code[k] ?? "")) k++;
  if (js.code[k] !== "{") return null;
  const end = closer(js.code, k);
  return end < 0 ? null : [k, end + 1];
}

/** The arguments of the call whose "(" is at `open`, as [start, end) ranges split at top-level commas; null if unclosed. */
function callArgs(code, open) {
  const end = closer(code, open);
  if (end < 0) return null;
  const out = [];
  let depth = 0;
  let from = open + 1;
  for (let k = open + 1; k < end; k++) {
    const c = code[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push([from, k]);
      from = k + 1;
    }
  }
  out.push([from, end]);
  return out;
}

/**
 * How a name was written, over the range [a, b) of one expression:
 *   "literal"   a plain "x", 'x' or `x` with nothing substituted — the files say what it is
 *   "variable"  a bare identifier: the value is handed in from somewhere else (ui.js el(tag, props) does this)
 *   "built"     assembled in place: "in" + "put", ["key","down"].join(""), `on${k}`, f() — no file says what it is
 * The test reads the masked copy, where a string's contents are blanked and its quotes are not, so a literal is a
 * pair of quotes around nothing and a substituted template still shows its "${".
 */
function nameShape(s, range) {
  let masked = s.code.slice(range[0], range[1]).trim();
  while (masked.startsWith("(") && masked.endsWith(")") && closer(masked, 0) === masked.length - 1) masked = masked.slice(1, -1).trim();
  if (!masked) return "empty";
  if (/^(["'`])\s*\1$/.test(masked)) return "literal";
  if (/^[A-Za-z_$][\w$]*$/.test(masked)) return "variable";
  return "built";
}
const BUILT = "a name built at run time cannot be audited from the files";

// ---- HTML tokenizer -------------------------------------------------------------------------------------------
// Comments blanked; tags with parsed attributes; the contents of <script> and <style> kept aside, never parsed as
// markup. Browsers treat "<input>" in running text as an element, so it counts here too (write "input field").
//
// Two passes, because the strict one can be talked out of seeing a tag at all. Its attribute shape is exact, so
// `<input name=a"b>` and `<input data/x>` match nothing — while Chromium builds a real <input> for both. The second
// pass is permissive: every "<name" followed by a delimiter, whatever comes next. `loose[i].parsed` says whether the
// strict pass produced a tag at that same offset, so T1 can report the unparsed ones in their own words.
export function scanHtml(src) {
  const clean = src.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, " "));
  const tags = [];
  const raw = []; // inline <script>/<style> blocks
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  let m;
  while ((m = re.exec(clean))) {
    const attrs = {};
    const are = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let a;
    while ((a = are.exec(m[3] || ""))) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    const tag = { name: m[2].toLowerCase(), closing: m[1] === "/", attrs, start: m.index, end: re.lastIndex };
    tags.push(tag);
    if (!tag.closing && (tag.name === "script" || tag.name === "style")) {
      const endRe = new RegExp(`</${tag.name}\\s*>`, "ig");
      endRe.lastIndex = re.lastIndex;
      const e = endRe.exec(clean);
      const stop = e ? e.index : clean.length;
      raw.push({ tag, content: clean.slice(re.lastIndex, stop), start: re.lastIndex });
      re.lastIndex = e ? endRe.lastIndex : clean.length;
    }
  }
  const parsedAt = new Set(tags.map((t) => t.start));
  const loose = [...clean.matchAll(/<(\/?)([A-Za-z][\w:-]*)(?=[\s/>]|$)/g)].map((m) => ({ name: m[2].toLowerCase(), closing: m[1] === "/", start: m.index, parsed: parsedAt.has(m.index) }));
  return { src, clean, tags, raw, loose, ...lines(src) };
}

/** A CSS file with comments blanked. */
const scanCss = (src) => ({ src, clean: src.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (m) => m.replace(/[^\n]/g, " ")), ...lines(src) });

// ---- loading a checkout ---------------------------------------------------------------------------------------
const SKIP_DIRS = new Set([".git", "node_modules", "test/screenshots"]);
function walk(dir, root, out = { files: [], links: [] }) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const r = rel(root, abs);
    if (SKIP_DIRS.has(r)) continue;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) out.links.push(r); // never followed
    else if (st.isDirectory()) walk(abs, root, out);
    else if (st.isFile()) out.files.push({ rel: r, abs, size: st.size });
  }
  return out;
}

/** Imports net.js, abi.js and keccak.js from a checkout. The network stays off; attempts are counted. */
async function importDocs(root) {
  const out = {};
  for (const [k, f] of [["net", "net.js"], ["abi", "abi.js"], ["keccak", "keccak.js"]]) {
    const abs = join(root, "docs/js", f);
    if (!existsSync(abs)) {
      out[`${k}Error`] = `docs/js/${f} does not exist`;
      continue;
    }
    const before = netAttempts.length;
    try {
      out[k] = await import(pathToFileURL(abs).href);
    } catch (e) {
      out[`${k}Error`] = `${e?.name}: ${e?.message}`;
    }
    if (netAttempts.length > before) out[`${k}Network`] = netAttempts.slice(before);
  }
  return out;
}

async function load(root, opts = {}) {
  const { files, links } = walk(join(root, "docs"), root);
  for (const f of files) {
    f.buf = readFileSync(f.abs);
    f.sha = sha256(f.buf);
    f.ext = extname(f.rel).toLowerCase();
    f.in = f.rel.slice("docs/".length);
    if (TEXT.has(f.ext)) f.text = f.buf.toString("utf8");
  }
  const of = (ext, scan) => files.filter((f) => f.ext === ext).map((f) => ({ rel: f.rel, f, s: scan(f.text) }));
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null);
  const ctx = {
    root, opts, files, links,
    byIn: new Map(files.map((f) => [f.in, f])),
    js: of(".js", scanJs), html: of(".html", scanHtml), svg: of(".svg", scanHtml), css: of(".css", scanCss),
    readme: read("README.md"), license: read("LICENSE"),
    mods: await importDocs(root),
  };
  ctx.net = ctx.js.find((j) => j.rel === "docs/js/net.js") ?? null;
  return ctx;
}

// ---- findings ---------------------------------------------------------------------------------------------------
const fileHit = (file, msg) => ({ file, line: null, text: "", msg });
const hitAt = (file, s, off, msg) => {
  const line = s.lineOf(off);
  return { file, line, text: s.textOf(line), msg };
};
/** Every match of `re` in `text` (a masked copy of s.src) as a finding. */
function grep(out, file, s, text, re, msg) {
  for (const m of text.matchAll(re)) out.push(hitAt(file, s, m.index, typeof msg === "function" ? msg(m) : msg));
}
function result(id, title, findings, summary, notes = []) {
  return { id, title, status: findings.length ? "FAIL" : "PASS", summary, findings, notes };
}
const textFiles = (ctx) => ctx.files.filter((f) => f.text !== undefined).map((f) => ({ f, s: lines(f.text) }));
const isLocalRef = (v) => v && !/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith("//") && !v.startsWith("#");
/** Static import/export specifiers: the keywords are read from `code` (so a "from" inside a string never counts). */
function staticImports(s) {
  const at = new Map(s.strings.map((x) => [x.start, x.value]));
  const out = [];
  for (const m of s.code.matchAll(/(?:^|[;\s}])(?:import|export)\s[^;]*?\bfrom\s*["']|(?:^|[;\s])import\s*["']/gm)) {
    const q = m.index + m[0].length;
    if (at.has(q)) out.push({ off: q, spec: at.get(q) });
  }
  return out;
}

// ================================================================================================================
// CONDITION 1 · reads, never writes
// ================================================================================================================

function R1(ctx) {
  const F = [];
  const kinds = {};
  let bytes = 0;
  for (const f of ctx.files) {
    bytes += f.size;
    const kind = f.ext || basename(f.rel);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (!f.ext && !NOEXT.has(basename(f.rel))) F.push(fileHit(f.rel, "unexpected file type (no extension) in the served set"));
    else if (f.ext && CAP[f.ext] === undefined) F.push(fileHit(f.rel, `unexpected file type ${f.ext} in the served set`));
    else if (CAP[f.ext] && f.size > CAP[f.ext]) F.push(fileHit(f.rel, `${f.size} bytes, over the ${CAP[f.ext]} cap for ${f.ext}`));
    if (f.ext === ".html" && !PAGES.includes(f.in)) F.push(fileHit(f.rel, "an HTML page that is not declared: Pages would serve it (only index.html is)"));
    if (f.text) {
      const s = lines(f.text);
      grep(F, f.rel, s, f.text, /[#@]\s*sourceMappingURL\s*=/g, "a source map reference");
    }
  }
  for (const l of ctx.links) F.push(fileHit(l, "a symlink in the served set"));
  const missing = DECLARED.filter((d) => !ctx.byIn.has(d));
  for (const d of missing) F.push(fileHit(`docs/${d}`, "missing: a declared entry point of the page is not there yet"));
  // every local reference resolves to a served file (a root-relative "/x" breaks on a project site under /<repo>/)
  const refCheck = (file, s, off, from, ref) => {
    const clean = ref.split(/[?#]/)[0];
    if (clean.startsWith("/")) return F.push(hitAt(file, s, off, `root-relative reference ${ref} breaks under https://<user>.github.io/<repo>/`));
    const target = rel(ctx.root, resolve(dirname(join(ctx.root, from)), clean));
    if (!target.startsWith("docs/") || !ctx.byIn.has(target.slice(5))) F.push(hitAt(file, s, off, `reference ${ref} does not resolve to a file in docs/`));
  };
  for (const h of ctx.html) {
    for (const t of h.s.tags) {
      const ref = t.name === "script" || t.name === "img" ? t.attrs.src : t.name === "link" ? t.attrs.href : null;
      if (!t.closing && isLocalRef(ref)) refCheck(h.rel, h.s, t.start, h.rel, ref);
    }
  }
  for (const j of ctx.js) for (const im of staticImports(j.s)) if (isLocalRef(im.spec)) refCheck(j.rel, j.s, im.off, j.rel, im.spec);
  for (const c of ctx.css) for (const m of c.s.clean.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) if (isLocalRef(m[1])) refCheck(c.rel, c.s, m.index, c.rel, m[1]);
  // the digest of the file list, and MANIFEST.txt when present
  const listed = ctx.files.filter((f) => !["MANIFEST.txt", "SIGNATURE.txt"].includes(f.in));
  const listText = listed.map((f) => `${f.sha}  ${f.in}\n`).join("");
  const digest = sha256(listText);
  ctx.listDigest = digest;
  let man = "no MANIFEST.txt";
  const mf = ctx.byIn.get("MANIFEST.txt");
  if (mf) {
    const norm = mf.text.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{64}\s/.test(l)).map((l) => l.replace(/\s+\*?/, "  ")).sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1)).join("\n") + "\n";
    const ok = sha256(norm) === digest;
    man = ok ? "= MANIFEST.txt ✓" : "≠ MANIFEST.txt";
    if (!ok) F.push(fileHit(mf.rel, "MANIFEST.txt does not list exactly the files served, with these hashes (see S4)"));
  }
  const kindList = Object.entries(kinds).sort().map(([k, n]) => `${n} ${k}`).join(", ");
  return result("R1", "inventory", F, `${plural(ctx.files.length, "file")}, ${bytes.toLocaleString("en-US")} bytes (${kindList || "none"}) · sha256(list) ${short(digest)} ${man}${missing.length ? ` · missing: ${missing.join(", ")}` : ""}`);
}

const NET_APIS = [
  [/\bXMLHttpRequest\b/g, "XMLHttpRequest"], [/\bsendBeacon\b/g, "sendBeacon (a beacon is a POST)"], [/\bfetchLater\b/g, "fetchLater"],
  [/\bWebSocket\b/g, "WebSocket"], [/\bEventSource\b/g, "EventSource"], [/\bWebTransport\b/g, "WebTransport"],
  [/\bRTCPeerConnection\b/g, "RTCPeerConnection"], [/\bimportScripts\b/g, "importScripts"], [/\bnew\s+[\w$.]*Worker\b/g, "a worker"],
  [/\bserviceWorker\b/g, "serviceWorker"], [/\bnew\s+(?:Image|Audio)\s*\(/g, "new Image()/Audio() (loads a URL)"],
  [/\.\s*src\s*=(?!=)/g, ".src = (loads a URL)"], [/\bwindow\s*\.\s*open\s*\(/g, "window.open()"],
  [/\blocation\s*\.\s*(?:assign|replace)\s*\(/g, "location.assign()/replace()"], [/\blocation\s*\.\s*href\s*=(?!=)/g, "location.href ="],
];

function R2(ctx) {
  const F = [];
  const sites = [];
  for (const j of ctx.js) {
    for (const m of j.s.code.matchAll(/(?<![\w$])fetch(?![\w$])/g)) {
      if (/^\s*\(/.test(j.s.code.slice(m.index + 5, m.index + 40))) sites.push({ j, off: m.index });
      else F.push(hitAt(j.rel, j.s, m.index, "fetch referenced without a call (an alias is a second sink)"));
    }
    for (const [re, what] of NET_APIS) grep(F, j.rel, j.s, j.s.code, re, what);
    // the same APIs reached through a string key: globalThis["fetch"], x["src"] = …, window["open"]
    grep(F, j.rel, j.s, j.s.codeStr, /\[\s*(["'`])(fetch|fetchLater|XMLHttpRequest|sendBeacon|WebSocket|EventSource|WebTransport|RTCPeerConnection|importScripts|Worker|SharedWorker|serviceWorker|Image|Audio)\1\s*\]/g, (m) => `["${m[2]}"]: a network API through a string key`);
    grep(F, j.rel, j.s, j.s.codeStr, /\[\s*(["'`])(src|srcset)\1\s*\]\s*=(?!=)/g, (m) => `["${m[2]}"] = (loads a URL)`);
    grep(F, j.rel, j.s, j.s.codeStr, /\b(?:window|globalThis|self)\s*\[\s*(["'`])(open|location)\1\s*\]|\blocation\s*\[\s*(["'`])(href|assign|replace)\3\s*\]/g, (m) => `${m[0].replace(/\s+/g, "")}: a navigation through a string key`);
    grep(F, j.rel, j.s, j.s.codeStr, /\bcreateElement(?:NS)?\s*\(\s*(?:[^,()]*,\s*)?(["'`])(script|img|link|iframe|audio|video|source|track|embed|object)\1/gi, (m) => `createElement("${m[2]}") can load a URL`);
    // The same surfaces reached through a computed key, which the rules above cannot read: globalThis[k],
    // navigator["send" + "Beacon"], new (globalThis["XML" + "HttpRequest"])(). A key on one of these five objects
    // must be written out as a plain string literal, so that this file can say which property it is.
    for (const m of j.s.code.matchAll(/(?<![\w$])(globalThis|window|self|navigator|document)\s*\[/g)) {
      const open = m.index + m[0].length - 1;
      const close = closer(j.s.code, open);
      if (close < 0) continue;
      const shape = nameShape(j.s, [open + 1, close]);
      if (shape !== "literal") F.push(hitAt(j.rel, j.s, m.index, `${m[1]}[…]: a computed key, ${shape === "variable" ? "held in a variable" : "assembled where it is used"} — ${BUILT}, so a network, storage or wallet property could hide here`));
    }
    // …and the object itself must be named where it is used: an alias (const g = globalThis) puts every later property
    // access out of reach of the rule above. The page never takes one.
    grep(F, j.rel, j.s, j.s.code, /(?<![=!<>])=(?!=)\s*(globalThis|window|self|navigator|document)\b(?![.[])/g, (m) => `an alias of ${m[1]}: every property read through it afterwards is out of this scan's reach (name the property where it is used)`);
    for (const m of j.s.code.matchAll(/(?<![\w$.])import\s*\(/g)) {
      const after = j.s.codeStr.slice(m.index + m[0].length).match(/^\s*(["'])(\.{1,2}\/[^"'\n]+\.js)\1\s*\)/);
      if (!after) F.push(hitAt(j.rel, j.s, m.index, "import() of something other than a relative .js literal"));
    }
    for (const im of staticImports(j.s)) if (!/^\.{1,2}\/[^:]*\.js$/.test(im.spec)) F.push(hitAt(j.rel, j.s, im.off, `import of "${im.spec}": only relative .js modules are served`));
  }
  const fetchAt = sites.map((x) => `${x.j.rel}:${x.j.s.lineOf(x.off)}`);
  if (sites.length === 0) F.push(fileHit("docs/js/net.js", "no fetch( call site: expected exactly one, in docs/js/net.js"));
  else if (sites.length > 1 || sites[0].j.rel !== "docs/js/net.js") {
    for (const x of sites) F.push(hitAt(x.j.rel, x.j.s, x.off, `fetch( call site (${sites.length} found; expected exactly one, in docs/js/net.js)`));
  }
  for (const h of [...ctx.html, ...ctx.svg]) {
    for (const t of h.s.tags) {
      if (t.closing) continue;
      if ("ping" in t.attrs) F.push(hitAt(h.rel, h.s, t.start, "a ping= attribute (a POST on click)"));
      const relAttr = (t.attrs.rel || "").toLowerCase();
      if (t.name === "link" && /\b(preconnect|prefetch|dns-prefetch|preload|modulepreload|prerender)\b/.test(relAttr) && !isLocalRef(t.attrs.href)) F.push(hitAt(h.rel, h.s, t.start, `<link rel="${relAttr}"> to another origin`));
      if (t.name === "link" && /\bmanifest\b/.test(relAttr)) F.push(hitAt(h.rel, h.s, t.start, "<link rel=manifest> (a fetch the CSP forbids)"));
      if (t.name === "meta" && (t.attrs["http-equiv"] || "").toLowerCase() === "refresh") F.push(hitAt(h.rel, h.s, t.start, '<meta http-equiv="refresh"> (a navigation)'));
      if (t.name === "base") F.push(hitAt(h.rel, h.s, t.start, "<base> (redirects every relative URL)"));
    }
  }
  const js = ctx.js.length;
  return result("R2", "one network sink", F, `${fetchAt.join(", ") || "no"} fetch() · 0 XHR/beacon/WebSocket/EventSource/worker/Image in ${plural(js, "JS file")} · every key on globalThis/window/self/navigator/document written out as a string literal, none computed, none of the five aliased · imports relative .js only`);
}

function R3(ctx) {
  const F = [];
  const net = ctx.net;
  if (!net) return result("R3", "method per function", [fileHit("docs/js/net.js", "missing")], "docs/js/net.js not found");
  const at = (off, msg) => F.push(hitAt(net.rel, net.s, off, msg));
  const bodies = Object.fromEntries(["registry", "indexer", "witness", "local", "post"].map((n) => [n, fnBody(net.s, n)]));
  const inFn = (off) => Object.entries(bodies).find(([, b]) => b && off >= b[0] && off < b[1])?.[0] ?? null;
  const gets = [];
  for (const fn of ["registry", "indexer", "witness", "local"]) {
    const b = bodies[fn];
    if (!b) {
      F.push(fileHit(net.rel, `function ${fn}() not found`));
      continue;
    }
    const ms = [...net.s.codeStr.slice(b[0], b[1]).matchAll(/\bmethod\s*:\s*(["'`])(\w*)\1/g)];
    if (!ms.length) at(b[0], `${fn}() passes no literal method`);
    for (const m of ms) {
      if (m[2] === "GET") gets.push(`${fn}():${net.s.lineOf(b[0] + m.index)}`);
      else at(b[0] + m.index, `${fn}() sends ${m[2]}, not GET`);
    }
  }
  const posts = ctx.js.flatMap((j) => j.s.strings.filter((s) => /^post$/i.test(s.value)).map((s) => ({ j, off: s.start })));
  const postOk = posts.length === 1 && posts[0].j === net && inFn(posts[0].off) === "post";
  if (!posts.length) F.push(fileHit(net.rel, "no 'POST' literal: expected exactly one, in post()"));
  else if (!postOk) for (const p of posts) F.push(hitAt(p.j.rel, p.j.s, p.off, `'POST' literal (${posts.length} found; expected exactly one, inside post() in net.js)`));
  for (const j of ctx.js) {
    grep(F, j.rel, j.s, j.s.codeStr, /\bmethod\s*:\s*(["'`])(put|patch|delete|connect|trace|options|head)\1/gi, (m) => `HTTP ${m[2].toUpperCase()}`);
    grep(F, j.rel, j.s, j.s.code, /\bkeepalive\b/g, "keepalive (lets a request outlive the page)");
    grep(F, j.rel, j.s, j.s.codeStr, /\bcredentials\s*:\s*(["'])(include|same-origin)\1/g, (m) => `credentials: "${m[2]}"`);
    grep(F, j.rel, j.s, j.s.codeStr, /\bmode\s*:\s*(["'])no-cors\1/g, 'mode: "no-cors"');
    grep(F, j.rel, j.s, j.s.codeStr, /\b(?:authorization|bypass-429-option|api-v2-temp-token|x-api-key|proxy-authorization)\b|["'`]Bearer\s/gi, (m) => `a credential header or token (${m[0].trim()})`);
    grep(F, j.rel, j.s, j.s.code, /\bnew\s+Headers\b/g, "new Headers() (headers are literal objects in net.js only)");
    for (const m of j.s.code.matchAll(/\bheaders\s*:/g)) {
      let k = m.index + m[0].length;
      while (/\s/.test(j.s.code[k] ?? "")) k++;
      if (j.s.code[k] !== "{") {
        F.push(hitAt(j.rel, j.s, m.index, "headers is not a literal object"));
        continue;
      }
      const obj = j.s.codeStr.slice(k, closer(j.s.code, k) + 1).replace(/\s+/g, "");
      const one = /^\{(["']?)([\w-]+)\1:(["'])([^"']*)\3,?\}$/.exec(obj);
      const where = j === net ? inFn(m.index) : null;
      const ok = one && one[4] === "application/json" && ((one[2].toLowerCase() === "accept" && ["registry", "indexer", "local"].includes(where)) || (one[2].toLowerCase() === "content-type" && where === "post"));
      if (!ok) F.push(hitAt(j.rel, j.s, m.index, `headers ${obj} in ${where ? where + "()" : j.rel} (allowed: accept: application/json in registry/indexer/local, content-type: application/json in post())`));
    }
  }
  const postB = bodies.post;
  for (const m of net.s.code.matchAll(/\bbody\s*:/g)) if (!postB || m.index < postB[0] || m.index >= postB[1]) at(m.index, "a request body outside post()");
  const site = /(?<![\w$])fetch\s*\(/.exec(net.s.code);
  if (site) {
    const open = site.index + site[0].length - 1;
    const args = net.s.codeStr.slice(open, closer(net.s.code, open) + 1);
    for (const [k, v] of [["credentials", "omit"], ["redirect", "error"], ["referrerPolicy", "no-referrer"]]) {
      const m = new RegExp(`\\b${k}\\s*:\\s*(["'])${v}\\1`).exec(args);
      if (!m) at(open, `the fetch options do not set ${k}: "${v}"`);
      else if (args.lastIndexOf("...") > m.index) at(open, `a spread after ${k} could override it`);
    }
  }
  return result("R3", "method per function", F, `GET literal in ${gets.join(" ") || "—"} · POST literal ${postOk ? `once, post():${net.s.lineOf(posts[0].off)}` : `${posts.length}×`} · credentials omit · redirect error · no referrer · headers: accept (registry/indexer/local), content-type application/json (post), none elsewhere`);
}

function R4(ctx) {
  const F = [];
  const fo = ctx.mods.net?.FETCH_ORIGINS ?? [];
  const fetchOrigins = new Set(fo.map((o) => new URL(o).origin));
  // The audited list decides what a link may point at, and LINK_DEFAULT is the ceiling this script pins: the list in
  // net.js may be shorter, never longer. Without this, R4 would read its allowlist out of the file it is auditing.
  const exported = ctx.mods.net?.LINK_ORIGINS;
  const links = exported ?? LINK_DEFAULT;
  for (const o of exported ?? []) if (!LINK_DEFAULT.includes(o)) F.push(fileHit("docs/js/net.js", `LINK_ORIGINS allows ${o}, which this script's pinned ceiling does not (ceiling: ${LINK_DEFAULT.join(" ")})`));
  const table = new Map();
  const visit = (file, s, text) => {
    for (const m of text.matchAll(/\bhttps?:\/\/(?:(?!\$\{)[^\s"'`<>()\\,;])+/gi)) {
      let u;
      try {
        u = new URL(m[0]);
      } catch {
        F.push(hitAt(file, s, m.index, `unparseable URL ${m[0]}`));
        continue;
      }
      let role = null;
      if (u.username || u.password) F.push(hitAt(file, s, m.index, `a URL with userinfo (${m[0]})`));
      else if (XMLNS.some((x) => m[0].startsWith(x))) role = "xmlns";
      else if (u.protocol !== "https:") F.push(hitAt(file, s, m.index, `plain http: ${m[0]}`));
      else if (/^fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) F.push(hitAt(file, s, m.index, `${u.hostname}: a third-party font host sees every visitor`));
      else if (fo.some((o) => m[0].startsWith(o)) || (fetchOrigins.has(u.origin) && u.pathname === "/")) role = "fetch";
      else if (links.includes(u.origin)) role = "link";
      else F.push(hitAt(file, s, m.index, `${u.origin} is in neither FETCH_ORIGINS nor LINK_ORIGINS`));
      if (role) {
        const key = role === "xmlns" ? "(XML namespace)" : u.origin;
        const row = table.get(key) ?? { roles: new Set(), n: 0 };
        row.roles.add(role);
        row.n++;
        table.set(key, row);
      }
    }
  };
  for (const j of ctx.js) visit(j.rel, j.s, j.s.codeStr);
  for (const h of [...ctx.html, ...ctx.svg]) {
    visit(h.rel, h.s, h.s.clean);
    for (const t of h.s.tags) for (const k of ["src", "href", "action", "poster", "data", "ping", "srcset", "xlink:href"]) if (/^\s*\/\//.test(t.attrs[k] ?? "")) F.push(hitAt(h.rel, h.s, t.start, `protocol-relative ${k}=${t.attrs[k]}`));
  }
  for (const c of ctx.css) visit(c.rel, c.s, c.s.clean);
  for (const f of ctx.files.filter((x) => x.ext === ".json")) visit(f.rel, lines(f.text), f.text);
  const notes = [...table].sort().map(([o, r]) => `${o.padEnd(40)} ${[...r.roles].join("+").padEnd(10)} ${r.n}`);
  notes.push(`net.js LINK_ORIGINS (${exported ? exported.length : 0}): ${exported ? exported.join(" ") : "not exported"}`);
  notes.push(`pinned ceiling here (${LINK_DEFAULT.length}): ${LINK_DEFAULT.join(" ")}`);
  if (!exported) notes.push("net.js exports no LINK_ORIGINS: links were checked against the ceiling above; export one so safeLink() and this check share it");
  return result("R4", "origins", F, `${table.size} origins in code, markup, CSS and data (comments excluded) · each in FETCH_ORIGINS, LINK_ORIGINS or an XML namespace · LINK_ORIGINS within this script's pinned ceiling`, notes);
}

function R5(ctx) {
  const F = [];
  const fo = ctx.mods.net?.FETCH_ORIGINS;
  if (!fo) F.push(fileHit("docs/js/net.js", `FETCH_ORIGINS not readable (${ctx.mods.netError ?? "not exported"})`));
  if (!ctx.html.length) F.push(fileHit("docs/index.html", "missing: there is no page to carry the CSP yet"));
  let conn = null;
  for (const h of ctx.html) {
    const at = (off, msg) => F.push(hitAt(h.rel, h.s, off, msg));
    const open = h.s.tags.filter((t) => !t.closing);
    const metas = open.filter((t) => t.name === "meta" && (t.attrs["http-equiv"] || "").toLowerCase() === "content-security-policy");
    if (metas.length !== 1) F.push(fileHit(h.rel, `${metas.length} CSP meta tags (expected exactly one)`));
    const meta = metas[0];
    if (meta) {
      const before = open.filter((t) => t.start < meta.start && !["html", "head"].includes(t.name) && !(t.name === "meta" && "charset" in t.attrs));
      if (before.length) at(before[0].start, `<${before[0].name}> comes before the CSP meta (it must follow <meta charset> directly)`);
      const dirs = new Map();
      for (const part of (meta.attrs.content || "").split(";")) {
        const toks = part.trim().split(/\s+/).filter(Boolean);
        if (!toks.length) continue;
        const name = toks[0].toLowerCase();
        if (dirs.has(name)) at(meta.start, `directive ${name} appears twice`);
        dirs.set(name, toks.slice(1));
      }
      for (const [name, allowed] of Object.entries(CSP)) {
        const v = dirs.get(name);
        if (!v) at(meta.start, `missing ${name} ${allowed[0]}`);
        else if (!(v.length === 1 && allowed.includes(v[0]))) at(meta.start, `${name} ${v.join(" ")} (expected ${allowed.join(" or ")})`);
      }
      for (const [name, v] of dirs) {
        if (CSP_IGNORED_IN_META.includes(name)) at(meta.start, `${name} is ignored in a meta CSP, so stating it misleads`);
        else if (!(name in CSP) && name !== "connect-src" && name !== "upgrade-insecure-requests" && !(v.length === 1 && v[0] === "'none'")) at(meta.start, `unexpected directive ${name} ${v.join(" ")}`);
        for (const src of v) if (/^'(unsafe-|wasm-unsafe)|^(data|blob|filesystem|mediastream):$|\*|^(https?|wss?):$/i.test(src)) at(meta.start, `${name} allows ${src}`);
      }
      const cs = dirs.get("connect-src");
      if (!cs) at(meta.start, "missing connect-src");
      else if (fo) {
        const want = new Set(["'self'", ...fo]);
        const got = new Set(cs);
        const extra = [...got].filter((x) => !want.has(x));
        const lack = [...want].filter((x) => !got.has(x));
        if (extra.length) at(meta.start, `connect-src has ${extra.join(" ")}, which net.js FETCH_ORIGINS does not`);
        if (lack.length) at(meta.start, `connect-src lacks ${lack.join(" ")} (in net.js FETCH_ORIGINS)`);
        if (!extra.length && !lack.length) conn = cs;
      }
    }
    const referrer = open.find((t) => t.name === "meta" && (t.attrs.name || "").toLowerCase() === "referrer");
    if (!referrer || referrer.attrs.content !== "no-referrer") F.push(fileHit(h.rel, 'no <meta name="referrer" content="no-referrer">'));
    for (const r of h.s.raw) {
      if (r.tag.name === "style" || !("src" in r.tag.attrs)) at(r.tag.start, `inline <${r.tag.name}> (blocked by the CSP; move it to a file)`);
      else if (r.content.trim()) at(r.tag.start, "a <script src> with inline content");
    }
    for (const t of open) {
      for (const [k, v] of Object.entries(t.attrs)) {
        if (k === "style") at(t.start, `style= attribute on <${t.name}>`);
        if (/^on[a-z]/.test(k)) at(t.start, `inline handler ${k}= on <${t.name}>`);
        if (/^\s*javascript:/i.test(v)) at(t.start, `javascript: URL in ${k}=`);
      }
    }
  }
  for (const j of ctx.js) for (const s of j.s.strings) if (/^\s*javascript:/i.test(s.value)) F.push(hitAt(j.rel, j.s, s.start, "a javascript: URL"));
  // Served SVG is outside the CSP above: that policy is a <meta> tag inside index.html, and Pages serves
  // docs/favicon.svg at its own URL, where no policy applies and an SVG is a document that can carry script. So each
  // .svg is read with the same rules as the page, plus its own: no <script>/<style>, no <foreignObject> (HTML, and
  // fields, inside an image), and no reference off this origin (a reference in an icon is a request from every viewer).
  const svgRefs = ["href", "xlink:href", "src", "xlink:src", "data", "poster"];
  for (const v of ctx.svg) {
    const at = (off, msg) => F.push(hitAt(v.rel, v.s, off, msg));
    for (const l of v.s.loose) {
      if (l.closing || !["script", "style", "foreignobject"].includes(l.name)) continue;
      const how = l.parsed ? "" : " (its attributes do not parse, and a browser still builds it)";
      at(l.start, l.name === "foreignobject" ? `<foreignObject> in a served SVG${how}: HTML, and fields, inside an image` : `<${l.name}> in a served SVG${how}: no policy covers this file at its own URL`);
    }
    for (const t of v.s.tags) {
      if (t.closing) continue;
      for (const [k, val] of Object.entries(t.attrs)) {
        if (k === "style") at(t.start, `style= attribute on <${t.name}> in a served SVG`);
        if (/^on[a-z]/.test(k)) at(t.start, `inline handler ${k}= on <${t.name}> in a served SVG (it runs when the SVG is opened at its own URL)`);
        if (/^\s*javascript:/i.test(val)) at(t.start, `javascript: URL in ${k}= in a served SVG`);
        if (svgRefs.includes(k) && val && !val.startsWith("#") && !isLocalRef(val)) at(t.start, `${k}=${val.slice(0, 60)} in a served SVG: not this origin (an icon must not fetch)`);
        for (const m of String(val).matchAll(/url\(\s*["']?([^"')\s]*)/gi)) if (m[1] && !m[1].startsWith("#") && !isLocalRef(m[1])) at(t.start, `url(${m[1].slice(0, 50)}) in ${k}= in a served SVG: not this origin (an icon must not fetch)`);
      }
    }
  }
  const sum = conn ? `connect-src == net.js FETCH_ORIGINS (${fo.length}) + 'self': ${conn.join(" ")}` : "the meta CSP as critique §3.5";
  const svgSum = ctx.svg.length ? `${plural(ctx.svg.length, "served .svg")} read under the same rules (no <script>/<style>/<foreignObject>, no on*=, no javascript:, no off-origin reference), because a meta CSP does not reach a file at its own URL` : "no served .svg file";
  return result("R5", "CSP", F, `${sum} · worker-src/form-action/base-uri 'none' · Trusted Types · no unsafe-*, data:, blob:, * · no inline script/style/handlers · ${svgSum}`);
}

function R6(ctx) {
  const F = [];
  const notes = [];
  const m = ctx.mods.net?.RPC_METHODS;
  const decl = ctx.net ? /\bRPC_METHODS\s*=/.exec(ctx.net.s.code) : null;
  const atDecl = (msg) => F.push(decl ? hitAt(ctx.net.rel, ctx.net.s, decl.index, msg) : fileHit("docs/js/net.js", msg));
  if (!Array.isArray(m)) atDecl(`RPC_METHODS not readable as an array (${ctx.mods.netError ?? "not exported"})`);
  else {
    if (!Object.isFrozen(m)) atDecl("RPC_METHODS is not frozen");
    if (new Set(m).size !== m.length) atDecl("RPC_METHODS has duplicates");
    for (const x of m) if (!RPC_READS.includes(x)) atDecl(`${x} is not a read method`);
    const used = new Set(ctx.js.filter((j) => j !== ctx.net).flatMap((j) => j.s.strings.map((s) => s.value).filter((v) => /^eth_\w+$/.test(v))));
    const unused = m.filter((x) => !used.has(x));
    if (unused.length) notes.push(`allowlisted, used by no line in docs/js: ${unused.join(", ")} (a shorter list is a stronger claim)`);
    for (const x of used) if (!m.includes(x)) notes.push(`${x} is used in docs/js but not allowlisted: net.js would refuse it`);
    const inReadme = ctx.readme ? new Set([...ctx.readme.matchAll(/\beth_\w+/g)].map((x) => x[0]).filter((x) => RPC_READS.includes(x))) : null;
    if (!inReadme) notes.push("README.md absent: its method list is not compared yet");
    else if (inReadme.size !== m.length || m.some((x) => !inReadme.has(x))) F.push(fileHit("README.md", `README names ${[...inReadme].join(", ") || "no read methods"}; RPC_METHODS is ${m.join(", ")}`));
    for (const h of ctx.html) {
      const inHtml = new Set([...h.s.clean.matchAll(/\beth_\w+/g)].map((x) => x[0]).filter((x) => RPC_READS.includes(x)));
      if (inHtml.size && (inHtml.size !== m.length || m.some((x) => !inHtml.has(x)))) F.push(fileHit(h.rel, `a static method list (${[...inHtml].join(", ")}) that differs from RPC_METHODS`));
    }
  }
  const tf = textFiles(ctx);
  for (const { f, s } of tf) grep(F, f.rel, s, f.text, RPC_BANNED, (x) => `${x[0]}: a send, sign, wallet, filter or debug method`);
  const list = Array.isArray(m) ? `${m.length}, ${Object.isFrozen(m) ? "frozen" : "NOT frozen"}: ${[...m].sort().join(" ")}` : "unreadable";
  return result("R6", "JSON-RPC methods", F, `JSON-RPC methods (${list}) · 0 send/sign/wallet strings in ${plural(tf.length, "served text file")}${ctx.readme && Array.isArray(m) ? " · README list == net.js" : ""}`, notes);
}

function R7(ctx) {
  const F = [];
  const notes = [];
  const { keccak, abi, net } = ctx.mods;
  let kok = false;
  if (typeof keccak?.keccakHex !== "function") F.push(fileHit("docs/js/keccak.js", `keccakHex not importable (${ctx.mods.keccakError ?? "not exported"})`));
  else {
    const bad = KECCAK_VECTORS.filter(([s, h]) => keccak.keccakHex(s) !== h);
    if (bad.length) F.push(fileHit("docs/js/keccak.js", `fails ${bad.length} of ${KECCAK_VECTORS.length} known keccak-256 vectors (so it cannot vouch for a selector)`));
    else kok = true;
  }
  const sel = (sig) => "0x" + keccak.keccakHex(sig).slice(0, 8);
  if (kok) for (const [s, h] of Object.entries(READS)) if (sel(s) !== h) F.push(fileHit(SELF, `this script's own table: ${s} is ${sel(s)}, pinned ${h}`));
  const rs = abi?.READ_SIGNATURES;
  const decl = ctx.byIn.get("js/abi.js");
  const abiAt = (key, msg) => {
    const s = decl && lines(decl.text);
    const i = decl ? decl.text.indexOf(key) : -1;
    F.push(i >= 0 ? hitAt(decl.rel, s, i, msg) : fileHit("docs/js/abi.js", msg));
  };
  if (!rs || typeof rs !== "object") F.push(fileHit("docs/js/abi.js", `READ_SIGNATURES not readable (${ctx.mods.abiError ?? "not exported"})`));
  else {
    if (!Object.isFrozen(rs)) abiAt("READ_SIGNATURES", "READ_SIGNATURES is not frozen");
    for (const [s, h] of Object.entries(rs)) {
      const hex = String(h).toLowerCase();
      if (WRITE_NAMES.test(s.split("(")[0])) abiAt(s, `${s} is a write function`);
      if (WRITE_SELECTORS.includes(hex.slice(2))) abiAt(s, `${hex} is a write selector`);
      if (kok && sel(s) !== hex) abiAt(s, `${s}: frozen ${h}, keccak256(signature)[0:4] is ${sel(s)}`);
      if (!(s in READS)) notes.push(`${s} is not in the documented read table (critique §5.7): confirm it is a view function`);
    }
  }
  const t = net?.CALL_TARGETS;
  const netAt = (needle, msg) => {
    const i = ctx.net ? ctx.net.s.src.indexOf(needle) : -1;
    F.push(i >= 0 ? hitAt(ctx.net.rel, ctx.net.s, i, msg) : fileHit("docs/js/net.js", msg));
  };
  if (!Array.isArray(t)) F.push(fileHit("docs/js/net.js", "CALL_TARGETS not readable"));
  else {
    if (!Object.isFrozen(t)) netAt("CALL_TARGETS", "CALL_TARGETS is not frozen");
    for (const a of t) {
      if (!/^0x[0-9a-f]{40}$/.test(a)) netAt(a, `${a} is not a lowercase 40-hex address`);
      if (String(a).toLowerCase() === MULTICALL3) netAt(a, "Multicall3 as an eth_call target: inner calls would bypass the selector allowlist");
      else if (!TARGETS[String(a).toLowerCase()]) netAt(a, `${a} is not in the documented target table`);
    }
  }
  const sels = WRITE_SELECTORS.join("|");
  const reSel = new RegExp(`\\b0x(?:${sels})(?:[0-9a-fA-F]{64})*(?![0-9a-fA-F])|(?<![0-9a-fA-F])(?:${sels})(?![0-9a-fA-F])`, "gi");
  const tf = textFiles(ctx);
  for (const { f, s } of tf) grep(F, f.rel, s, f.text, reSel, (x) => `write selector ${x[0].slice(0, 10)}`);
  if (kok) {
    const topic = "0x" + keccak.keccakHex(TRANSFER_TOPIC[0]);
    if (topic !== TRANSFER_TOPIC[1]) F.push(fileHit("docs/js/keccak.js", "the Transfer topic does not recompute"));
    for (const j of ctx.js) for (const s of j.s.strings) if (/^0x[0-9a-fA-F]{64}$/.test(s.value) && s.value.slice(0, 10).toLowerCase() === topic.slice(0, 10) && s.value.toLowerCase() !== topic) F.push(hitAt(j.rel, j.s, s.start, "looks like the Transfer topic but is not keccak256(Transfer(address,address,uint256))"));
  }
  const nT = Array.isArray(t) ? t.length : "?";
  const nS = rs ? Object.keys(rs).length : "?";
  return result("R7", "targets and selectors", F, `eth_call: ${nT} targets × ${nS} selectors, each == keccak256(signature)[0:4] recomputed here with keccak.js (which passes ${KECCAK_VECTORS.length} known vectors) · 0 write selectors · no Multicall`, notes);
}

// ---- R8: the runtime guard, exercised with a stub fetch -----------------------------------------------------------
const ADDR = { usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", treasury: "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9" };
const TX = "0x" + "ab".repeat(32);
const PAGE_ORIGIN = "https://popek1990.github.io"; // a simulated page origin, for local()
const word = (a) => a.slice(2).padStart(64, "0");
const hx = (n) => "0x" + n.toString(16);
const logs = (span, extra = {}) => ({ method: "eth_getLogs", params: [{ address: [ADDR.usdc], fromBlock: hx(51_000_000), toBlock: hx(51_000_000 + span - 1), topics: [TRANSFER_TOPIC[1]], ...extra }] });
const ethCall = (to, data, extra = {}) => ({ method: "eth_call", params: [{ to, data, ...extra }, "0x30d4000"] });
const GETJ = (url) => ({ method: "GET", url, headers: { accept: "application/json" } });
const POSTJ = (url, rpc) => ({ method: "POST", url, headers: { "content-type": "application/json" }, rpc });
const Y = (name, run, expect) => ({ name, run, expect });
const N = (name, run) => ({ name, run, expect: "refuse" });
const rpc1 = (node, method, params = []) => (n) => n.rpc(node, { method, params });
const CASES = [
  Y("registry /api/rail", (n) => n.registry("/api/rail"), GETJ("https://1f916.ai/api/rail")),
  Y("registry /api/official", (n) => n.registry("/api/official"), GETJ("https://1f916.ai/api/official")),
  Y("registry /api/checkpoint", (n) => n.registry("/api/checkpoint"), GETJ("https://1f916.ai/api/checkpoint")),
  Y("registry consistency", (n) => n.registry("/api/checkpoint/consistency?log=identity_events&from=6033&to=11708"), GETJ("https://1f916.ai/api/checkpoint/consistency?log=identity_events&from=6033&to=11708")),
  Y("registry proof", (n) => n.registry("/api/proof?log=identity_events&event=6045"), GETJ("https://1f916.ai/api/proof?log=identity_events&event=6045")),
  Y("registry events", (n) => n.registry("/api/events?kind=payout-receipt"), GETJ("https://1f916.ai/api/events?kind=payout-receipt")),
  Y("registry citizens", (n) => n.registry("/api/citizens?since=0"), GETJ("https://1f916.ai/api/citizens?since=0")),
  Y("registry listing 23", (n) => n.registry("/api/listings/23"), GETJ("https://1f916.ai/api/listings/23")),
  Y("registry binding 150", (n) => n.registry("/api/payout-bindings/150"), GETJ("https://1f916.ai/api/payout-bindings/150")),
  Y("registry /treasury", (n) => n.registry("/treasury"), GETJ("https://1f916.ai/treasury")),
  Y("indexer address transfers", (n) => n.indexer(`/api/v2/addresses/${ADDR.treasury}/token-transfers?type=ERC-20&filter=from`), GETJ(`https://base.blockscout.com/api/v2/addresses/${ADDR.treasury}/token-transfers?type=ERC-20&filter=from`)),
  Y("indexer tx transfers", (n) => n.indexer(`/api/v2/transactions/${TX}/token-transfers`), GETJ(`https://base.blockscout.com/api/v2/transactions/${TX}/token-transfers`)),
  Y("witness day file", (n) => n.witness("2026-09-11"), { method: "GET", url: "https://raw.githubusercontent.com/1f916-ai/1f916/main/witness/2026-09-11.jsonl", headers: {} }),
  Y("local data/baseline.json (simulated page origin)", (n) => n.local("data/baseline.json"), GETJ(`${PAGE_ORIGIN}/tick-and-tie/data/baseline.json`)),
  Y("rpc base eth_chainId", rpc1("base", "eth_chainId"), POSTJ("https://mainnet.base.org", ["eth_chainId"])),
  Y("rpc drpc batch chainId + finalized head", (n) => n.rpc("drpc", [{ method: "eth_chainId", params: [] }, { method: "eth_getBlockByNumber", params: ["finalized", false] }]), POSTJ("https://base.drpc.org", ["eth_chainId", "eth_getBlockByNumber"])),
  Y("rpc publicnode chainId + finalized head", (n) => n.rpc("publicnode", [{ method: "eth_chainId", params: [] }, { method: "eth_getBlockByNumber", params: ["finalized", false] }]), POSTJ("https://base-rpc.publicnode.com", ["eth_chainId", "eth_getBlockByNumber"])),
  Y("rpc tenderly eth_chainId", rpc1("tenderly", "eth_chainId"), POSTJ("https://base.gateway.tenderly.co", ["eth_chainId"])),
  Y("rpc base receipt", rpc1("base", "eth_getTransactionReceipt", [TX]), POSTJ("https://mainnet.base.org", ["eth_getTransactionReceipt"])),
  Y("rpc drpc balanceOf(treasury) at a block", (n) => n.rpc("drpc", ethCall(ADDR.usdc, "0x70a08231" + word(ADDR.treasury))), POSTJ("https://base.drpc.org", ["eth_call"])),
  Y("rpc base getLogs over 2,000 blocks", (n) => n.rpc("base", logs(2000)), POSTJ("https://mainnet.base.org", ["eth_getLogs"])),
  Y("replay: one getLogs over 10,000 blocks (the documented exception)", (n) => n.rpcVerbatim("tenderly", logs(10_000)), POSTJ("https://base.gateway.tenderly.co", ["eth_getLogs"])),
  Y("framed by another site: rpc reads nothing", (n) => n.rpc("base", { method: "eth_chainId", params: [] }), "none"),
  N("registry /api/citizen/%2e%2e/me (becomes /api/me)", (n) => n.registry("/api/citizen/%2e%2e/me")),
  N("registry //evil.example/x", (n) => n.registry("//evil.example/x")),
  N("registry https://1f916.ai@evil.example/", (n) => n.registry("https://1f916.ai@evil.example/")),
  N("registry \\\\evil.example\\api\\rail", (n) => n.registry("\\\\evil.example\\api\\rail")),
  N("registry http://1f916.ai/api/rail", (n) => n.registry("http://1f916.ai/api/rail")),
  N("registry javascript:alert(1)", (n) => n.registry("javascript:alert(1)")),
  N("registry /api/rail?secret=1 (unknown query key)", (n) => n.registry("/api/rail?secret=1")),
  N("registry /api/rail#fragment", (n) => n.registry("/api/rail#fragment")),
  N("registry /api/pulse", (n) => n.registry("/api/pulse")),
  N("registry /api/me", (n) => n.registry("/api/me")),
  N("registry /api/payouts", (n) => n.registry("/api/payouts")),
  N("registry /api/listings/23/submissions (a write route)", (n) => n.registry("/api/listings/23/submissions")),
  N("registry /api/listings/preimage", (n) => n.registry("/api/listings/preimage")),
  N("registry /api/%72ail (percent-encoded)", (n) => n.registry("/api/%72ail")),
  N("registry /API/RAIL", (n) => n.registry("/API/RAIL")),
  N("indexer /api/v2/tokens/<usdc> (not on the list)", (n) => n.indexer(`/api/v2/tokens/${ADDR.usdc}`)),
  N("indexer with apikey=", (n) => n.indexer(`/api/v2/addresses/${ADDR.treasury}/token-transfers?apikey=1`)),
  N("indexer on another origin", (n) => n.indexer(`https://evil.example/api/v2/addresses/${ADDR.treasury}/token-transfers`)),
  N("witness ../../x", (n) => n.witness("../../x")),
  N("local ../secret.json", (n) => n.local("../secret.json")),
  N("rpc to https://1f916.ai (not a node)", rpc1("https://1f916.ai", "eth_chainId")),
  N("rpc to an unknown node", rpc1("evil", "eth_chainId")),
  N("eth_sendRawTransaction", rpc1("base", "eth_sendRawTransaction", ["0x02"])),
  N("eth_sendTransaction", rpc1("base", "eth_sendTransaction", [{}])),
  N("eth_blockNumber (a read this page does not make)", rpc1("base", "eth_blockNumber")),
  N("eth_sign", rpc1("base", "eth_sign", [ADDR.treasury, "0x00"])),
  N("personal_sign", rpc1("base", "personal_sign", ["0x00", ADDR.treasury])),
  N("wallet_switchEthereumChain", rpc1("base", "wallet_switchEthereumChain", [{ chainId: "0x2105" }])),
  N("eth_accounts", rpc1("base", "eth_accounts")),
  N("debug_traceTransaction", rpc1("base", "debug_traceTransaction", [TX])),
  N("eth_newFilter", rpc1("base", "eth_newFilter", [{}])),
  N("eth_call transfer 0xa9059cbb", (n) => n.rpc("base", ethCall(ADDR.usdc, "0xa9059cbb" + word(ADDR.treasury) + "0".repeat(63) + "1"))),
  N("eth_call approve 0x095ea7b3", (n) => n.rpc("base", ethCall(ADDR.usdc, "0x095ea7b3" + word(ADDR.treasury) + "f".repeat(64)))),
  N("eth_call through Multicall3", (n) => n.rpc("base", ethCall(MULTICALL3, "0x70a08231" + word(ADDR.treasury)))),
  N("eth_call to a non-allowlisted target", (n) => n.rpc("base", ethCall(ADDR.treasury, "0x70a08231" + word(ADDR.treasury)))),
  N("eth_call carrying value", (n) => n.rpc("base", ethCall(ADDR.usdc, "0x18160ddd", { value: "0x1" }))),
  N("eth_call carrying from", (n) => n.rpc("base", ethCall(ADDR.usdc, "0x18160ddd", { from: ADDR.treasury }))),
  N("eth_call with ragged calldata", (n) => n.rpc("base", ethCall(ADDR.usdc, "0x70a08231abcd"))),
  N("eth_getBlockByNumber(n, true) (full transactions)", rpc1("base", "eth_getBlockByNumber", ["0x30d4000", true])),
  N("eth_getLogs without an address", (n) => n.rpc("base", { method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2", topics: [TRANSFER_TOPIC[1]] }] })),
  N("eth_getLogs over 2,001 blocks", (n) => n.rpc("base", logs(2001))),
  N("eth_getLogs of a non-allowlisted address", (n) => n.rpc("base", logs(10, { address: [ADDR.treasury] }))),
  N("eth_getLogs from 'latest'", (n) => n.rpc("base", logs(10, { fromBlock: "latest" }))),
  N("eth_getLogs with a blockHash", (n) => n.rpc("base", logs(10, { blockHash: TX }))),
  N("eth_getLogs with 4 topics", (n) => n.rpc("base", logs(10, { topics: [TRANSFER_TOPIC[1], null, null, null] }))),
  N("eth_getTransactionReceipt of a non-hash", rpc1("base", "eth_getTransactionReceipt", ["0x12"])),
  N("a batch with one bad element", (n) => n.rpc("base", [{ method: "eth_chainId", params: [] }, { method: "eth_sendRawTransaction", params: ["0x02"] }])),
  N("replay over 10,001 blocks", (n) => n.rpcVerbatim("tenderly", logs(10_001))),
  N("replay of an eth_call", (n) => n.rpcVerbatim("tenderly", ethCall(ADDR.usdc, "0x18160ddd"))),
  N("replay of a non-allowlisted address", (n) => n.rpcVerbatim("tenderly", logs(10_000, { address: [ADDR.treasury] }))),
  N("replay to an unknown node", (n) => n.rpcVerbatim("evil", logs(10))),
];
const CANNED = {
  eth_chainId: "0x2105", eth_blockNumber: "0x30d4000", eth_call: "0x" + "0".repeat(63) + "1", eth_getLogs: [],
  eth_getBlockByNumber: { number: "0x30d4000", hash: "0x" + "cd".repeat(32), timestamp: "0x68c2a000" },
  eth_getTransactionReceipt: { status: "0x1", blockNumber: "0x1", blockHash: "0x" + "cd".repeat(32), logs: [] },
};
function canned(url, init) {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (init?.method !== "POST") return url.includes("raw.githubusercontent.com") ? new Response('{"t":1}\n', { status: 200 }) : json({ ok: true });
  let b = null;
  try {
    b = JSON.parse(init.body);
  } catch {}
  const one = (q) => ({ jsonrpc: "2.0", id: q?.id ?? null, result: CANNED[q?.method] ?? null });
  return json(Array.isArray(b) ? b.map(one) : one(b));
}
function requestProblems(req, e, methods) {
  const p = [];
  const init = req.init ?? {};
  if (req.url !== new URL(e.url).href) p.push(`url ${req.url}`);
  if (init.method !== e.method) p.push(`method ${init.method}`);
  const h = JSON.stringify(Object.fromEntries(new Headers(init.headers ?? {})));
  if (h !== JSON.stringify(e.headers)) p.push(`headers ${h}`);
  for (const [k, v] of [["credentials", "omit"], ["redirect", "error"], ["referrerPolicy", "no-referrer"]]) if (init[k] !== v) p.push(`${k} ${init[k]}`);
  if (init.keepalive) p.push("keepalive");
  if (init.mode && init.mode !== "cors") p.push(`mode ${init.mode}`);
  if (e.method === "GET" && init.body != null) p.push("a GET with a body");
  if (e.rpc) {
    let b = null;
    try {
      b = JSON.parse(init.body);
    } catch {
      p.push("the body is not JSON");
    }
    const arr = Array.isArray(b) ? b : [b];
    const got = arr.map((x) => x?.method);
    if (JSON.stringify(got) !== JSON.stringify(e.rpc)) p.push(`body methods ${got.join(",")}`);
    if (arr.some((x) => x?.jsonrpc !== "2.0")) p.push("not JSON-RPC 2.0");
    if (got.some((x) => !methods.includes(x))) p.push("a body method outside RPC_METHODS");
  }
  return p;
}

async function R8(ctx) {
  const F = [];
  const net = ctx.mods.net;
  if (!net) return result("R8", "runtime guard, exercised", [fileHit("docs/js/net.js", `not import-safe in Node: ${ctx.mods.netError}`)], "net.js could not be imported");
  if (ctx.mods.netNetwork) F.push(fileHit("docs/js/net.js", `tried the network at import time: ${ctx.mods.netNetwork.join(", ")}`));
  const missing = ["registry", "indexer", "witness", "local", "rpc", "rpcVerbatim"].filter((k) => typeof net[k] !== "function");
  if (missing.length) F.push(fileHit("docs/js/net.js", `does not export ${missing.join(", ")}`));
  const calls = [];
  const saved = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, location: Object.getOwnPropertyDescriptor(globalThis, "location"), window: Object.getOwnPropertyDescriptor(globalThis, "window") };
  const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  const restore = (k) => (saved[k] ? Object.defineProperty(globalThis, k, saved[k]) : delete globalThis[k]);
  let waits = 0;
  const tape = [];
  const refused = [];
  let allowed = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return canned(String(url), init);
  };
  // Pacing waits are real in the page; here they are shortened to 0 ms. Under test is the guard, not the pacing
  // (H3 bounds the pacing constants).
  globalThis.setTimeout = (fn, ms, ...a) => {
    if (ms > 0) waits++;
    return saved.setTimeout(fn, 0, ...a);
  };
  setGlobal("location", { href: `${PAGE_ORIGIN}/tick-and-tie/`, origin: PAGE_ORIGIN });
  const methods = Array.isArray(net.RPC_METHODS) ? net.RPC_METHODS : [];
  const caseHit = (c, msg) => F.push({ file: "docs/js/net.js", line: null, text: "", msg: `R8 case "${c.name}": ${msg}` });
  try {
    for (const c of CASES) {
      const before = calls.length;
      let threw = null;
      let out;
      if (c.expect === "none") setGlobal("window", { top: {}, self: {} });
      try {
        out = await c.run(net);
      } catch (e) {
        threw = e;
      } finally {
        if (c.expect === "none") restore("window");
      }
      const made = calls.slice(before);
      if (c.expect === "refuse") {
        if (made.length) caseHit(c, `NOT refused: ${made.map((d) => `${d.init?.method} ${d.url}`).join(", ")}`);
        else if (!threw) caseHit(c, "sent nothing, but did not refuse either");
        else if (!(net.Refused && threw instanceof net.Refused) && !/^refused/i.test(threw.message)) caseHit(c, `threw ${threw.name}: ${threw.message}, which is not a refusal`);
        else refused.push(c.name);
      } else if (c.expect === "none") {
        if (threw || made.length || !(Array.isArray(out) && out.every((o) => o?.notRead))) caseHit(c, threw ? `threw ${threw.message}` : `${made.length} request(s) while framed`);
        else allowed++;
      } else if (threw) caseHit(c, `refused, but it is a read this page makes: ${threw.message}`);
      else if (made.length !== 1) caseHit(c, `${made.length} requests (expected exactly 1)`);
      else {
        const p = requestProblems(made[0], c.expect, methods);
        const okOut = c.expect.rpc ? (Array.isArray(out) ? out.every((o) => o && "result" in o && !o.notRead) : out?.status === 200) : out?.ok === true;
        if (!okOut) p.push("the answer did not come back as read");
        if (p.length) caseHit(c, p.join("; "));
        else {
          allowed++;
          const body = c.expect.rpc ? `  ${c.expect.rpc.join(",")}` : "";
          tape.push(`${c.expect.method.padEnd(4)} ${made[0].url.length > 92 ? made[0].url.slice(0, 91) + "…" : made[0].url}${body}`);
        }
      }
    }
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.setTimeout = saved.setTimeout;
    restore("location");
  }
  const nR = CASES.filter((c) => c.expect === "refuse").length;
  const notes = ["mini-tape (stub fetch; nothing left this machine):", ...tape.map((t) => "  " + t), `refused as designed: ${refused.length}/${nR} (send/sign/wallet/debug methods, write selectors, Multicall, extra keys, full blocks, wide or unaddressed logs, bad batches, traversal, userinfo, unknown routes and query keys)`];
  const nA = CASES.length - nR;
  return result("R8", "runtime guard, exercised", F, `${CASES.length} guard cases, stub fetch, 0 network: ${refused.length} refused as designed, ${allowed}/${nA} allowed with exact method, URL, headers and body${waits ? ` · ${waits} pacing waits shortened to 0 ms` : ""}`, notes);
}

function R9(ctx) {
  const F = [];
  const APIS = [/\b(?:localStorage|sessionStorage|indexedDB|openDatabase|BroadcastChannel|cookieStore|webkitRequestFileSystem|requestFileSystem)\b/g, /\bcaches\s*\./g, /\bdocument\s*\.\s*cookie\b/g, /\bnavigator\s*\.\s*storage\b/g, /\bserviceWorker\b/g, /\bwindow\s*\.\s*name\s*=(?!=)/g];
  for (const j of ctx.js) {
    for (const re of APIS) grep(F, j.rel, j.s, j.s.code, re, (m) => `${m[0].replace(/\s+/g, "")}: this page stores nothing`);
    grep(F, j.rel, j.s, j.s.codeStr, /\[\s*(["'`])(localStorage|sessionStorage|indexedDB|caches|cookie|serviceWorker)\1\s*\]/g, (m) => `["${m[2]}"]: storage through a string key`);
  }
  return result("R9", "no storage", F, `0 localStorage/sessionStorage/indexedDB/caches/cookies/serviceWorker/BroadcastChannel/window.name in ${plural(ctx.js.length, "JS file")}`);
}

function R10(ctx) {
  const F = [];
  const APIS = [/\b(?:window|globalThis|self)\s*\.\s*(?:ethereum|solana|phantom|coinbaseWalletExtension|okxwallet)\b/g, /\bethereum\s*\.\s*(?:request|enable|send|sendAsync|on)\b/g, /\beip6963\w*/gi, /\bweb3\b/g, /walletconnect/gi, /\bnavigator\s*\.\s*credentials\b/g, /\bPaymentRequest\b/g, /\bPublicKeyCredential\b/g];
  for (const j of ctx.js) {
    for (const re of APIS) grep(F, j.rel, j.s, j.s.code, re, (m) => `${m[0]}: a wallet or credential surface`);
    grep(F, j.rel, j.s, j.s.codeStr, /\[\s*(["'`])ethereum\1\s*\]|(["'`])eip6963:/g, "a wallet provider through a string key");
  }
  return result("R10", "no wallet", F, `0 window.ethereum/EIP-6963/web3/WalletConnect/navigator.credentials/PaymentRequest in ${plural(ctx.js.length, "JS file")}`);
}

// ================================================================================================================
// CONDITION 2 · nowhere to type
// ================================================================================================================

function T1(ctx) {
  const F = [];
  const count = { button: 0, details: 0, dialog: 0, a: 0 };
  if (!ctx.html.length) F.push(fileHit("docs/index.html", "missing: there is no page to check yet"));
  for (const h of [...ctx.html, ...ctx.svg]) {
    for (const t of h.s.tags) {
      if (t.closing) continue;
      const at = (msg) => F.push(hitAt(h.rel, h.s, t.start, msg));
      if (t.name in count) count[t.name]++;
      if (FORBIDDEN_TAGS.includes(t.name)) at(`<${t.name}>: a field, or form vocabulary, or a frame`);
      if ("contenteditable" in t.attrs) at(`contenteditable on <${t.name}>`);
      const roles = (t.attrs.role || "").toLowerCase().split(/\s+/).filter((r) => TEXT_ROLES.includes(r));
      if (roles.length) at(`role="${roles.join(" ")}" on <${t.name}>`);
      if (t.name === "button" && (t.attrs.type || "").toLowerCase() !== "button") at('<button> without type="button"');
      if ("srcdoc" in t.attrs) at("srcdoc= (markup from a string)");
    }
    // The same list again over the permissive pass, for an opening tag the strict one could not parse: Chromium builds
    // <input name=a"b> and <input data/x> as real elements (void or paired alike — the paired one's </textarea> parses
    // and would be all this check saw), so a forbidden name must be a finding whatever the attributes look like.
    for (const l of h.s.loose) {
      if (l.closing || l.parsed || !FORBIDDEN_TAGS.includes(l.name)) continue;
      F.push(hitAt(h.rel, h.s, l.start, `<${l.name} whose attributes do not parse: a browser still builds the element (a field, or form vocabulary, or a frame)`));
    }
  }
  const loose = [...ctx.html, ...ctx.svg].reduce((n, h) => n + h.s.loose.filter((l) => !l.closing).length, 0);
  return result("T1", "HTML", F, `0 input/textarea/select/form/option/datalist/output/label/fieldset/legend/iframe/object/embed/foreignObject · 0 contenteditable · 0 textbox roles · ${count.button} <button type="button">, ${count.details} <details>, ${count.dialog} <dialog>, ${count.a} links in ${plural(ctx.html.length, "page")} · ${plural(loose, "opening tag")} also read permissively (a forbidden name counts even where its attributes do not parse)`);
}

/**
 * Property writes that name the property in a string or an object literal instead of after a dot: x["href"] = …,
 * Object.assign(x, { innerHTML: … }), Object.defineProperty(x, "src", …), Reflect.set(x, "onclick", …).
 */
function reflectiveWrites(s) {
  const out = [];
  for (const m of s.codeStr.matchAll(/\[\s*(["'`])([\w:-]+)\1\s*\]\s*=(?!=)\s*/g)) out.push({ off: m.index, key: m[2], how: `["${m[2]}"] =`, rhs: s.codeStr.slice(m.index + m[0].length) });
  for (const m of s.code.matchAll(/\b(Object\s*\.\s*(?:assign|defineProperty|defineProperties)|Reflect\s*\.\s*(?:set|defineProperty))\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = s.codeStr.slice(open, closer(s.code, open) + 1);
    for (const k of args.matchAll(/(?:^|[{,(\s])(["'`]?)([\w:-]+)\1\s*[:,]/g)) out.push({ off: m.index, key: k[2], how: m[1].replace(/\s+/g, ""), rhs: "" });
  }
  return out;
}

// Positions where a name decides what an element is or does: [what it names, which argument, must be a literal].
// createElementNS/setAttributeNS take the namespace first, so their name is the second argument.
const NAMED_ARGS = {
  addEventListener: ["event name", 0, true], removeEventListener: ["event name", 0, true],
  createElement: ["tag name", 0, false], createElementNS: ["tag name", 1, false],
  setAttribute: ["attribute name", 0, false], setAttributeNS: ["attribute name", 1, false],
};

function T2(ctx) {
  const F = [];
  const handed = [];
  const tags = FORBIDDEN_TAGS.join("|");
  for (const j of ctx.js) {
    const g = (text, re, msg) => grep(F, j.rel, j.s, text, re, msg);
    g(j.s.codeStr, new RegExp(`\\bcreateElement(?:NS)?\\s*\\(\\s*(?:[^,()]*,\\s*)?(["'\`])\\s*(${tags})\\s*\\1`, "gi"), (m) => `createElement("${m[2]}")`);
    g(j.s.code, /\bcontentEditable\b|\bdesignMode\b|\bexecCommand\b|\b(?:webkit)?[uU]serModify\b/g, (m) => m[0]);
    g(j.s.codeStr, /\bsetAttribute(?:NS)?\s*\(\s*(?:[^,()]*,\s*)?(["'`])contenteditable\1/gi, "setAttribute(contenteditable)");
    g(j.s.code, /(?<![\w$])prompt\s*\(/g, "prompt()");
    g(j.s.code, /\bshow(?:Open|Save|Directory)(?:File)?Picker\b/g, (m) => m[0]);
    g(j.s.code, /\bnavigator\s*\.\s*clipboard\b|\bclipboardData\b|\bClipboardItem\b/g, (m) => `${m[0].replace(/\s+/g, "")}: reading pasted text is input`);
    g(j.s.codeStr, new RegExp(`\\baddEventListener\\s*\\(\\s*(["'\`])(${TYPING_EVENTS})\\1`, "g"), (m) => `a "${m[2]}" listener (input; <dialog> gives Esc without one)`);
    g(j.s.code, new RegExp(`\\.\\s*on(${TYPING_EVENTS})\\s*=(?!=)`, "g"), (m) => `on${m[1]} = (input)`);
    g(j.s.codeStr, /\bsetAttribute(?:NS)?\s*\(\s*(?:[^,()]*,\s*)?(["'`])(on[a-z]+|style)\1/gi, (m) => `setAttribute("${m[2]}")`);
    // The rules above read names the files spell out. A name assembled where it is used — ["key","down"].join(""),
    // "in" + "put", "content" + "editable" — reads the same to a browser and says nothing here, so the position itself
    // is the rule: an event name must be a plain string literal; a tag or attribute name may also be a bare variable,
    // because the page hands one along (ui.js el(tag, props), whose call sites are checked below) and the notes say where.
    for (const m of j.s.code.matchAll(/(?<![\w$])(addEventListener|removeEventListener|createElement|createElementNS|setAttribute|setAttributeNS)\s*\(/g)) {
      const [what, idx, literalOnly] = NAMED_ARGS[m[1]];
      const range = callArgs(j.s.code, m.index + m[0].length - 1)?.[idx];
      if (!range) continue;
      const shape = nameShape(j.s, range);
      if (shape === "built" || (literalOnly && shape === "variable")) F.push(hitAt(j.rel, j.s, m.index, `${m[1]}(): the ${what} is ${shape === "variable" ? "a variable, not a literal" : "assembled where it is used"} — ${BUILT}`));
      else if (shape === "variable") handed.push(`${j.rel}:${j.s.lineOf(m.index)} ${m[1]}() takes its ${what} from a variable, so no file names it at this line; the names it is given are checked where they are written (the literals handed to an element factory, and the attribute keys in object literals)`);
    }
    // href/src only through safeLink(), or as a same-document "#…" fragment
    const safe = fnBody(j.s, "safeLink");
    const ok = (off) => safe && off >= safe[0] && off < safe[1];
    for (const m of j.s.code.matchAll(/\.\s*(href|src|srcset|action|formAction|ping)\s*=(?!=)/g)) {
      const rhs = j.s.codeStr.slice(m.index + m[0].length).trimStart();
      if (!ok(m.index) && !/^(["'`])#/.test(rhs)) F.push(hitAt(j.rel, j.s, m.index, `.${m[1]} = outside safeLink()`));
    }
    for (const m of j.s.codeStr.matchAll(/\bsetAttribute(?:NS)?\s*\(\s*(?:[^,()]*,\s*)?(["'`])(href|src|srcset|action|formaction|ping|xlink:href)\1\s*,\s*/gi)) {
      const rhs = j.s.codeStr.slice(m.index + m[0].length);
      if (!ok(m.index) && !/^(["'`])#/.test(rhs)) F.push(hitAt(j.rel, j.s, m.index, `setAttribute("${m[2]}") outside safeLink()`));
    }
    for (const w of reflectiveWrites(j.s)) {
      if (/^(href|src|srcset|action|formaction|ping)$/i.test(w.key) && !ok(w.off) && !/^(["'`])#/.test(w.rhs)) F.push(hitAt(j.rel, j.s, w.off, `${w.how} sets ${w.key} outside safeLink()`));
      if (/^(contenteditable|on(click|dblclick|auxclick|contextmenu|mouse\w+|pointer\w+|touch\w+|key\w+|input|beforeinput|change|paste|cut|copy|focus|blur|submit|load|error|message|wheel|drag\w*|drop|composition\w+|toggle|scroll))$/i.test(w.key)) F.push(hitAt(j.rel, j.s, w.off, `${w.how} sets ${w.key}`));
    }
  }
  // Element factories: functions that call createElement(NS) with a variable tag, like ui.js el(tag, props). A literal
  // tag handed to one is checked like a createElement literal, and a "button" must be given type: "button".
  const decl = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^(]*)?\(/g;
  const factories = new Set();
  for (const j of ctx.js) {
    const names = [...j.s.code.matchAll(decl)].map((x) => x[1] ?? x[2]);
    for (const m of j.s.code.matchAll(/\bcreateElement(?:NS)?\s*\(\s*(?:[^,()]*,\s*)?[A-Za-z_$][\w$]*\s*\)/g)) {
      for (const name of names) {
        const b = fnBody(j.s, name);
        if (b && m.index >= b[0] && m.index < b[1]) factories.add(name);
      }
    }
  }
  for (const j of ctx.js) {
    for (const name of factories) {
      for (const m of j.s.codeStr.matchAll(new RegExp(`(?<![\\w$.])${escRe(name)}\\s*\\(\\s*(["'\`])([\\w-]+)\\1`, "g"))) {
        const tag = m[2].toLowerCase();
        if (FORBIDDEN_TAGS.includes(tag)) F.push(hitAt(j.rel, j.s, m.index, `${name}("${m[2]}") builds a field, form vocabulary or a frame`));
        if (tag !== "button") continue;
        let k = m.index + m[0].length;
        while (/\s/.test(j.s.code[k] ?? "")) k++;
        if (j.s.code[k] === ",") k++;
        while (/\s/.test(j.s.code[k] ?? "")) k++;
        const props = j.s.code[k] === "{" ? j.s.codeStr.slice(k, closer(j.s.code, k) + 1) : "";
        if (!/\btype\s*:\s*(["'])button\1/.test(props)) F.push(hitAt(j.rel, j.s, m.index, `${name}("button") without type: "button"`));
      }
      // The same factory handed a tag assembled at the call site: el("in" + "put") builds what el("input") builds, and
      // the literal rule above cannot read it.
      for (const m of j.s.code.matchAll(new RegExp(`(?<![\\w$.])${escRe(name)}\\s*\\(`, "g"))) {
        const range = callArgs(j.s.code, m.index + m[0].length - 1)?.[0];
        if (range && nameShape(j.s, range) === "built") F.push(hitAt(j.rel, j.s, m.index, `${name}(): the tag name is assembled where it is used — ${BUILT}`));
      }
    }
    grep(F, j.rel, j.s, j.s.codeStr, /[{,]\s*(["']?)(contenteditable|srcdoc)\1\s*:/gi, (m) => `an attribute key ${m[2]} (a generic attribute helper would set it)`);
    grep(F, j.rel, j.s, j.s.codeStr, /[{,]\s*(["']?)role\1\s*:\s*(["'`])(textbox|searchbox|combobox|spinbutton)\2/gi, (m) => `role: "${m[3]}"`);
  }
  const fac = factories.size ? ` · element factories checked: ${[...factories].map((f) => f + "()").join(", ")}` : "";
  return result("T2", "JS", F, `0 key/input/paste/message listeners · 0 prompt/clipboard/designMode/contentEditable · 0 field tags built (createElement or a factory) · buttons typed · every listener event a string literal, every tag and attribute name a literal or a variable handed along (${handed.length} of those, listed below), none assembled in place · href/src only in safeLink() or as #fragments${fac}`, handed);
}

function T3(ctx) {
  const F = [];
  for (const c of ctx.css) {
    const g = (re, msg) => grep(F, c.rel, c.s, c.s.clean, re, msg);
    g(/(?:-webkit-)?user-modify/gi, "user-modify makes text editable");
    g(/@import\b/gi, "@import");
    g(/url\(\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/gi, (m) => `${m[0]}…: an off-origin or data: URL (the CSP allows 'self' only)`);
    g(/(?<![\w-])expression\s*\(|-moz-binding|(?<![\w-])behavior\s*:/gi, "script in CSS");
  }
  return result("T3", "CSS", F, `${plural(ctx.css.length, "stylesheet")} · 0 user-modify · 0 @import · 0 off-origin url()${ctx.css.length ? "" : " (no stylesheet yet)"}`);
}

function T4(ctx) {
  const F = [];
  for (const j of ctx.js) {
    const g = (text, re, msg) => grep(F, j.rel, j.s, text, re, msg);
    g(j.s.code, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|srcdoc|setHTMLUnsafe|parseHTMLUnsafe)\b|\bdocument\s*\.\s*write(?:ln)?\b/g, (m) => `${m[0].replace(/\s+/g, "")}: an HTML sink (use textContent/createElement)`);
    g(j.s.codeStr, /\[\s*(["'`])(innerHTML|outerHTML|insertAdjacentHTML|srcdoc|setHTMLUnsafe)\1\s*\]/g, (m) => `["${m[2]}"]: an HTML sink through a string key`);
    for (const w of reflectiveWrites(j.s)) if (/^(innerHTML|outerHTML|srcdoc)$/.test(w.key) && !w.how.startsWith("[")) F.push(hitAt(j.rel, j.s, w.off, `${w.how} sets ${w.key}: an HTML sink`));
    g(j.s.code, /\beval\s*\(|\bFunction\s*\(/g, (m) => `${m[0]}: code from a string`);
    g(j.s.codeStr, /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g, "a timer given a string (eval)");
  }
  return result("T4", "sinks", F, `0 innerHTML/outerHTML/insertAdjacentHTML/document.write/DOMParser/srcdoc/setHTMLUnsafe/eval/new Function/string timers in ${plural(ctx.js.length, "JS file")}`);
}

// ================================================================================================================
// CONDITION 3 · signed and open
// ================================================================================================================

function S1(ctx) {
  const F = [];
  const L = ctx.license;
  if (L === null) F.push(fileHit("LICENSE", "missing: the source is not licensed yet"));
  else {
    if (!/\bMIT License\b|Permission is hereby granted, free of charge/i.test(L)) F.push(fileHit("LICENSE", "not the MIT license"));
    if (!L.includes(PIN.handle)) F.push(fileHit("LICENSE", `does not name ${PIN.handle}`));
  }
  const fonts = ctx.files.filter((f) => /\.(woff2?|ttf|otf)$/.test(f.rel));
  const ofl = ctx.files.filter((f) => /^fonts\/OFL[^/]*\.txt$/i.test(f.in) && /SIL OPEN FONT LICENSE/i.test(f.text ?? ""));
  if (fonts.length && !ofl.length) F.push(fileHit("docs/fonts/OFL.txt", `missing: ${plural(fonts.length, "font file")} ship without the SIL OFL text`));
  const lic = L === null ? "LICENSE missing" : F.some((x) => x.file === "LICENSE") ? "LICENSE present, see findings" : `LICENSE MIT, names ${PIN.handle}`;
  return result("S1", "licenses", F, `${lic} · ${fonts.length ? `${plural(fonts.length, "font")}, OFL text: ${ofl.map((f) => f.in).join(", ") || "none"}` : "no font files"}`);
}

function S2(ctx) {
  const F = [];
  const R = ctx.readme;
  if (R === null) return result("S2", "README", [fileHit("README.md", "missing")], "README.md missing");
  for (const [needle, what] of [[PIN.handle, "the handle"], [PIN.citizen, "the citizen number"], [PIN.thumbprint, "the key thumbprint"], [PIN.listing, "the listing URL"]]) if (!R.includes(needle)) F.push(fileHit("README.md", `does not name ${what} (${needle})`));
  const section = (re) => {
    const m = re.exec(R);
    if (!m) return null;
    const level = m[1].length;
    const rest = R.slice(m.index + m[0].length);
    const next = new RegExp(`^#{1,${level}}\\s`, "m").exec(rest);
    return rest.slice(0, next ? next.index : rest.length);
  };
  if (section(/^(#{1,6})\s*What this does not prove\b.*$/im) === null) F.push(fileHit("README.md", 'no section "What this does not prove"'));
  const credit = section(/^(#{1,6})\s*Credits?\b.*$/im);
  if (credit === null) F.push(fileHit("README.md", 'no section "Credit"'));
  else if (!credit.includes("tardis-relay")) F.push(fileHit("README.md", 'the "Credit" section does not name tardis-relay'));
  if (section(/^(#{1,6})\s*Conflicts?\b.*$/im) === null) F.push(fileHit("README.md", 'no section "Conflicts"'));
  return result("S2", "README", F, `README: ${PIN.handle} ${PIN.citizen} · thumbprint ${PIN.thumbprint.slice(0, 4)}…${PIN.thumbprint.slice(-3)} · listing 23 · credits tardis-relay · conflicts stated`);
}

function S3(ctx) {
  const F = [];
  const page = ctx.html.find((h) => h.rel === "docs/index.html");
  if (!page) return result("S3", "signature line", [fileHit("docs/index.html", "missing")], "no page yet");
  const m = /<footer\b[\s\S]*?<\/footer>/i.exec(page.s.clean);
  if (!m) F.push(fileHit(page.rel, "no <footer>"));
  else {
    const text = m[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (!new RegExp(`Built and signed by ${PIN.handle}`, "i").test(text)) F.push(hitAt(page.rel, page.s, m.index, `the footer lacks "Built and signed by ${PIN.handle}"`));
    const hrefs = [...m[0].matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((x) => x[1]);
    for (const want of [`https://1f916.ai/api/citizen/${PIN.handle}`, `https://1f916.ai/api/keys/${PIN.handle}`]) if (!hrefs.includes(want)) F.push(hitAt(page.rel, page.s, m.index, `the footer does not link ${want}`));
    if (!hrefs.some((h) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(h))) F.push(hitAt(page.rel, page.s, m.index, "the footer does not link the source repository"));
  }
  return result("S3", "signature line", F, `footer: "Built and signed by ${PIN.handle}" · links /api/citizen/${PIN.handle}, /api/keys/${PIN.handle} and the repo`);
}

function S4(ctx) {
  const F = [];
  const mf = ctx.byIn.get("MANIFEST.txt");
  let summary = "no MANIFEST.txt (optional)";
  if (mf) {
    let n = 0;
    for (const [i, raw] of mf.text.split("\n").entries()) {
      const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(raw.trim());
      if (!m) continue;
      n++;
      const f = ctx.byIn.get(m[2]);
      if (!f) F.push({ file: mf.rel, line: i + 1, text: raw.trim(), msg: `lists ${m[2]}, which is not served` });
      else if (f.sha !== m[1]) F.push({ file: mf.rel, line: i + 1, text: raw.trim(), msg: `${m[2]} is ${short(f.sha)} now` });
    }
    summary = `MANIFEST.txt: ${n} lines, each recomputed`;
    const sig = ctx.byIn.get("SIGNATURE.txt");
    if (!sig) summary += " · not signed (SIGNATURE.txt absent; not a failure)";
    else {
      const b64 = sig.text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
      const msg = `1f916.window.v1:${PIN.handle}:${mf.sha}`;
      let ok = false;
      try {
        ok = edVerify(null, Buffer.from(msg), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: PIN.key }, format: "jwk" }), Buffer.from(b64, "base64url"));
      } catch {}
      if (!ok) F.push(fileHit(sig.rel, `does not verify as ${PIN.handle}'s Ed25519 signature over "${msg.slice(0, 40)}…"`));
      else summary += ` · SIGNATURE.txt verifies against ${PIN.handle}'s pinned key`;
    }
  }
  return result("S4", "manifest", F, summary);
}

function S5(ctx) {
  const F = [];
  const vendored = ctx.files.filter((f) => f.in.startsWith("js/vendor/"));
  if (!vendored.length) return result("S5", "vendored code", F, "no vendored code");
  const lockPath = ["VENDOR.lock", "docs/js/vendor/VENDOR.lock"].find((p) => existsSync(join(ctx.root, p)));
  let lock = null;
  try {
    lock = lockPath ? JSON.parse(readFileSync(join(ctx.root, lockPath), "utf8")) : null;
  } catch {
    F.push(fileHit(lockPath, "not JSON"));
  }
  const entries = Array.isArray(lock) ? lock : lock?.files ?? [];
  for (const f of vendored) {
    if (f.in.endsWith("VENDOR.lock")) continue;
    const e = entries.find((x) => x.file === f.in || x.file === f.rel || x.path === f.in);
    if (!e) F.push(fileHit(f.rel, "not in VENDOR.lock"));
    else if (e.sha256 !== f.sha) F.push(fileHit(f.rel, `sha256 ${short(f.sha)} ≠ VENDOR.lock ${short(e.sha256)}`));
    if (e && !e.license) F.push(fileHit(f.rel, "VENDOR.lock names no license"));
  }
  return result("S5", "vendored code", F, `${plural(vendored.length, "vendored file")} match VENDOR.lock`);
}

function S6(ctx) {
  const F = [];
  const tf = textFiles(ctx);
  for (const { f, s } of tf) {
    grep(F, f.rel, s, f.text, /(?:^|[^\w.-])(\/home\/|\/tmp\/|\/Users\/|[A-Za-z]:\\Users\\)/g, (m) => `a local path (${m[1]}…)`);
    if (!/^(OFL|LICENSE|COPYING|NOTICE)/i.test(basename(f.rel))) grep(F, f.rel, s, f.text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, "an email address");
  }
  return result("S6", "no local paths or emails", F, `0 /home/, /tmp/ or email addresses in ${plural(tf.length, "served text file")}`);
}

// Patterns are assembled at run time so that this file does not itself match them.
const SECRET_CONTENT = [
  [new RegExp(["1f916", "_sk_", "[A-Za-z0-9_-]{12,}"].join("")), "a citizen secret"],
  [new RegExp(["-----BEGIN ", "(?:[A-Z0-9]+ )*", "PRIVATE KEY-----"].join("")), "a PEM private key"],
  [new RegExp(["TG_BOT", "_TOKEN"].join("")), "a Telegram bot token variable"],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/, "a Telegram bot token"],
];
const SECRET_NAMES = /\.(pem|secret|key|p12|pfx|jks|headers)$|register\.json$|(^|\/)\.env(\.[\w-]+)?$|(^|\/)id_(rsa|ecdsa|ed25519)$/i;
function S7(ctx) {
  const F = [];
  const { files, links } = walk(ctx.root, ctx.root);
  for (const f of files) {
    if (SECRET_NAMES.test(f.rel)) F.push(fileHit(f.rel, "a key or secret file name"));
    if (f.size > 5e6) continue;
    const buf = readFileSync(f.abs);
    if (buf.subarray(0, 8000).includes(0)) continue;
    const text = buf.toString("utf8");
    for (const [re, what] of SECRET_CONTENT) {
      const m = re.exec(text);
      if (m) {
        const s = lines(text);
        const ln = s.lineOf(m.index);
        F.push({ file: f.rel, line: ln, text: "(not printed)", msg: what });
      }
    }
  }
  return result("S7", "no secrets in the repo", F, `whole repo: ${plural(files.length, "file")} (.git and node_modules skipped${links.length ? `, ${plural(links.length, "symlink")} not followed` : ""}) · 0 citizen secrets, private keys, bot tokens, *.pem/*.secret/register.json/*.headers`);
}

// ================================================================================================================
// Hygiene
// ================================================================================================================

function H1(ctx) {
  const ok = ctx.byIn.has(".nojekyll");
  return result("H1", ".nojekyll", ok ? [] : [fileHit("docs/.nojekyll", "missing: Pages would run Jekyll over docs/")], ok ? "docs/.nojekyll present" : "docs/.nojekyll missing");
}

async function H2(ctx) {
  const F = [];
  const notes = [];
  let routes = SURFACE;
  let sha = sha256(JSON.stringify(SURFACE.map((r) => `${r.method} ${r.path}`).sort()));
  let source = "pinned copy of GET /api/surface (2026-09-11)";
  if (sha !== SURFACE_SHA) F.push(fileHit(SELF, `the pinned surface hashes to ${short(sha)}, not ${short(SURFACE_SHA)}`));
  if (ctx.opts.liveSurface) {
    try {
      const res = await realFetch("https://1f916.ai/api/surface", { method: "GET", headers: { accept: "application/json" }, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
      const j = await res.json();
      routes = j.routes.map((r) => ({ method: r.method, auth: r.auth, writes: !!r.writes, path: r.path }));
      sha = sha256(JSON.stringify(routes.map((r) => `${r.method} ${r.path}`).sort()));
      source = `live GET /api/surface (catalogue_sha256 ${short(sha)}${sha === SURFACE_SHA ? ", same as pinned" : ", CHANGED since the pin"})`;
    } catch (e) {
      F.push(fileHit("https://1f916.ai/api/surface", `--live-surface: not read (${e.message})`));
    }
  }
  const rr = ctx.mods.net?.REGISTRY_ROUTES;
  if (!Array.isArray(rr)) F.push(fileHit("docs/js/net.js", "REGISTRY_ROUTES not readable"));
  else {
    const samples = (p) => [p.replace(/:(\w+)/g, (_, k) => (k === "handle" ? PIN.handle : k === "day" ? "2026-09-11" : k === "slug" ? "grant" : "1")), p.replace(/:(\w+)/g, "1")];
    for (const r of rr) {
      const re = r?.path;
      if (!(re instanceof RegExp) || !re.source.startsWith("^") || !re.source.endsWith("$")) {
        F.push(fileHit("docs/js/net.js", `route ${String(re)} is not an anchored RegExp`));
        continue;
      }
      // registry() only ever sends GET (R3, R8), so a POST route on the same path is unreachable through it
      const all = routes.filter((s) => samples(s.path).some((p) => re.test(p)));
      const hits = all.filter((s) => ["GET", "*"].includes(s.method));
      if (!hits.length) F.push(fileHit("docs/js/net.js", `route ${re.source} matches no GET route in the surface`));
      for (const s of hits) if (!(s.auth === "none" && !s.writes)) F.push(fileHit("docs/js/net.js", `route ${re.source} reaches ${s.method} ${s.path} (auth ${s.auth}, writes ${s.writes})`));
      if (hits.some((s) => s.path === "/api/pulse")) F.push(fileHit("docs/js/net.js", "/api/pulse (auth optional) is on the list"));
      const other = all.filter((s) => !hits.includes(s)).map((s) => `${s.method} ${s.path}`);
      notes.push(`${re.source.padEnd(44)} → ${hits.map((s) => `${s.method} ${s.path}`).join(", ") || "—"}${other.length ? ` (also ${other.join(", ")} on that path: not reachable, registry() is GET-only)` : ""}`);
    }
  }
  return result("H2", "registry routes vs /api/surface", F, `every REGISTRY_ROUTES entry maps to a GET, auth none, writes false route · ${source}, catalogue_sha256 ${short(sha)} recomputed`, notes);
}

function H3(ctx) {
  const F = [];
  const notes = [];
  const net = ctx.mods.net;
  const B = net?.BUDGET;
  const at = (needle, msg) => {
    const i = ctx.net ? ctx.net.s.src.indexOf(needle) : -1;
    F.push(i >= 0 ? hitAt(ctx.net.rel, ctx.net.s, i, msg) : fileHit("docs/js/net.js", msg));
  };
  if (!B) return result("H3", "budgets", [fileHit("docs/js/net.js", "BUDGET not exported")], "no BUDGET");
  if (!(B.maxLogsSpan > 0 && B.maxLogsSpan <= BUDGET_BOUNDS.maxLogsSpan)) at("maxLogsSpan", `maxLogsSpan ${B.maxLogsSpan} (bound ≤ ${BUDGET_BOUNDS.maxLogsSpan})`);
  if (!(B.rpc?.max > 0 && B.rpc.max <= BUDGET_BOUNDS.rpcMax)) at("rpc:", `rpc.max ${B.rpc?.max} (bound ≤ ${BUDGET_BOUNDS.rpcMax})`);
  if (!(B.timeoutMs > 0 && B.timeoutMs <= BUDGET_BOUNDS.timeoutMs)) at("timeoutMs", `timeoutMs ${B.timeoutMs} (bound ≤ 20 s)`);
  for (const door of ["registry", "indexer", "witness", "rpc"]) {
    const d = B[door];
    if (!d) at("BUDGET", `BUDGET.${door} missing`);
    else {
      if (!(d.capBytes > 0 && d.capBytes <= BUDGET_BOUNDS.capBytes)) at(`${door}:`, `${door}.capBytes ${d.capBytes} (bound 1–${BUDGET_BOUNDS.capBytes})`);
      if (!(d.max > 0)) at(`${door}:`, `${door}.max ${d.max}`);
      if (!(d.inflight >= 1 && d.inflight <= 3)) at(`${door}:`, `${door}.inflight ${d.inflight} (bound 1–3)`);
    }
  }
  for (const [door, cap] of [["registry", 40], ["indexer", 12], ["witness", 2]]) if (B[door]?.max > cap) notes.push(`${door}.max ${B[door].max} per load is above the review's ${cap} (critique §4.1)`);
  const R = net.REPLAY_MAX_SPAN;
  if (typeof R !== "number") at("rpcVerbatim", "REPLAY_MAX_SPAN not exported (the replay's span must be bounded and visible)");
  else if (!(R > 0 && R <= BUDGET_BOUNDS.replayMaxSpan)) at("REPLAY_MAX_SPAN", `REPLAY_MAX_SPAN ${R} (bound ≤ ${BUDGET_BOUNDS.replayMaxSpan})`);
  else notes.push(`allowed exception: rpcVerbatim() replays ONE eth_getLogs of up to ${R.toLocaleString("en-US")} blocks per observer mark (the registry observer's own next call, for the diagnosis); every other getLogs is capped at ${B.maxLogsSpan.toLocaleString("en-US")}`);
  for (const [id, n] of Object.entries(net.NODES ?? {})) {
    if (!/^https:\/\//.test(n.url)) at(n.url, `node ${id} is not https`);
    if (n.logsSpan > B.maxLogsSpan) at(id, `node ${id} logsSpan ${n.logsSpan} > maxLogsSpan`);
    if (!(n.batch >= 1 && n.batch <= 10)) at(id, `node ${id} batch ${n.batch} (bound 1–10)`);
  }
  if (!Object.isFrozen(net.NODES ?? {})) at("NODES", "NODES is not frozen");
  return result("H3", "budgets", F, `getLogs span ≤ ${B.maxLogsSpan} · RPC ≤ ${B.rpc?.max}/load · registry ≤ ${B.registry?.max} · indexer ≤ ${B.indexer?.max} · byte caps set · timeout ${B.timeoutMs / 1000} s`, notes);
}

function H4(ctx) {
  const F = [];
  if (ctx.net) grep(F, ctx.net.rel, ctx.net.s, ctx.net.s.code, /\bsetInterval\s*\(/g, "setInterval in net.js (no polling)");
  for (const j of ctx.js) {
    if (j === ctx.net || !/\bsetInterval\s*\(/.test(j.s.code)) continue;
    for (const im of staticImports(j.s)) if (/(^|\/)net\.js$/.test(im.spec)) F.push(hitAt(j.rel, j.s, im.off, "a module with setInterval imports net.js (a polling loop)"));
  }
  return result("H4", "no polling", F, "no setInterval in net.js, and no timer module imports it");
}

// ---- running ----------------------------------------------------------------------------------------------------
const CHECKS = [
  ["1", "reads, never writes", [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10]],
  ["2", "nowhere to type", [T1, T2, T3, T4]],
  ["3", "signed and open", [S1, S2, S3, S4, S5, S6, S7]],
  ["H", "hygiene", [H1, H2, H3, H4]],
];
async function runChecks(root, opts = {}) {
  const ctx = await load(root, opts);
  const results = [];
  for (const [cond, , fns] of CHECKS) {
    for (const fn of fns) {
      try {
        results.push({ cond, ...(await fn(ctx)) });
      } catch (e) {
        results.push({ cond, id: fn.name, title: "internal error", status: "ERROR", summary: `${e?.name}: ${e?.message}`, findings: [], notes: String(e?.stack ?? "").split("\n").slice(1, 4).map((x) => x.trim()) });
      }
    }
  }
  return { ctx, results };
}

// D1 (--deployed): every served file, fetched from the live site with GET, must hash like the local copy.
async function deployed(ctx, base) {
  const F = [];
  const u = new URL(base.endsWith("/") ? base : base + "/");
  const files = ctx.files.filter((f) => !basename(f.rel).startsWith("."));
  let same = 0;
  let retried = 0;
  // A blip is not a mismatch. Ask up to three times for a thrown error or a status the CDN retries on, and
  // count the retries in the summary, so a slow network cannot be mistaken for a page that fails its own audit.
  // A 200 whose hash differs is an answer, not a blip: it is never retried.
  const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  for (const f of files) {
    const url = new URL(f.in.split("/").map(encodeURIComponent).join("/"), u).href;
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) {
        retried++;
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
      try {
        const res = await realFetch(url, { method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store" });
        const got = sha256(Buffer.from(await res.arrayBuffer()));
        if (res.status === 200) {
          if (got === f.sha) same++;
          else F.push(fileHit(f.rel, `deployed ${short(got)} ≠ local ${short(f.sha)}`));
          last = null;
          break;
        }
        last = fileHit(f.rel, `HTTP ${res.status} at ${url}`);
        if (!RETRY_STATUS.has(res.status)) break;
      } catch (e) {
        last = fileHit(f.rel, `not read at ${url}: ${e.message}`);
      }
    }
    if (last) F.push(last);
  }
  const note = retried ? ` ${retried} request${retried === 1 ? "" : "s"} needed a retry` : "";
  return { cond: "D", ...result("D1", "deployed bytes", F, `${same}/${files.length} files at ${u.href} byte-identical to docs/ (GET only, no cookies; Pages may cache up to 10 min).${note}`) };
}

// ---- the self-test: plant each violation in a temporary copy, and require the check that owns it to notice -------
const edit = (root, p, fn) => {
  const f = join(root, p);
  if (!existsSync(f)) return false;
  const a = readFileSync(f, "utf8");
  const b = fn(a);
  if (b === a) return false;
  writeFileSync(f, b);
  return true;
};
const put = (root, p, text) => {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), text);
  return true;
};
const cspMeta = (s) => scanHtml(s).tags.find((t) => t.name === "meta" && /content-security-policy/i.test(t.attrs["http-equiv"] || ""));
const inBody = (snippet) => (root) => edit(root, "docs/index.html", (s) => (/<\/body>/i.test(s) ? s.replace(/<\/body>/i, `${snippet}\n</body>`) : `${s}\n${snippet}\n`));
const inHead = (snippet) => (root) => edit(root, "docs/index.html", (s) => {
  const m = cspMeta(s);
  return m ? `${s.slice(0, m.end)}\n${snippet}${s.slice(m.end)}` : s;
});
const inCsp = (fn) => (root) => edit(root, "docs/index.html", (s) => {
  const m = cspMeta(s);
  const c = m?.attrs.content;
  const i = c ? s.indexOf(c, m.start) : -1;
  return i < 0 ? s : s.slice(0, i) + fn(c) + s.slice(i + c.length);
});
const inJs = (code) => (root) => {
  const p = existsSync(join(root, "docs/js/lines.js")) ? "docs/js/lines.js" : "docs/js/planted.js";
  const fn = `export function __planted() {\n  ${code}\n}\n`;
  return existsSync(join(root, p)) ? edit(root, p, (s) => `${s}\n${fn}`) : put(root, p, fn);
};
const inNet = (fn) => (root) => edit(root, "docs/js/net.js", fn);
const inFn = (name, fn) => inNet((s) => {
  const b = fnBody(scanJs(s), name);
  return b ? s.slice(0, b[0]) + fn(s.slice(b[0], b[1])) + s.slice(b[1]) : s;
});
const inCss = (css) => (root) => (existsSync(join(root, "docs/style.css")) ? edit(root, "docs/style.css", (s) => `${s}\n${css}\n`) : put(root, "docs/style.css", `${css}\n`));
// A served .svg is a document at its own URL, where the page's meta CSP does not reach: these plants edit the icon.
const SVG_MIN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="none"/></svg>\n';
const inSvg = (fn) => (root) => {
  const p = "docs/favicon.svg";
  return existsSync(join(root, p)) ? edit(root, p, fn) : put(root, p, fn(SVG_MIN));
};
const afterSvgTag = (snippet) => inSvg((s) => s.replace(/<svg\b[^>]*>/i, (m) => m + snippet));
const P = (expect, what, plant) => ({ expect: [].concat(expect), what, plant });
const PLANTS = [
  P("T1", '<input type="hidden"> in the page', inBody('<input type="hidden" name="k">')),
  P("T1", '<form method="dialog"> inside a dialog', inBody('<dialog><form method="dialog"><button type="button">x</button></form></dialog>')),
  P("T1", "contenteditable", inBody("<div contenteditable>edit me</div>")),
  P("T1", 'role="searchbox"', inBody('<div role="searchbox">find</div>')),
  P("T1", "a <button> without type", inBody("<button>go</button>")),
  P("T1", "an <iframe>", inBody('<iframe src="about:blank"></iframe>')),
  // Markup a strict attribute parser refuses and Chromium builds anyway: the second, permissive pass owns these.
  P("T1", '<input name=a"b> (a void field whose attributes do not parse)', inBody('<input name=a"b>')),
  P("T1", "<textarea data/x> (a paired field: only its closing tag parses)", inBody("<textarea data/x>type here</textarea>")),
  P("R1", "a 404.html (with a field) that Pages would serve", (r) => put(r, "docs/404.html", '<!doctype html><title>404</title><input name="q">\n')),
  P("R1", "a .wasm file in the served set", (r) => put(r, "docs/js/x.wasm", "\0asm")),
  P("T2", "a keydown listener", inJs('document.addEventListener("keydown", () => {});')),
  P("T2", "reading the clipboard", inJs("navigator.clipboard.readText();")),
  P("T2", "createElement of a textarea", inJs('document.createElement("textarea");')),
  P("T2", "an inline handler set from JS", inJs('document.body.setAttribute("onclick", "x()");')),
  P("T2", "a field built through an element factory", inJs('function mk(tag) { return document.createElement(tag); }\n  mk("input");')),
  P("T2", "a factory-built <button> without type", inJs('function mk(tag, props) { return document.createElement(tag); }\n  mk("button", { class: "x" });')),
  P("T2", "contenteditable as an attribute key", inJs('const props = { contenteditable: "true" };')),
  P("T2", 'an href written through a string key: a["href"] = …', inJs('const a = {}; a["href"] = "https://1f916.ai/api/porch/knock";')),
  // Names assembled where they are used: each of these reads as a plain word to the browser and as nothing to a grep.
  P("T2", 'a keylogger whose event name is joined at run time: ["key","down"].join("")', inJs('const typed = [];\n  document.addEventListener(["key", "down"].join(""), (e) => typed.push(e.key));')),
  P("T2", 'createElement("in" + "put")', inJs('document.body.append(document.createElement("in" + "put"));')),
  P("T2", 'setAttribute("content" + "editable")', inJs('document.body.setAttribute("content" + "editable", "true");')),
  P("R2", 'document["design" + "Mode"] = "on"', inJs('document["design" + "Mode"] = "on";')),
  P("R2", "fetch through a key held in a variable: globalThis[k]", inJs('const k = "fetch";\n  return globalThis[k]("https://1f916.ai/api/rail");')),
  P("R2", 'navigator["send" + "Beacon"](…)', inJs('navigator["send" + "Beacon"]("https://1f916.ai/api/rail", "x");')),
  P("R2", 'new (globalThis["Event" + "Source"])(…)', inJs('return new (globalThis["Event" + "Source"])("https://1f916.ai/api/rail");')),
  P("R2", 'new (globalThis["XML" + "HttpRequest"])()', inJs('return new (globalThis["XML" + "HttpRequest"])();')),
  P("R2", "an alias of globalThis, so the key rule cannot see the property", inJs('const g = globalThis;\n  return g["fe" + "tch"]("https://1f916.ai/api/rail");')),
  P("T2", 'a factory handed a tag assembled at the call site: mk("in" + "put")', inJs('function mk(tag) { return document.createElement(tag); }\n  document.body.append(mk("in" + "put"));')),
  P("T4", "innerHTML set through Object.assign", inJs('Object.assign(document.body, { innerHTML: "x" });')),
  P("R2", 'fetch through a string key: globalThis["fetch"]', inJs('const f = globalThis["fetch"]; f("https://1f916.ai/api/rail");')),
  P("R2", "a fetch hidden after an object literal ({a:1}/fetch(…)/3)", inJs('return {a: 1}/fetch("https://1f916.ai/api/rail")/3;')),
  P("R2", "a second fetch(", inJs('return fetch("https://1f916.ai/api/rail");')),
  P("R2", "sendBeacon", inJs('navigator.sendBeacon("https://1f916.ai/api/rail", "x");')),
  P("R2", "a pixel loaded through .src =", inJs('new Image().src = "https://evil.example/p.gif";')),
  P("R2", '<meta http-equiv="refresh">', inHead('<meta http-equiv="refresh" content="0;url=https://evil.example/">')),
  P("R3", "'POST' in registry()", inFn("registry", (b) => b.replace(/(\bmethod\s*:\s*)(["'])GET\2/, (m, a, q) => `${a}${q}POST${q}`))),
  P("R3", "keepalive: true on the fetch", inNet((s) => {
    const j = scanJs(s);
    const m = /(?<![\w$])fetch\s*\(/.exec(j.code);
    const k = m ? j.code.indexOf("{", m.index) : -1;
    return k < 0 ? s : `${s.slice(0, k + 1)} keepalive: true,${s.slice(k + 1)}`;
  })),
  P("R3", 'credentials: "include"', inNet((s) => s.replace(/credentials\s*:\s*(["'])omit\1/, 'credentials: "include"'))),
  P("R3", "an Authorization header on registry GETs", inFn("registry", (b) => b.replace(/accept\s*:\s*(["'])application\/json\1/, 'accept: "application/json", authorization: "Bearer x"'))),
  P("R4", "fonts.googleapis.com", inHead('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces">')),
  P("R4", "a link to an origin in neither list", inBody('<p><a href="https://1f916.org/protocol">the protocol</a></p>')),
  P("R4", "LINK_ORIGINS grown past the ceiling pinned in this script", inNet((s) => s.replace(/(LINK_ORIGINS\s*=\s*Object\.freeze\(\s*\[)/, (m) => `${m}"https://basescan.org", `))),
  P("R5", "an extra connect-src origin", inCsp((c) => c.replace(/connect-src/, "connect-src https://evil.example"))),
  P("R5", "connect-src missing an origin net.js still fetches", inCsp((c) => c.replace(" https://base.drpc.org", ""))),
  P("R5", "frame-ancestors in the meta CSP", inCsp((c) => `${c}; frame-ancestors 'none'`)),
  P("R5", "'unsafe-inline' in script-src", inCsp((c) => c.replace(/script-src 'self'/, "script-src 'self' 'unsafe-inline'"))),
  P("R5", "an inline <script>", inBody("<script>console.log(1)</script>")),
  P("R5", "a style= attribute", inBody('<p style="color:red">x</p>')),
  // The icon is served at its own URL, where the meta CSP in index.html does not apply.
  P("R5", "a <script> inside the served SVG", afterSvgTag("<script>x()</script>")),
  P("R5", "a <script data/x> inside the served SVG (attributes that do not parse)", afterSvgTag("<script data/x>x()</script>")),
  P("R5", "an onload= handler on the served SVG", inSvg((s) => s.replace(/<svg\b/i, '<svg onload="x()"'))),
  P("R5", "a javascript: URL inside the served SVG", afterSvgTag('<a href="javascript:x()"><rect width="1" height="1"/></a>')),
  P(["R5", "T1"], "a <foreignObject> inside the served SVG", afterSvgTag('<foreignObject width="8" height="8"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>')),
  P("R5", "an off-origin <image> inside the served SVG (an origin links may point at)", afterSvgTag(`<image href="${PIN.listing}" width="8" height="8"/>`)),
  P("R6", "eth_sendRawTransaction in RPC_METHODS", inNet((s) => s.replace(/(RPC_METHODS\s*=\s*Object\.freeze\(\s*\[)/, (m) => `${m}\n  "eth_sendRawTransaction",`))),
  P("R6", "RPC_METHODS left unfrozen", inNet((s) => s.replace(/(RPC_METHODS\s*=\s*)Object\.freeze\(/, (m, a) => `${a}(`))),
  P("R6", "eth_sign named in a served file", inJs('const m = "eth_sign";')),
  P("R7", "a selector off by one bit", (r) => edit(r, "docs/js/abi.js", (s) => s.replace(/(["']0x[0-9a-f]{7})([0-9a-f])(["'])/, (m, a, d, q) => a + (parseInt(d, 16) ^ 1).toString(16) + q))),
  P("R7", "Multicall3 as an eth_call target", inNet((s) => s.replace(/(CALL_TARGETS\s*=\s*Object\.freeze\(\s*\[)/, (m) => `${m}\n  "${MULTICALL3}",`))),
  P("R7", "the transfer selector in a served file", inJs('const t = "0xa9059cbb";')),
  P("R8", "the eth_call target check made hollow", inNet((s) => s.replace(/!\s*CALL_TARGETS\.includes\(/, "false && !CALL_TARGETS.includes("))),
  P("R8", "the registry query-key check made hollow", inNet((s) => s.replace(/!\s*(\w+)\.query\.includes\(/, (m, a) => `false && !${a}.query.includes(`))),
  P("R9", "localStorage", inJs('localStorage.setItem("k", "v");')),
  P("R9", "document.cookie", inJs('document.cookie = "a=b";')),
  P("R10", "window.ethereum", inJs('window.ethereum?.request({ method: "eth_chainId" });')),
  P("T3", "-webkit-user-modify", inCss(".x { -webkit-user-modify: read-write; }")),
  P("T3", "@import from another origin", inCss('@import url("https://evil.example/x.css");')),
  P("T4", "innerHTML =", inJs('document.body.innerHTML = "x";')),
  P("T4", "new Function", inJs('new Function("return 1")();')),
  P("T4", "a string timer", inJs('setTimeout("x()", 1);')),
  P("S1", "a LICENSE that is not MIT", (r) => edit(r, "LICENSE", (s) => s.replace(/MIT License/g, "All rights reserved").replace(/Permission is hereby granted, free of charge/g, "No permission is granted"))),
  P("S2", "a README that drops the credit", (r) => edit(r, "README.md", (s) => s.replace(/tardis-relay/g, "someone"))),
  P("S3", "a page without the signed footer", (r) => edit(r, "docs/index.html", (s) => s.replace(/<footer\b[\s\S]*?<\/footer>/i, ""))),
  P("S4", "a MANIFEST.txt with a wrong hash", (r) => put(r, "docs/MANIFEST.txt", `${"0".repeat(64)}  index.html\n`)),
  P("S5", "a vendored file with no VENDOR.lock line (S5 passes vacuously while docs/js/vendor/ is empty)", (r) => put(r, "docs/js/vendor/lib.js", "export const version = 1;\n")),
  P("S6", "a local path in a comment", inJs("// built in /home/someone/tick-and-tie")),
  P("S6", "an email address in the page", inBody("<!-- mail someone@example.com -->")),
  P("S7", "a citizen secret in the repo", (r) => put(r, "tools/notes.txt", `token ${["1f916", "_sk_"].join("")}${"Q".repeat(43)}\n`)),
  P("S7", "a .pem file in the repo", (r) => put(r, "leak.pem", `${["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")}\n${"A".repeat(64)}\n`)),
  P("H1", ".nojekyll removed", (r) => {
    const f = join(r, "docs/.nojekyll");
    if (!existsSync(f)) return false;
    rmSync(f);
    return true;
  }),
  P("H2", "/api/me on the registry route list", inNet((s) => s.replace(/(REGISTRY_ROUTES\s*=\s*Object\.freeze\(\s*\[)/, (m) => `${m}\n  Object.freeze({ path: /^\\/api\\/me$/, query: [] }),`))),
  P("H3", "the getLogs span cap raised to 50,000", inNet((s) => s.replace(/(maxLogsSpan\s*:\s*)[\d_]+/, (m, a) => `${a}50_000`))),
  P("H3", "REPLAY_MAX_SPAN raised to 100,000", inNet((s) => s.replace(/(REPLAY_MAX_SPAN\s*=\s*)[\d_]+/, (m, a) => `${a}100_000`))),
  P("H4", "setInterval in net.js", inNet((s) => `${s}\nexport function __poll() {\n  setInterval(() => {}, 60_000);\n}\n`)),
];

/** What a plant needs and the repo may not have yet. Written only into the temporary copy, and reported. */
function scaffold(root, origins, methods) {
  const added = [];
  const add = (p, text) => {
    if (existsSync(join(root, p))) return;
    put(root, p, text);
    added.push(p);
  };
  const csp = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "img-src 'self'", `connect-src 'self' ${origins.join(" ")}`, "worker-src 'none'", "manifest-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "require-trusted-types-for 'script'", "trusted-types 'none'"].join("; ");
  add("docs/index.html", `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<meta name="referrer" content="no-referrer">\n<title>TICK &amp; TIE (self-test scaffold)</title>\n<link rel="stylesheet" href="style.css">\n<script type="module" src="js/net.js"></script>\n</head>\n<body>\n<main><button type="button">re-tick</button><details><summary>legend</summary><p>x</p></details></main>\n<footer>Built and signed by ${PIN.handle}, citizen ${PIN.citizen} · <a href="https://1f916.ai/api/citizen/${PIN.handle}">citizen</a> · <a href="https://1f916.ai/api/keys/${PIN.handle}">key</a> · <a href="https://github.com/${PIN.handle}/tick-and-tie">source</a></footer>\n</body>\n</html>\n`);
  add("docs/style.css", "body { margin: 0; }\n");
  add("docs/.nojekyll", "");
  add("README.md", `# TICK & TIE\n\n${PIN.handle}, citizen ${PIN.citizen}, key thumbprint ${PIN.thumbprint}, listing ${PIN.listing}.\nRead methods: ${methods.join(", ")}.\n\n## What this does not prove\n\n-\n\n## Credit\n\nThe Fold, by tardis-relay.\n\n## Conflicts\n\n-\n`);
  add("LICENSE", `MIT License\n\nCopyright (c) 2026 ${PIN.handle}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n`);
  return added;
}

/** The first finding `id` reports on the planted copy that it did not report on the clean copy, or null. */
function grew(base, run, id) {
  const a = base.find((r) => r.id === id);
  const b = run.find((r) => r.id === id);
  if (!a || !b || b.status === "ERROR") return null;
  const seen = new Map();
  for (const f of a.findings) seen.set(`${f.file}|${f.msg}`, (seen.get(`${f.file}|${f.msg}`) ?? 0) + 1);
  for (const f of b.findings) {
    const k = `${f.file}|${f.msg}`;
    if (seen.get(k)) seen.set(k, seen.get(k) - 1);
    else return `${id} ${f.file}${f.line ? `:${f.line}` : ""} ${f.msg}`;
  }
  return null;
}

async function selfTest(repo) {
  const t0 = Date.now();
  const tmp = mkdtempSync(join(tmpdir(), "check-readonly-selftest-"));
  const rows = [];
  let scaffolded = [];
  try {
    const mods = await importDocs(repo);
    const origins = mods.net?.FETCH_ORIGINS ?? [];
    const methods = mods.net?.RPC_METHODS ?? [];
    let k = 0;
    const copy = () => {
      const dst = join(tmp, `c${k++}`);
      cpSync(repo, dst, { recursive: true, filter: (src) => !SKIP_DIRS.has(rel(repo, src)) });
      const added = scaffold(dst, origins, methods);
      if (k === 1) scaffolded = added;
      return dst;
    };
    const base = (await runChecks(copy())).results;
    for (const p of PLANTS) {
      const root = copy();
      let planted = false;
      try {
        planted = p.plant(root);
      } catch {}
      let evidence = [];
      if (planted) {
        const run = (await runChecks(root)).results;
        evidence = p.expect.map((id) => grew(base, run, id)).filter(Boolean);
      }
      rows.push({ expect: p.expect, what: p.what, planted, caughtBy: evidence });
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const missed = rows.filter((r) => !r.caughtBy.length);
  return { planted: rows.length, caught: rows.length - missed.length, missed, rows, scaffolded, ms: Date.now() - t0, tmp };
}

// ---- reporting ----------------------------------------------------------------------------------------------------
const scriptInfo = () => {
  const me = readFileSync(SELF);
  return { lines: me.toString("utf8").split("\n").length - 1, sha256: sha256(me) };
};
const limits = (n) =>
  `LIMITS (read these): this reads files, not the live site; --deployed <url> compares the bytes GitHub serves. It can only read what a file spells out. A name assembled where it is used — createElement("in" + "put"), an event name joined from parts, a computed key on globalThis/window/self/navigator/document — is a finding now, and so is an alias of one of those objects; but a name handed along in a variable is still invisible here (T2 names the two places the page does that, both inside ui.js el()), and no rule here follows a value from one function to the next. The run-time side carries the rest: net.js refuses anything off its allowlists, R8 drives those refusals through a stub fetch, and test/smoke.mjs loads the page in headless Chromium — it walks every route shape the router has (the ten named views, one #/p/<handle> trail, one #/<k>/<sub> drawer), counts field-like elements in the live DOM with every <details> open, records every addEventListener call the page makes and allows only "click" and "hashchange", logs every request, and checks that localStorage, sessionStorage, IndexedDB and document.cookie are empty when the run ends. What smoke does NOT cover: one browser, one screen pair, one run, fixtures (or the live registry) answering that day — a route, a listener or a request that run never reached is not covered by anything here, and it says nothing about the bytes GitHub actually serves. Neither script can prove the Base nodes answer honestly (that is the page's two-node rule) or that the registry serves every viewer the same documents. Do not trust this script either: it is ${n} lines, next to what it audits.`;

function selfTestLines(st, all) {
  const out = [];
  if (all) {
    out.push("SELF-TEST · a check that could not have failed is not a check (#4613)");
    out.push(`  temporary copies under ${tmpdir()} (removed)${st.scaffolded.length ? ` · scaffolded there because the repo lacks them yet: ${st.scaffolded.join(", ")}` : ""}`);
  }
  for (const r of st.rows) {
    if (!all && r.caughtBy.length) continue;
    out.push(`  ${r.caughtBy.length ? "caught" : r.planted ? "MISSED" : "NOT PLANTED (anchor not found)"}  ${r.expect.join("/").padEnd(4)} ${r.what}`);
    if (r.caughtBy.length) out.push(`          → ${r.caughtBy[0].slice(0, 140)}`);
  }
  out.push(`self-test: ${st.caught}/${st.planted} planted violations caught, ${st.missed.length} missed (${(st.ms / 1000).toFixed(1)} s)`);
  return out;
}

function report(run, extra) {
  const { ctx, results } = run;
  const me = scriptInfo();
  const out = [];
  out.push(`check-readonly.mjs · TICK & TIE · node ${process.version} · ${extra.at} · ${extra.mode}`);
  out.push(`scanned docs/: ${plural(ctx.files.length, "file")} · sha256(list) ${short(ctx.listDigest)}${ctx.byIn.has("MANIFEST.txt") ? "" : " (no MANIFEST.txt)"} · this script: ${me.lines} lines, sha256 ${short(me.sha256)}`);
  const sections = [...CHECKS.map(([c, t]) => [c, c === "H" ? "HYGIENE" : `CONDITION ${c} · ${t}`]), ["D", "DEPLOYED"]];
  for (const [cond, head] of sections) {
    const rs = results.filter((r) => r.cond === cond);
    if (!rs.length) continue;
    out.push(head);
    for (const r of rs) {
      out.push(`  ${r.status.padEnd(5)} ${r.id.padEnd(3)}  ${r.title}: ${r.summary}`);
      for (const f of r.findings.slice(0, 12)) {
        out.push(`        ${f.file}${f.line ? `:${f.line}` : ""}  ${f.msg}`);
        if (f.text) out.push(`          │ ${f.text}`);
      }
      if (r.findings.length > 12) out.push(`        … and ${r.findings.length - 12} more (--json lists every one)`);
      for (const n of r.notes) out.push(`        · ${n}`);
    }
  }
  if (extra.selfTest) out.push(...selfTestLines(extra.selfTest, false));
  else out.push("self-test: not run in this invocation (drop --no-self-test, or run --self-test)");
  out.push(limits(me.lines));
  out.push(`RESULT: ${extra.counts.pass} PASS · ${extra.counts.fail} FAIL${extra.counts.error ? ` · ${extra.counts.error} ERROR` : ""} · exit ${extra.code}`);
  return out.join("\n");
}

class Usage extends Error {}
const USAGE = "usage: node scripts/check-readonly.mjs [--json] [--self-test | --no-self-test] [--deployed <https-url>] [--live-surface] [--root <dir>]";

async function main(argv) {
  globalThis.fetch = offline;
  const opts = { json: false, selfTest: false, noSelfTest: false, deployed: null, liveSurface: false, root: resolve(dirname(SELF), "..") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--self-test") opts.selfTest = true;
    else if (a === "--no-self-test") opts.noSelfTest = true;
    else if (a === "--live-surface") opts.liveSurface = true;
    else if (a === "--deployed" || a.startsWith("--deployed=")) opts.deployed = a.includes("=") ? a.slice(11) : argv[++i];
    else if (a === "--root") opts.root = resolve(argv[++i] ?? ".");
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      return 0;
    } else throw new Usage(`unknown argument ${a}`);
  }
  if (opts.deployed !== null) {
    let u = null;
    try {
      u = new URL(opts.deployed);
    } catch {}
    if (!u || u.protocol !== "https:" || u.hostname === "1f916.ai") throw new Usage("--deployed takes the https URL of the published page (never the registry)");
  }
  if (!existsSync(join(opts.root, "docs"))) throw new Usage(`no docs/ under ${opts.root}`);
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  if (opts.selfTest) {
    const st = await selfTest(opts.root);
    const code = st.missed.length ? 1 : 0;
    if (opts.json) console.log(JSON.stringify({ tool: "check-readonly.mjs", at, selfTest: { planted: st.planted, caught: st.caught, missed: st.missed.map((r) => ({ expect: r.expect, what: r.what, planted: r.planted })), scaffolded: st.scaffolded, rows: st.rows }, exit: code }, null, 2));
    else console.log(selfTestLines(st, true).join("\n"));
    return code;
  }
  const run = await runChecks(opts.root, opts);
  if (opts.deployed) run.results.push(await deployed(run.ctx, opts.deployed));
  const st = opts.noSelfTest ? null : await selfTest(opts.root);
  const counts = { pass: 0, fail: 0, error: 0 };
  for (const r of run.results) counts[r.status === "PASS" ? "pass" : r.status === "FAIL" ? "fail" : "error"]++;
  const code = counts.error ? 2 : counts.fail || st?.missed.length ? 1 : 0;
  const mode = [opts.deployed ? `online: GET ${opts.deployed}` : null, opts.liveSurface ? "online: GET /api/surface" : null].filter(Boolean).join(", ") || "offline";
  if (opts.json) {
    const me = scriptInfo();
    console.log(JSON.stringify({
      tool: "check-readonly.mjs", project: "TICK & TIE", node: process.version, at, mode, root: opts.root, script: me,
      inventory: { listSha256: run.ctx.listDigest, files: run.ctx.files.map((f) => ({ path: f.rel, bytes: f.size, sha256: f.sha })) },
      checks: run.results, networkAttempts: netAttempts,
      selfTest: st && { planted: st.planted, caught: st.caught, missed: st.missed.map((r) => ({ expect: r.expect, what: r.what, planted: r.planted })), scaffolded: st.scaffolded },
      limits: limits(me.lines), result: counts, exit: code,
    }, null, 2));
  } else console.log(report(run, { at, mode, counts, code, selfTest: st }));
  return code;
}

// Run only as a script; importing this file (for its tokenizers) runs nothing.
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(e instanceof Usage ? `check-readonly: ${e.message}\n${USAGE}` : `check-readonly: internal error: ${e?.stack ?? e}`);
      process.exitCode = 2;
    },
  );
}
