// Parsing and formatting for money, addresses, time and untrusted text. Every function is pure.
//
// The traps this file exists for are the ones this society has already fallen into:
//   - decimals: USDC has 6, 1F916 has 18, a factor of a trillion apart. Listing 22 was withdrawn after its thread
//     priced it at a trillion times its value (c36998). Decimals here come only from our own table.
//   - seconds vs milliseconds: binding `expiry` is unix seconds; `now` and `created_at` are milliseconds. The one
//     Class-A finding on listing 20 was exactly this (c36998).
//   - amounts past 2^53: 30,000,000 1F916 is 3e25 atomic units, so every amount is a BigInt, parsed strictly.
//   - never summing across assets: the rail itself serves such totals as null.
import { keccakHex } from "./keccak.js";

// ---- assets (the only source of decimals on this page) -----------------------------------------------------

export const ASSETS = Object.freeze({
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": Object.freeze({ symbol: "USDC", decimals: 6, shown: 6 }),
  "0x9e00fc92493451eba1c63dd3880d68b622037ba3": Object.freeze({ symbol: "1F916", decimals: 18, shown: 6 }),
  "0x4200000000000000000000000000000000000006": Object.freeze({ symbol: "WETH", decimals: 18, shown: 6 }),
});
export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const TOKEN = "0x9e00fc92493451eba1c63dd3880d68b622037ba3";
export const WETH = "0x4200000000000000000000000000000000000006";
export const CHAIN_ID = 8453;

// ---- strict numbers ----------------------------------------------------------------------------------------

/** A decimal integer string from the registry ("30000000000000000000000000") → BigInt, or null. */
export function parseAtomic(v) {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v !== "string" || !/^[0-9]{1,78}$/.test(v)) return null;
  return BigInt(v);
}

/** A JSON-RPC quantity ("0x1a") → BigInt, or null. */
export function parseQuantity(v) {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) return null;
  return BigInt(v);
}

/**
 * A 32-byte eth_call result → BigInt, or null. "0x" is what a throttled node or a call to a non-contract returns:
 * it is "not read", never zero: a throttled node answers "0x" exactly as a call to a non-contract does, so a zero
 * here would invent a balance nobody read.
 */
export function parseWord(v) {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) return null;
  return BigInt(v);
}

// ---- units -------------------------------------------------------------------------------------------------

function group(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Atomic → human with a fixed number of decimals shown, thousands grouped. Never Number(), never a price. */
export function formatUnits(atomic, decimals, shown = decimals) {
  if (typeof atomic !== "bigint") return null;
  const neg = atomic < 0n;
  const v = neg ? -atomic : atomic;
  const base = 10n ** BigInt(decimals);
  const whole = group((v / base).toString());
  const full = (v % base).toString().padStart(decimals, "0");
  let frac = full.slice(0, shown);
  if (/[1-9]/.test(full.slice(shown))) frac += "…"; // digits were dropped: say so, never round silently
  return `${neg ? "-" : ""}${whole}${shown > 0 ? "." + frac : ""}`;
}

/** Drop trailing zeros from the fraction, keeping at least `minFrac` digits. A truncated figure ("…") is left alone. */
function trimFrac(s, minFrac) {
  const m = /^(-?[\d,]+)(?:\.(\d*))?$/.exec(s);
  if (!m) return s;
  const frac = (m[2] ?? "").replace(/0+$/, "").padEnd(minFrac, "0");
  return frac ? `${m[1]}.${frac}` : m[1];
}

/** "0.10 USDC", "28,810.931619 USDC" or "30,000,000 1F916". Exact to the digits shown; unknown assets are not formatted. */
export function formatAsset(atomic, tokenAddress) {
  const a = ASSETS[lc(tokenAddress)];
  if (!a || typeof atomic !== "bigint") return null;
  return `${trimFrac(formatUnits(atomic, a.decimals, a.shown), a.symbol === "USDC" ? 2 : 0)} ${a.symbol}`;
}

export const assetOf = (tokenAddress) => ASSETS[lc(tokenAddress)] ?? null;

/** Ledger cents → USDC atomic units (×10⁴), sign-safe. "The books round to cents." */
export function centsToUsdcAtomic(cents) {
  if (!Number.isSafeInteger(cents)) return null;
  return BigInt(cents) * 10000n;
}

// ---- addresses ---------------------------------------------------------------------------------------------

export const lc = (s) => String(s ?? "").toLowerCase();
export const isAddress = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
export const isTxHash = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);

/** EIP-55 mixed-case checksum of an address. */
export function checksum(addr) {
  if (!isAddress(addr)) return null;
  const a = lc(addr).slice(2);
  const h = keccakHex(a);
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}

/** A mixed-case address whose case does not match its EIP-55 checksum. All-lower/all-upper carries no checksum. */
export function badChecksum(addr) {
  if (!isAddress(addr)) return false;
  const body = addr.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return false;
  return checksum(addr) !== addr;
}

export const short = (addr) => (isAddress(addr) ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : String(addr));

/** A 32-byte topic holding an address → the address. */
export function topicToAddress(topic) {
  if (typeof topic !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(topic)) return null;
  return "0x" + lc(topic.slice(26));
}
export const addressToTopic = (addr) => "0x" + "0".repeat(24) + lc(addr).slice(2);

/**
 * How much of address `a` a lookalike `b` copies: leading and trailing hex characters in common. Address
 * poisoning copies the first few and last four characters a wallet shows, and nothing else (c47657).
 */
export function overlap(a, b) {
  const x = lc(a).slice(2);
  const y = lc(b).slice(2);
  let prefix = 0;
  while (prefix < 40 && x[prefix] === y[prefix]) prefix++;
  let suffix = 0;
  while (suffix < 40 && x[39 - suffix] === y[39 - suffix]) suffix++;
  return { prefix, suffix };
}
export function isLookalike(a, b) {
  if (!isAddress(a) || !isAddress(b) || lc(a) === lc(b)) return false;
  const { prefix, suffix } = overlap(a, b);
  return prefix >= 3 && suffix >= 4 && prefix + suffix < 40;
}

// ---- ERC-20 Transfer ---------------------------------------------------------------------------------------

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * A receipt log → {token, from, to, value, logIndex}, or null if it is not a well-formed ERC-20 Transfer. ERC-721
 * Transfers carry the same topic0 with 4 topics; they are refused here, as are removed logs.
 */
export function decodeTransfer(log) {
  if (!log || log.removed === true) return null;
  if (!Array.isArray(log.topics) || log.topics.length !== 3 || lc(log.topics[0]) !== TRANSFER_TOPIC) return null;
  const from = topicToAddress(log.topics[1]);
  const to = topicToAddress(log.topics[2]);
  const value = parseWord(log.data);
  const logIndex = parseQuantity(log.logIndex);
  if (!from || !to || value === null || logIndex === null || !isAddress(log.address)) return null;
  return { token: lc(log.address), from, to, value, logIndex: Number(logIndex) };
}

// ---- time --------------------------------------------------------------------------------------------------

// Typed clocks. The registry serves unix seconds for `expiry` and milliseconds for `created_at`/`now`; a value
// in the wrong unit is refused, not guessed at.
export function fromSec(s) {
  return Number.isSafeInteger(s) && s > 1e9 && s < 1e11 ? new Date(s * 1000) : null;
}
export function fromMs(ms) {
  return Number.isSafeInteger(ms) && ms >= 1e11 && ms < 1e14 ? new Date(ms) : null;
}
export const isoMin = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 16).replace("T", " ") + "Z" : "—");
export const isoSec = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 19).replace("T", " ") + "Z" : "—");

export function span(ms) {
  const s = Math.abs(ms) / 1000;
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

export const groupInt = (n) => group(String(n));

/** "1 payment" / "3 payments". */
export const plural = (n, word, many = word + "s") => `${groupInt(n)} ${n === 1 ? word : many}`;

/** Integer ids as runs: [9, 11, 14, 15, 16, 17, 18] → "9, 11, 14–18". */
export function ranges(ids) {
  const sorted = [...new Set(ids.map(Number))].filter(Number.isInteger).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(j - i >= 2 ? `${sorted[i]}–${sorted[j]}` : j > i ? `${sorted[i]}, ${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return out.join(", ");
}

// ---- untrusted text ----------------------------------------------------------------------------------------

// Characters that change how text reads without being visible: format controls (bidi overrides, zero-width),
// other controls, private use, unassigned, line/paragraph separators, and every default-ignorable code point.
// A counterfeit "USDC" around a funder wallet today is U + U+10BD + D + U+202C + C (design research).
const HIDDEN = /[\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u00A0\u2000-\u200A\u202F\u205F\u3000]/u;

const NAMES = {
  0x00a0: "NO-BREAK SPACE", 0x200b: "ZERO WIDTH SPACE", 0x200c: "ZERO WIDTH NON-JOINER", 0x200d: "ZERO WIDTH JOINER",
  0x200e: "LEFT-TO-RIGHT MARK", 0x200f: "RIGHT-TO-LEFT MARK", 0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING", 0x202c: "POP DIRECTIONAL FORMATTING", 0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE", 0x2060: "WORD JOINER", 0x2066: "LEFT-TO-RIGHT ISOLATE", 0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE", 0x2069: "POP DIRECTIONAL ISOLATE", 0xfeff: "ZERO WIDTH NO-BREAK SPACE",
  0x061c: "ARABIC LETTER MARK", 0x00ad: "SOFT HYPHEN", 0x10bd: "GEORGIAN CAPITAL LETTER CHAR",
  0x0421: "CYRILLIC CAPITAL LETTER ES", 0x0441: "CYRILLIC SMALL LETTER ES", 0x0405: "CYRILLIC CAPITAL LETTER DZE",
  0x0415: "CYRILLIC CAPITAL LETTER IE", 0x0422: "CYRILLIC CAPITAL LETTER TE", 0x041d: "CYRILLIC CAPITAL LETTER EN",
  0x0395: "GREEK CAPITAL LETTER EPSILON", 0x03a4: "GREEK CAPITAL LETTER TAU", 0x0397: "GREEK CAPITAL LETTER ETA",
  0x00da: "LATIN CAPITAL LETTER U WITH ACUTE", 0x00d9: "LATIN CAPITAL LETTER U WITH GRAVE", 0x00db: "LATIN CAPITAL LETTER U WITH CIRCUMFLEX",
  0x00dc: "LATIN CAPITAL LETTER U WITH DIAERESIS", 0x0020: "SPACE", 0x0410: "CYRILLIC CAPITAL LETTER A", 0x0412: "CYRILLIC CAPITAL LETTER VE",
  0x0406: "CYRILLIC CAPITAL LETTER BYELORUSSIAN-UKRAINIAN I", 0x0399: "GREEK CAPITAL LETTER IOTA", 0x0392: "GREEK CAPITAL LETTER BETA",
  0x13a0: "CHEROKEE LETTER A", 0x13da: "CHEROKEE LETTER S", 0x216d: "ROMAN NUMERAL ONE HUNDRED", 0xff35: "FULLWIDTH LATIN CAPITAL LETTER U",
};

export const codepointLabel = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}${NAMES[cp] ? " " + NAMES[cp] : ""}`;

/**
 * Split untrusted text into plain runs and visible tokens for hidden characters. Rendering is done by the UI with
 * textContent only; this never produces markup. Tabs and newlines pass through; long runs of combining marks
 * collapse to one token.
 */
export function reveal(str, max = 400, { strict = false } = {}) {
  // strict (token symbols): every character outside printable ASCII becomes a visible token, because in a symbol
  // a Cyrillic С or an accented Ú is the forgery itself, not decoration.
  const s = String(str ?? "");
  const out = [];
  let buf = "";
  let marks = 0;
  let count = 0;
  for (const ch of s) {
    if (++count > max) {
      if (buf) out.push({ text: buf });
      out.push({ note: `… truncated, ${[...s].length - max} more characters` });
      return out;
    }
    const cp = ch.codePointAt(0);
    if (/\p{M}/u.test(ch)) {
      if (++marks > 2) continue;
    } else marks = 0;
    if ((ch !== "\t" && ch !== "\n" && HIDDEN.test(ch)) || (strict && !/^[\x21-\x7e]$/.test(ch))) {
      if (buf) out.push({ text: buf });
      buf = "";
      out.push({ hidden: codepointLabel(cp) });
    } else buf += ch;
  }
  if (buf) out.push({ text: buf });
  return out;
}

export const hasHidden = (str) => [...String(str ?? "")].some((ch) => ch !== "\t" && ch !== "\n" && HIDDEN.test(ch));

// Confusables for the letters of the three canonical symbols (USDC, 1F916, WETH). A subset of Unicode TR39,
// enough for what poisoners use: Cyrillic, Greek and Georgian lookalikes, plus full-width forms via NFKC.
const CONFUSABLE = {
  "С": "C", "с": "C", "Ϲ": "C", "ϲ": "C", "Ⅽ": "C", "ⅽ": "C",
  "Ѕ": "S", "ѕ": "S", "Ⴝ": "S",
  "Ե": "U", "Ս": "U", "ս": "U", "∪": "U", "⋃": "U",
  "Ꭰ": "D", "Ⅾ": "D", "ⅾ": "D",
  "Е": "E", "е": "E", "Ε": "E", "Ꭼ": "E",
  "Т": "T", "т": "T", "Τ": "T", "Ꭲ": "T",
  "Н": "H", "н": "H", "Η": "H", "Ꮋ": "H",
  "Ԝ": "W", "ԝ": "W", "Ꮃ": "W",
  "Ϝ": "F", "ϝ": "F",
  "l": "1", "I": "1", "|": "1", "Ⅰ": "1", "ı": "1",
  "б": "6", "Ꮾ": "6",
  "ɡ": "9", "Ꝯ": "9",
};

/** Fold a token symbol to what a hurried reader would see: NFKC, hidden characters dropped, lookalikes mapped. */
export function foldSymbol(sym) {
  // Decompose first so accents come off ("ÚSDС" → "USDС"), drop every combining mark and hidden character, map
  // the lookalike letters, then recompose full-width forms.
  let s = String(sym ?? "").normalize("NFKD").replace(/\p{M}/gu, "");
  s = [...s].filter((ch) => !HIDDEN.test(ch)).map((ch) => CONFUSABLE[ch] ?? ch).join("");
  return s.normalize("NFKC").toUpperCase();
}

/** A token that is not ours but reads as one of ours. Canonical is decided by address only, never by name. */
export function counterfeitOf(tokenAddress, symbol) {
  if (ASSETS[lc(tokenAddress)]) return null;
  const folded = foldSymbol(symbol);
  for (const a of Object.values(ASSETS)) if (folded === a.symbol) return a.symbol;
  return null;
}

/** Defang a URL from citizen text so it stays inert: "https://evil.example/x" → "https[:]//evil[.]example/x". */
export const defang = (url) => String(url ?? "").replace(/:\/\//g, "[:]//").replace(/\./g, "[.]");

/**
 * A fetch failure in words a reader can act on. The registry's rate limit arrives as an opaque network error, not a
 * status: HTTP 429 without CORS headers, which the browser refuses to show the page. Anything else is passed
 * through as the door reported it. One copy, so every schedule names the same thing the same way.
 */
export const readError = (error) => (/^(Failed to fetch|fetch failed|TypeError|NetworkError|Load failed)/.test(String(error ?? "")) ? "no answer this browser may read; the registry's rate limit arrives that way, HTTP 429 without CORS headers" : String(error ?? "not read"));
