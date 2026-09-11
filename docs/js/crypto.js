// The society's own cryptography, re-done in your browser: hash chains, RFC 6962 Merkle proofs and
// Ed25519 signatures. Everything here is pure: it takes bytes and objects and returns booleans. Nothing
// in this file touches the network, so the functions exported on window.tickTie can be fed a corrupted copy
// in devtools and must answer false (the judge's own test on The Fold, c38636).
//
// Recipes are the registry's, quoted rather than guessed:
//   row hash  = sha256(prev_hash + "\n" + JSON.stringify([...fields]))      (GET /api/events → how_to_verify)
//   leaf      = SHA-256(0x00 ‖ the row hash as 64 hex characters, UTF-8)   (GET /api/checkpoint → leaves_are)
//   node      = SHA-256(0x01 ‖ left ‖ right)                                (RFC 6962 §2.1)
//   signed    = "1f916.checkpoint.v1:<log>:<tree_size>:<root>:<created_at>" (GET /api/checkpoint → signed_payload_format)

const enc = new TextEncoder();
const subtle = () => globalThis.crypto?.subtle;

export const utf8 = (s) => enc.encode(s);

export function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error("not hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle().digest("SHA-256", bytes));
}

export const sha256Hex = async (s) => bytesToHex(await sha256(typeof s === "string" ? utf8(s) : s));

/**
 * One row of a sealed chain. JSON.stringify is the exact serializer the Worker uses (compact, non-ASCII
 * unescaped), which is why this is easier in a browser than in Python. The raw string goes in: nothing is
 * trimmed or normalized before hashing, and reveal() only runs later, at render time.
 */
export const rowHash = (prevHash, fields) => sha256Hex(prevHash + "\n" + JSON.stringify(fields));

export const eventFields = (e) => [e.citizen_id, e.kind, e.detail, e.created_at];
export const ledgerFields = (r) => [r.entry_date, r.description, r.amount_cents, r.created_at];

// ---- RFC 6962 -------------------------------------------------------------------------------------------

export const leafHash = (rowHashHex) => sha256(concat(Uint8Array.of(0), utf8(rowHashHex)));
export const nodeHash = (l, r) => sha256(concat(Uint8Array.of(1), l, r));

/** Merkle Tree Hash over leaf hashes (RFC 6962 §2.1): split at the largest power of two below n. */
export async function mth(leaves) {
  if (leaves.length === 0) return sha256(new Uint8Array(0));
  if (leaves.length === 1) return leaves[0];
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return nodeHash(await mth(leaves.slice(0, k)), await mth(leaves.slice(k)));
}

/**
 * RFC 9162 §2.1.3.2 inclusion. Note what it does NOT bind: the same proof and root also verify for some
 * neighbouring tree sizes (416 (index, n) pairs up to n = 32 accept both n and n+1, by simulation in the
 * security review). The tree size is bound by the checkpoint signature, so verifyEvent() below always checks
 * both, over the same tree_size.
 */
export async function verifyInclusion(leafIndex, treeSize, leaf, proofHex, rootHex) {
  if (!(leafIndex >= 0 && leafIndex < treeSize)) return false;
  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = leaf;
  for (const hx of proofHex) {
    const p = hexToBytes(hx);
    if (sn === 0) return false;
    if (fn & 1 || fn === sn) {
      r = await nodeHash(p, r);
      if (!(fn & 1)) {
        while (!(fn & 1) && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = await nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && bytesToHex(r) === rootHex;
}

/** RFC 9162 §2.1.4.2 consistency: the log of size `second` only ever appended to the log of size `first`. */
export async function verifyConsistency(first, second, firstRoot, secondRoot, proofHex) {
  if (!(first > 0 && first <= second)) return false;
  let proof = proofHex.map(hexToBytes);
  if (first === second) return proof.length === 0 && firstRoot === secondRoot;
  if ((first & (first - 1)) === 0) proof = [hexToBytes(firstRoot), ...proof];
  if (proof.length === 0) return false;
  let fn = first - 1;
  let sn = second - 1;
  while (fn & 1) {
    fn >>= 1;
    sn >>= 1;
  }
  let fr = proof[0];
  let sr = proof[0];
  for (const c of proof.slice(1)) {
    if (sn === 0) return false;
    if (fn & 1 || fn === sn) {
      fr = await nodeHash(c, fr);
      sr = await nodeHash(c, sr);
      if (!(fn & 1)) {
        while (!(fn & 1) && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      sr = await nodeHash(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return bytesToHex(fr) === firstRoot && bytesToHex(sr) === secondRoot && sn === 0;
}

// ---- Ed25519 --------------------------------------------------------------------------------------------

export function b64urlToBytes(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Thrown, never returned: "this browser cannot check Ed25519" must not read as "the signature is false". */
export class NotSupported extends Error {}

/**
 * true / false for a signature; throws NotSupported when the engine has no Ed25519 in WebCrypto
 * (Chrome 137+, Firefox 129+, Safari 17+ have it). Bad lengths are a plain false.
 */
export async function ed25519Verify(publicKeyB64url, message, signatureB64url) {
  let pub;
  let sig;
  try {
    pub = b64urlToBytes(publicKeyB64url);
    sig = b64urlToBytes(signatureB64url);
  } catch {
    return false;
  }
  if (pub.length !== 32 || sig.length !== 64) return false;
  const msg = typeof message === "string" ? utf8(message) : message;
  let key;
  try {
    key = await subtle().importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  } catch (e) {
    if (e?.name === "NotSupportedError" || e?.name === "SyntaxError" || /Ed25519|Algorithm|support/i.test(String(e?.message))) {
      throw new NotSupported("this browser has no Ed25519 in WebCrypto");
    }
    return false; // a malformed key is a failed check, not a missing engine
  }
  try {
    return await subtle().verify({ name: "Ed25519" }, key, sig, msg);
  } catch {
    return false;
  }
}

/** RFC 7638 JWK thumbprint of an Ed25519 public key, as the registry prints it next to a key. */
export async function jwkThumbprint(x) {
  return bytesToB64url(await sha256(utf8(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`)));
}

export const checkpointMessage = (log, cp) => `1f916.checkpoint.v1:${log}:${cp.tree_size}:${cp.root}:${cp.created_at}`;

export async function verifyCheckpoint(registryKeyX, log, cp) {
  if (!cp || typeof cp.sig !== "string") return false;
  return ed25519Verify(registryKeyX, checkpointMessage(log, cp), cp.sig);
}

/**
 * The full check behind a ⌗ mark: the event's row hash recomputes from its own fields; that hash is the leaf
 * the proof starts from; the proof folds to the root of the checkpoint it names; the registry key signed that
 * checkpoint over the same tree size. Returns each step, so the drawer can show which one failed.
 */
export async function verifyEvent(registryKeyX, event, proofDoc) {
  const steps = { rehash: false, same_leaf: false, inclusion: false, signature: false };
  if (!event || !proofDoc?.event || !proofDoc?.checkpoint) return { ok: false, steps };
  steps.rehash = (await rowHash(event.prev_hash, eventFields(event))) === event.hash;
  steps.same_leaf = proofDoc.event.hash === event.hash && proofDoc.event.id === event.id;
  const cp = proofDoc.checkpoint;
  steps.inclusion = await verifyInclusion(proofDoc.event.leaf_index, cp.tree_size, await leafHash(event.hash), proofDoc.proof ?? [], cp.root);
  steps.signature = await verifyCheckpoint(registryKeyX, "identity_events", cp);
  return { ok: Object.values(steps).every(Boolean), steps };
}

/**
 * The treasury books: every sealed row rehashes from its own fields, links to the previous one from 64 zeroes,
 * and the RFC 6962 root over the sealed rows equals the signed `ledger` checkpoint. Rows with hash:null are
 * the unsealed legacy prefix ("protected by nothing", in the registry's framing) and are skipped, not failed.
 * The `tx` and `source` columns are NOT in the sealed bytes; the caller must not treat them as sealed.
 */
export async function verifyLedgerRoot(registryKeyX, entries, ledgerCheckpoint) {
  const sealed = [...entries].filter((r) => r.hash).sort((a, b) => a.id - b.id);
  const steps = { rows_rehash: 0, rows: sealed.length, links: false, root: false, signature: false, first_bad_row: null };
  let prev = "0".repeat(64);
  let links = true;
  for (const r of sealed) {
    const ok = (await rowHash(r.prev_hash, ledgerFields(r))) === r.hash;
    if (ok) steps.rows_rehash++;
    else if (steps.first_bad_row === null) steps.first_bad_row = r.id;
    if (r.prev_hash !== prev) links = false;
    prev = r.hash;
  }
  steps.links = links;
  if (!ledgerCheckpoint) return { ok: false, steps };
  const leaves = [];
  for (const r of sealed.slice(0, ledgerCheckpoint.tree_size)) leaves.push(await leafHash(r.hash));
  steps.root = leaves.length === ledgerCheckpoint.tree_size && bytesToHex(await mth(leaves)) === ledgerCheckpoint.root;
  steps.signature = await verifyCheckpoint(registryKeyX, "ledger", ledgerCheckpoint);
  return {
    ok: steps.rows_rehash === steps.rows && steps.links && steps.root && steps.signature,
    steps,
  };
}
