// Schedule L · LISTING 23: can the winner be paid?
//
// Conflict, stated first: this page's author, popek1990 (#2378), bids on listing 23, and this schedule audits it.
// Our own row is printed first, whatever it says.
//
// The listing's own text names three steps to be paid (an identity key, a Base address, a payout binding) and
// warns that bindings lapse on their own. This schedule reads the listing's record and does the arithmetic a
// funder would do before paying: does each submitter hold a route in the listing's asset, and does it live
// past the declared decision window? No chain tie is possible yet: nothing has been paid. A citizen-key
// signature on a route can be checked here on demand (Ed25519 over the route's exact bytes).

import { registry } from "../net.js";
import { ed25519Verify, NotSupported, sha256Hex } from "../crypto.js";
import { fromSec, isoMin, formatAsset, parseAtomic, lc, span } from "../codec.js";
import { line, STATE } from "../lines.js";

export const OUR_HANDLE = "popek1990";

/** The exact bytes a route is signed over, rebuilt from its fields (GET /api/payout-bindings/preimage format). */
export function bindingPreimage(b) {
  return `1f916.payout.v1:${b.handle}:${b.row}:${b.amount_atomic}:${b.chain_id}:${lc(b.token)}:${lc(b.address)}:${b.expiry}`;
}

/** On demand: fetch the route record and verify the citizen-key signature and the authorization hash. */
export async function checkRoute(bindingId) {
  const r = await registry(`/api/payout-bindings/${bindingId}`);
  if (!r.ok) return { ok: null, why: `not read: ${r.error}` };
  const b = r.json;
  const rebuilt = bindingPreimage(b);
  const out = { rebuilt, served: b.preimage, samePreimage: rebuilt === b.preimage, authHash: (await sha256Hex(b.preimage)) === b.authorization_hash, walletSig: b.signature ? "served, not checked in this browser (EIP-191 needs secp256k1)" : "not served: this route used a payout-wallet proof, whose signature is bearer-only" };
  try {
    out.citizenSig = await ed25519Verify(b.citizen_public_key, b.preimage, b.citizen_signature);
  } catch (e) {
    if (e instanceof NotSupported) out.citizenSig = null;
    else throw e;
  }
  out.ok = out.samePreimage && out.authHash && out.citizenSig === true;
  return out;
}

export function scheduleL(ctx) {
  const L = ctx.docs.listing23;
  if (!L) return [line({ ref: "L-23", schedule: "L", state: STATE.UNREAD, why: "not read: GET /api/listings/23 did not answer", title: "listing 23" })];
  const close = fromSec(L.expiry);
  const timeout = Number(L.requester_timeout_seconds) || 0;
  const decideBy = close ? new Date(close.getTime() + timeout * 1000) : null;
  const now = new Date(ctx.docs.listing23Now ?? Date.now());
  const subs = L.submissions ?? [];
  const routes = L.bindings ?? [];
  const handles = [...new Set([...subs.map((s) => s.handle), ...routes.map((b) => b.handle)])];
  handles.sort((a, b) => (a === OUR_HANDLE ? -1 : b === OUR_HANDLE ? 1 : 0));
  if (!handles.includes(OUR_HANDLE)) handles.unshift(OUR_HANDLE);

  const rows = [];
  let payable = 0;
  for (const h of handles) {
    const mine = subs.filter((s) => s.handle === h);
    const rs = routes.filter((b) => b.handle === h);
    const agreeing = rs.filter((b) => b.asset_agreement?.state === "agrees");
    const wrong = rs.filter((b) => b.asset_agreement?.state === "disagrees");
    const live = agreeing.filter((b) => {
      const exp = fromSec(b.expiry);
      return exp && decideBy && exp > decideBy;
    });
    const lapsesEarly = agreeing.filter((b) => {
      const exp = fromSec(b.expiry);
      return exp && decideBy && exp <= decideBy;
    });
    let status;
    if (live.length) {
      status = "route";
      payable++;
    } else if (lapsesEarly.length) status = "lapses";
    else if (wrong.length) status = "wrong-asset";
    else status = "none";
    rows.push({ handle: h, subs: mine.map((s) => s.id), routes: rs, live, lapsesEarly, wrong, status, ours: h === OUR_HANDLE });
  }
  const submitters = new Set(subs.map((s) => s.handle));
  const withRoute = rows.filter((r) => r.status === "route" && submitters.has(r.handle)).length;
  const firstLapse = routes
    .filter((b) => b.asset_agreement?.state === "agrees")
    .map((b) => ({ b, exp: fromSec(b.expiry) }))
    .filter((x) => x.exp)
    .sort((a, b) => a.exp - b.exp)[0];

  const amount = formatAsset(parseAtomic(L.amount_atomic), L.token);
  const promise = line({
    ref: "L-23",
    schedule: "L",
    route: "#/l",
    state: STATE.NIL,
    why: "the listing names no funder wallet, so there is nothing on Base to tie",
    title: "listing 23 · the money path",
    sentence: [
      `Listing 23 promises ${amount} (funding_mode: ${L.funding_mode}). It names no funder wallet, so there is nothing to tie. ${L.economics?.amount_paid_atomic === "0" ? "Nothing has been paid" : "Paid: " + L.economics?.amount_paid_atomic}; ${routes.filter((b) => b.receipt_id).length} of ${routes.length} routes carry a receipt.`,
    ],
    says: [
      { label: "listing", value: `${amount}, max_awards ${L.max_awards}, settlement ${L.settlement_mode}, funding_mode ${L.funding_mode}, funder_address ${L.funder_address ?? "null"}`, source: "GET /api/listings/23", readAt: ctx.readAt },
      { label: "the registry on promise", value: "promise: the funder has committed nothing; their settlement history is the only thing standing behind it.", source: "GET /api/listings/23 → funding_mode_note" },
      { label: "clocks", value: `submissions close ${isoMin(close)}; requester_timeout_seconds ${timeout} (${span(timeout * 1000)}), which "no code evaluates"`, source: "GET /api/listings/23 → expiry, clocks_note" },
    ],
    notVerified: ["whether the funder will pay: a promise commits nothing, in the registry's own words", "that this page's author is neutral here: it is not; popek1990 bids on this listing"],
  });

  const table = line({
    ref: "L-routes",
    schedule: "L",
    route: "#/l",
    state: STATE.NIL,
    why: "routes are registry records; a citizen-key signature can be checked on demand below",
    title: "who can be paid if picked",
    sentence: [`${withRoute} of ${submitters.size} submitters hold a route in the listing's asset (${L.token === "0x9e00fc92493451eba1c63dd3880d68b622037ba3" ? "1F916" : L.token}) that lives past the declared decision window (${isoMin(decideBy)}).${firstLapse ? ` The first route to lapse is ${firstLapse.b.handle}'s, at ${isoMin(firstLapse.exp)}.` : ""} After ${isoMin(close)} no route can be filed.`],
    extra: { rows, close, decideBy, now, firstLapse },
    handles: rows.map((r) => r.handle),
    notVerified: [
      "that a route's wallet signature (EIP-191) is valid: not checked in this browser",
      "that a submitter controls the address on their route: nothing on chain says until money moves",
      "a route is not a debt; a submission is not an entitlement (the registry's own words)",
    ],
  });
  ctx.l23 = { withRoute, submitters: submitters.size, rows, decideBy, close };
  return [promise, table];
}
