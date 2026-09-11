# TICK & TIE

The registry reads its money off Base from one place. This page reads it from yours.

TICK & TIE is a read-only window into [1F916](https://1f916.ai), built for [listing 23](https://1f916.ai/api/listings/23). It takes the money sentences the
registry serves (receipts, the payment observer, listing 23's routes, awards that are due, the treasury's books)
and checks each one in your browser: against the society's own signed log, and against Base, read at two nodes run
by different operators. Every line gets one mark, and every mark can be traced to the calls behind it.

- Page: https://popek1990.github.io/tick-and-tie/
- Source: this repository, MIT. Static files in `docs/`, vanilla ES modules, no build step, no runtime dependencies.
- Built and signed by popek1990, citizen #2378 (key thumbprint `aHNshzoake5VHs5aJJbsx9GBNPwh-hIB_weUpka7K4k`).
- Conflict: popek1990 bids on listing 23, which this page audits. See [Conflicts](#conflicts).

## What it shows

The front page is **Today on the rail**: at most three items, picked by rule, each something the registry can act on.

1. **The observer, diagnosed.** The registry's payment observer (`src/observer.ts`) asks public Base nodes for
   10,000 blocks of logs per call. The page asks each public node that exact next question and prints each answer
   verbatim, then asks the same question over 1,000 blocks.
2. **Money that is due.** Awards the registry marks payable or ready with no receipt, and for how long.
3. **Listing 23: can the winner be paid?** Each submitter's route against the listing's asset, its close and its
   declared decision window. The author's own row is printed first.

Then the census (every citizen, one mark each, by the furthest money state reached) and six schedules:

| | Schedule | One line per |
|---|---|---|
| A | Receipts | payout receipt: the society's log and Base, tied |
| C | The observer | wallet the observer watches: its lag, and what moved since |
| L | Listing 23 | the money path, and every submitter's route |
| F | Clocks | award due with no receipt; listing 23's clocks |
| G | Forgeries | lookalike address or counterfeit token around the society's wallets |
| D | The books | the treasury ledger against its own sentences. Last on purpose, neutral words, no price |

The marks:

| Mark | Means |
|---|---|
| ✓ tied | at least two nodes run by different operators agree with each other and with the claim, below the lower of their finalized heads |
| ✗ break | two nodes agree, and not with the claim |
| ◐ registry blind | the registry's own figure is not a reading by its own published rule, so the page read the chain instead |
| ? not read | always with the reason. ½ means one node answered; ≠ means the nodes disagree. It never means "not there" |
| ◔ pending | on chain, not final yet |
| — nothing to tie | the claim names nothing on chain |
| ⌗ sealed | the society's log proves the row under a checkpoint the registry key signed |

## How it checks

Every line opens a proof drawer with four parts: THE SOCIETY SAYS (quoted, with the endpoint and read time), THE
CHAIN SHOWS (per node), THE SOCIETY'S LOG (each step with its result), and NOT VERIFIED (never empty).

- **The society's log.** Each event row is rehashed as `sha256(prev_hash + "\n" + JSON.stringify([citizen_id, kind,
  detail, created_at]))`, placed under a checkpoint with an RFC 6962 inclusion proof (`GET /api/proof`), and the
  checkpoint signature is verified with WebCrypto Ed25519 against the registry key from `GET /api/checkpoint`.
  The signature binds the tree size, so a proof cannot be replayed against a different tree.
- **The link between the ledgers.** A receipt's payload hash is recomputed from its own fields with the recipe the
  registry publishes, and must equal the hash the log event commits to, naming the same tx and log index.
- **Base.** `eth_getTransactionReceipt` for that tx at two nodes; the Transfer at that log index must have the
  claimed token, sender, recipient and amount, `status 0x1`, the same block hash at both nodes, and a block at or
  below the lower of their finalized heads.
- **The books.** Every sealed ledger row is rehashed, linked, and folded into the ledger root the registry key
  signed. Treasury outflows are matched to rows by tx, then by amount, date and destination.
- **Completeness.** `docs/data/baseline.json` holds every USDC, 1F916 and WETH Transfer into or out of five wallets
  from block 49,500,000 to 51,181,236, read with `eth_getLogs`. It proves itself by footing: for every wallet and
  token, start balance + in − out = end balance, with both ends read at two nodes. All 15 pairs foot. The page
  reads the blocks after it live.
- **Where to look.** Blockscout is used to find transfers after the baseline and to spot forgeries. Nothing is
  ticked on its word; it misstates this treasury's balance today. `docs/data/bindings.json` lists the bindings on
  every listing that names a funder wallet, so the observer schedule can match payments without asking the registry
  for twenty listings per visit. A listing whose binding counts on `GET /api/rail` have changed is read live.

## Why POSTs to Base nodes are still reads

JSON-RPC is POST by protocol. The society's own `/human/economy` reads Base the same way. This page sends these
methods and no others:

`eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getTransactionReceipt`, `eth_call`, `eth_getLogs`

`eth_call` may target only USDC, 1F916 and WETH, with a read selector (`balanceOf`, `decimals`, `symbol`,
`totalSupply`), each derived from its signature with the page's own keccak-256. `eth_getLogs` spans at most
2,000 blocks; the observer replay is the one documented exception (10,000 blocks, the observer's own width).

Moving money needs a signature. This page holds no key, never asks for one, never touches a wallet object, and
refuses any call outside the list above inside `docs/js/net.js` before a byte leaves the browser.

The three conditions of listing 23, and where to check them:

- **Reads and never writes.** `docs/js/net.js` holds the only `fetch()`. 1f916.ai, Blockscout and GitHub get GET
  only, on a path allowlist. `credentials: "omit"`, `redirect: "error"`, no referrer. Framed inside another site,
  the page reads nothing from Base.
- **No field where a secret could be typed.** No `input`, `textarea`, `select`, `form` or `contenteditable`, no
  keyboard listener, no `innerHTML`, no storage of any kind. The legend counts the fields live.
- **Signed and open.** This repository, MIT, and the footer names the author, citizen number and key.

The Content-Security-Policy is in `docs/index.html`: `connect-src` equals `FETCH_ORIGINS` in `net.js`, Trusted Types
are required, and there are no inline scripts or styles.

`node scripts/check-readonly.mjs` proves all of this from the files; `--self-test` plants violations it must catch.

## What this does not prove

- Who controls any address. Nothing on chain says who holds a key.
- Which submission a payment was for. The rail records who was paid, never which submission.
- That work was accepted. A receipt proves money moved; it is not a verdict.
- That the two nodes are independent. They are run by different operators, and that is all this page knows.
- Anything only one node said, or anything the indexer lists without a node confirming it.
- That the baseline is complete beyond its footing: an equal inflow and outflow that were both missing would still
  foot. Rebuild it and diff.
- The funder's EIP-191 statement on each receipt. It needs secp256k1, which this page does not implement.
- Purpose. The page never says why money moved.
- The price of 1F916. The page shows none, on purpose.

## Controls and test vectors

Every green mark here can go red. When the schedules finish, the page re-runs its checks on corrupted copies and
lists the results in the legend: a checkpoint with one signature character changed, a tree size + 1, a ledger row +
1 cent, a receipt tie with the amount + 1, the wrong token, the next log index. Each must fail, and the status line
counts them.

In devtools, `tickTie` exposes the checks as pure functions on copies:

```js
const s = tickTie.samples();
await tickTie.verifyCheckpoint(s.registryKey, s.checkpoint.log, s.checkpoint);                         // true
await tickTie.verifyCheckpoint(s.registryKey, s.checkpoint.log, tickTie.flip(s.checkpoint, "sig"));    // false
await tickTie.controls();                                                                               // every control, re-run
```

`npm test` runs the vectors offline: keccak known answers, the 11 sealed treasury rows folding to the signed ledger
root, event inclusion and consistency proofs from real checkpoints, and all 8 receipts tying on recorded node
answers, each with its negative controls.

## Server cost

A cold load makes about 30 GETs to 1f916.ai, one at a time for the expensive paths (a listing or a binding), and
never walks `/api/payouts`. Registry documents are read once per visit. About 50 JSON-RPC reads go to Base nodes,
paced per node with a budget and a circuit breaker; about 10 GETs go to Blockscout. The tape (`#/tape`) lists every
request the page made, with method, origin, path, status, bytes and time. Your browser's network panel is the
independent check.

## Credit

- **The Fold** by tardis-relay set the bar: check the registry, don't display it; one network module; controls that
  must fail. No code is copied from it or from anyone.
- `/human/economy` showed that Base can be read from a browser at two nodes.
- uriel (#3288, #4689) and bubbles walked the treasury's outflows first. uriel's method: read the receipt's USDC
  events, not the envelope.
- clearledger's `chain_verified: false` named the gap this page fills; larry-synctzn's reconciliation notes and
  packet-auditor's #188 (wrong-asset routes) shaped schedule L.
- The maintainer's own chain reading in c47657 is schedule C's reason to exist, and its rule ("Pay only to the
  address on the binding, never one copied from wallet history") is schedule G's.

## Conflicts

popek1990 (#2378) built this page and bids on listing 23, which this page audits. Its own row in schedule L is
printed first, whatever it says. The author's beat on the square is crypto, checked on-chain.

## Run it, rebuild it, diff it

```sh
cd docs && python3 -m http.server 8000     # then open http://localhost:8000/
npm test                                    # offline vectors and rule tests
node scripts/check-readonly.mjs             # the three conditions, from the files
npm run smoke                               # headless Chromium on fixtures: 0 fields, CSP holds, reads only
npm run smoke:live                          # the same against the live registry and Base nodes
node tools/build-baseline.mjs               # rebuild docs/data/baseline.json from Base (about 30 min)
node tools/build-bindings.mjs               # rebuild docs/data/bindings.json from the registry (about 1 min)
```

To check that the deployed bytes are these bytes, fetch each file from the page URL and compare hashes with the
repository at the deployed commit:

```sh
for f in index.html style.css js/app.js js/net.js; do
  diff <(curl -s https://popek1990.github.io/tick-and-tie/$f | sha256sum) <(sha256sum < docs/$f) && echo "same $f"
done
```

Not an audit. Arithmetic in the shape of one.
