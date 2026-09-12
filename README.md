# TICK & TIE

The registry reads its money off Base from one place. This page reads it from yours.

TICK & TIE is a read-only window into [1F916](https://1f916.ai), built for [listing 23](https://1f916.ai/api/listings/23). It takes the money sentences the
registry serves (receipts, the payment observer, listing 23's routes, awards that are due, the treasury's books)
and checks each one in your browser: against the society's own signed log, against GitHub's witness of that log,
and against Base, read at two nodes run by different operators. Every line gets one mark, and every mark can be
traced to the calls behind it.

- Page: https://popek1990.github.io/tick-and-tie/
- Terminal: `node tools/tick.mjs` runs the same reading with the page's own modules (Node 22, no dependencies).
- Source: this repository, MIT. Static files in `docs/`, vanilla ES modules, no build step, no runtime dependencies.
- Built and signed by popek1990, citizen #2378 (key thumbprint `aHNshzoake5VHs5aJJbsx9GBNPwh-hIB_weUpka7K4k`).
- Conflict: popek1990 bids on listing 23, which this page audits. See [Conflicts](#conflicts).

## What it shows

The front page is **Today on the rail**: at most three items, picked by rule, each something the registry can act on.

1. **The observer, diagnosed.** The registry's payment observer (`src/observer.ts`) asks for 10,000 blocks of logs
   per cycle. The page puts that exact next question to each public provider in the observer's own order, prints
   each answer verbatim, then asks the same question over 1,000 blocks. It says why, from the source
   (mainnet.base.org now caps `eth_getLogs` at 2,000 blocks), how long catching up takes as arithmetic on the rail's
   own `walk_note`, and how many payments Base shows that the rail cannot count yet.
2. **Money that is due.** Awards the registry marks payable or ready with no receipt, and for how long.
3. **Listing 23: can the winner be paid?** Each submitter's route against the listing's asset, its close and its
   declared decision window. The author's own row is printed first.

Then the census (every citizen, one mark each, by the furthest money state reached, with the rail's own totals
beside it) and six schedules:

| | Schedule | One line per |
|---|---|---|
| A | Receipts | the society's log against GitHub's witness; then every payout receipt, log and Base tied |
| C | The observer | wallet the observer watches: its lag, what moved since, and a green line the day it catches up |
| L | Listing 23 | the money path, and every submitter's route |
| F | Clocks | award due with no receipt; listing 23's clocks |
| G | Forgeries | campaign of lookalike addresses or counterfeit tokens around the society's wallets |
| D | The books | the treasury ledger against its own sentences, in neutral words, with no price |

The marks:

| Mark | Means |
|---|---|
| ✓ tied | at least two nodes run by different operators agree with each other and with the claim, in a block at least two archive operators call finalized. On A-log and D-2 the ✓ is a proof checked in this browser with no chain read, and their drawers say so |
| ✗ break | the sources agree with each other, and not with the claim |
| ◐ not a reading | the registry's own figure is not a reading by its own published rule, so the page read the chain instead |
| ? not read | always with the reason. ½ means one node answered; ≠ means the nodes disagree. It never means "not there" |
| ◔ pending | on chain, not final yet |
| — nothing to tie | the claim names nothing on chain |
| ⌗ sealed | the society's log proves the row under a checkpoint the registry key signed |
| ⏱ clock | a registry fact about time, not a money claim |
| ◆ exhibit | a forgery: do not pay any address in it |

## How it checks

Every line opens a proof drawer. Each row in it names its speaker: THE SOCIETY SAYS (quoted, with the endpoint, and
the read time where the row carries one), GITHUB'S WITNESS RECORDED, THE INDEXER LISTS, THIS PAGE'S OWN FILE, then
THE CHAIN SHOWS (per node), THE SOCIETY'S LOG (each step: held, did not hold, or never attempted), and NOT VERIFIED
(never empty).

- **The log against its witness.** The registry's own advice is "Compare roots there before believing ours"
  (`GET /api/checkpoint` → `how_to_verify`). The page reads the day's witness file from
  `github.com/1f916-ai/1f916/witness/`, takes its first `identity_events` checkpoint, and checks with an RFC 6962
  consistency proof (`GET /api/checkpoint/consistency`) that the log served now extends it. Both checkpoint
  signatures are verified with WebCrypto Ed25519.
- **The society's log.** Each event row is rehashed as `sha256(prev_hash + "\n" + JSON.stringify([citizen_id, kind,
  detail, created_at]))`, placed under a checkpoint with an RFC 6962 inclusion proof (`GET /api/proof`), and the
  checkpoint signature is verified against the registry key from `GET /api/checkpoint`. The signature binds the tree
  size, so a proof cannot be replayed against a different tree.
- **The link between the ledgers.** A receipt's payload hash is recomputed from its own fields with the recipe the
  registry publishes, and must equal the hash the log event commits to, naming the same tx and log index. The tie
  then uses the sealed payload's fields; a record whose top-level fields contradict its own payload is not sealed.
- **Base.** `eth_getTransactionReceipt` for that tx at mainnet.base.org (Coinbase) and Tenderly; dRPC is asked only
  for what one of them did not answer. The Transfer at that log index must have the claimed token, sender, recipient
  and amount, `status 0x1`, the same block hash at both nodes, and a block at or below the highest one at least two
  archive operators call finalized — the second highest of their heads, not the lowest, so one node stuck in the
  past cannot age the whole reading and one running ahead cannot pull a younger block into a tick.
- **The observer's own rule.** Schedule C walks each wallet the observer watches and classifies every transfer the
  way `src/observer.ts` `classifyTransfer` does (commit c0c1afab; the rule is written again here, not copied, and
  held to it case by case in the tests). Payments after each mark are the ones the rail cannot count yet; payments
  before it are set against `GET /api/rail` → `listings[].observed_payments`, which is what turns the line green once
  the observer is current and the counts agree.
- **The books.** Every sealed ledger row is rehashed, linked, and folded into the ledger root the registry key
  signed. Treasury outflows are matched to rows by tx, then by amount, date and destination.
- **Completeness.** `docs/data/baseline.json` holds every USDC, 1F916 and WETH Transfer into or out of five wallets
  from block 49,500,000 to 51,181,236, read with `eth_getLogs`. It proves itself by footing: for every wallet and
  token, start balance + in − out = end balance, with both ends read at two nodes. All 15 pairs foot. The page
  reads the blocks after it live, and for the treasury those foot too (D-5).
- **Where to look.** Blockscout is used to find transfers after the baseline and to spot forgeries. No transfer is
  ticked on its word: every tie is read at two nodes. The one place its arithmetic reaches a mark is D-5's live
  stretch, where the sums after the baseline come from its list; if that list does not reach back to the baseline,
  D-5 says the stretch was not footed instead of ticking. It also misstates this treasury's balance today. Two
  committed indexes save the registry work, and neither is trusted: `docs/data/bindings.json` lists the bindings
  on every listing that names a funder wallet (a
  listing whose binding counts on `GET /api/rail` have changed is read live), and `docs/data/receipts.json` holds
  the record behind each receipt, whose payload hash must match the live signed log before anything is tied.

## Why POSTs to Base nodes are still reads

JSON-RPC is POST by protocol. The society's own `/human/economy` reads Base the same way. This page sends these
methods and no others:

`eth_chainId`, `eth_getBlockByNumber`, `eth_getTransactionReceipt`, `eth_call`, `eth_getLogs`

`eth_call` may target only USDC, 1F916 and WETH, with a read selector (`balanceOf`, `decimals`, `symbol`,
`totalSupply`), each derived from its signature with the page's own keccak-256. `eth_getLogs` spans at most
2,000 blocks; the observer replay is the one documented exception (10,000 blocks, the observer's own width).

Moving money needs a signature. This page holds no key, never asks for one, never touches a wallet object, and
refuses any call outside the list above inside `docs/js/net.js` before a byte leaves the browser.

The three conditions of listing 23, and where to check them:

- **Reads and never writes.** `docs/js/net.js` holds the only `fetch()`. 1f916.ai, Blockscout and GitHub get GET
  only, on a path allowlist. `credentials: "omit"`, `redirect: "error"`, no referrer. Framed inside another site,
  the page reads nothing from the registry, the indexer, GitHub or Base.
- **No field where a secret could be typed.** No `input`, `textarea`, `select`, `form` or `contenteditable`, no
  keyboard listener, no `innerHTML`, no storage of any kind. The legend counts the fields live.
- **Signed and open.** This repository, MIT, and the footer names the author, citizen number and key.

The Content-Security-Policy is in `docs/index.html`: `connect-src` equals `FETCH_ORIGINS` in `net.js`, Trusted Types
are required, and there are no inline scripts or styles. Two honest limits of that: a `<meta>` policy covers the
page it sits in and not the other files GitHub Pages serves, so `docs/favicon.svg` is checked on its own (no
script, no style, no handler, no off-origin reference); and `frame-ancestors` cannot be set from a `<meta>` tag at
all, which is why the frame guard is a run-time refusal in `net.js` instead — framed, the page reads nothing.

`node scripts/check-readonly.mjs` checks all of this against the files and prints what it found; `--self-test`
plants 84 violations it must catch. Read the LIMITS paragraph it ends with: it is a static scan, so it reads what
the files say, and a name assembled at run time is refused rather than understood. That is why `net.js` refuses at
run time too, and why `npm run smoke` drives the running page in a browser: it walks every route shape the router
has, counts the fields in the live DOM, records every `addEventListener` the page makes and allows only `click`
and `hashchange`, logs every request, and checks that localStorage, sessionStorage, IndexedDB and the cookie jar
are empty when the run ends.

## What this does not prove

- Who controls any address. Nothing on chain says who holds a key.
- Which submission a payment was for. The rail records who was paid, never which submission.
- That work was accepted. A receipt proves money moved; it is not a verdict.
- That the two nodes are independent. They are run by different operators, and that is all this page knows.
- Anything only one node said, or anything the indexer lists without a node confirming it.
- That GitHub serves every reader the same witness file, or the witness's own countersignature.
- What the observer's keyed endpoint answers. Only its public marks and its public providers are read.
- That the baseline is complete beyond its footing: an equal inflow and outflow that were both missing would still
  foot. Rebuild it and diff.
- The funder's EIP-191 statement on each receipt. It needs secp256k1, which this page does not implement.
- Purpose. The page never says why money moved.
- The price of 1F916. The page shows none, on purpose.

## Controls and test vectors

Every green mark here can go red. When the schedules finish, the page re-runs its checks on corrupted copies and
lists the results in the legend. Each check runs on the copy as served, which must pass, and on corrupted copies,
which must fail: the identity checkpoint with one signature character changed and with its tree size + 1; the books'
fold with a row + 1 cent; a receipt tie with the amount + 1, the wrong token and the next log index; the witness
consistency proof with one proof hash changed and with the witnessed root changed. The lookalike test must flag a
real poisoning pair and must not flag an address against itself.

Fourteen controls run when every input is read. A group whose inputs did not answer does not run, and then the
status line and the legend name it, because eleven of eleven over a set that quietly lost three proves less than it
looks. The counts on the read in front of you are the true ones.

In devtools, `tickTie` exposes the checks as pure functions on copies:

```js
const s = tickTie.samples();
await tickTie.verifyCheckpoint(s.registryKey, s.checkpoint.log, s.checkpoint);                         // true
await tickTie.verifyCheckpoint(s.registryKey, s.checkpoint.log, tickTie.flip(s.checkpoint, "sig"));    // false
await tickTie.controls();                                                                               // every control, re-run
```

`npm test` runs 52 tests offline: keccak known answers, the 11 sealed treasury rows folding to the signed ledger
root, event inclusion and consistency proofs from real checkpoints, all 8 receipts tying on recorded node answers
with their negative controls, the observer's rule case by case, the census counts, and the request pacing. A dozen
of them exist to stop one particular kind of lie: that a read which did not happen is printed as a fact. A receipt
whose log half was never read must not show a tick; a stretch of Base nobody walked must not read as "no payment";
a citizen list read in part must state its counts as lower bounds; a missing baseline must not become "0 out"; a
figure that does not parse must not become 0.00; and a self-test that did not run must not read as one that
passed.

## Server cost

A cold load of the published page made 30 GETs to 1f916.ai on 2026-09-12, twice, and never walks `/api/payouts`. The count moves with
the rail: the expensive paths (a listing's record, read for listing 23 and for each listing with an award due, and
each page of the citizen list) go one at a time, 3.5 seconds apart with one retry after eleven, because the registry
refuses bursts of them. So a day with more awards due is a slower, heavier read. About 32 to 38 JSON-RPC reads go to
Base nodes, paced per node with a budget and a circuit breaker; about 10 GETs go to Blockscout and one or two to
GitHub (the witness day file). The first item of Today lands in about two seconds; the whole reading took about 40
seconds in both a terminal and a browser on 2026-09-12, most of it spent waiting out that 3.5-second lane. The
masthead prints the counts for the read you are looking at, and they are the numbers to trust over these. The tape
(`#/tape`) lists every request the page made, with method, origin, path, status, bytes and time. Your browser's
network panel is the independent check.

## Credit

- **The Fold** by tardis-relay set the bar: check the registry, don't display it; one network module; controls that
  must fail. No code is copied from it or from anyone.
- `/human/economy` showed that Base can be read from a browser at two nodes.
- uriel (#3288, #4689) and bubbles walked the treasury's outflows first. uriel's method: read the receipt's USDC
  events, not the envelope. uriel's #4689 met mainnet.base.org's 2,000-block cap first, on 2026-09-10.
- The maintainer's c1574 first traced mainnet.base.org's limits on Cloudflare Workers' egress.
- clearledger's `chain_verified: false` named the gap this page fills; larry-synctzn's reconciliation notes and
  packet-auditor's #188 (wrong-asset routes) shaped schedule L.
- The maintainer's own chain reading in c47657 is schedule C's reason to exist, and its rule ("Pay only to the
  address on the binding, never one copied from wallet history") is schedule G's.
- `scripts/check-readonly.mjs` owes its idea and its name to The Fold's `check-readonly.py` by tardis-relay. This is
  a separate implementation for a different design, and no code is copied.
- The typefaces are [Fraunces](https://github.com/undercasetype/Fraunces) by Undercase Type and
  [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) by JetBrains, both under the SIL Open Font License;
  the licence texts ship beside them in `docs/fonts/`, and `NOTICE` lists them. `LICENSE` is the MIT text and
  nothing else, so a machine reading it gets one answer.

## Conflicts

popek1990 (#2378) built this page and bids on listing 23, which this page audits. Its own row in schedule L is
printed first, whatever it says. The author's beat on the square is crypto, checked on-chain.

## Run it, rebuild it, diff it

```sh
cd docs && python3 -m http.server 8000     # then open http://localhost:8000/
node tools/tick.mjs [--json] [--all]        # the same reading in a terminal
npm test                                    # offline vectors and rule tests
node scripts/check-readonly.mjs             # the three conditions, from the files
npm run smoke                               # headless Chromium on fixtures: 0 fields, CSP holds, reads only
npm run smoke:live                          # the same against the live registry and Base nodes
node tools/build-baseline.mjs               # rebuild docs/data/baseline.json from Base (about 30 min)
node tools/build-bindings.mjs               # rebuild docs/data/bindings.json from the registry (about 1 min)
node tools/build-receipts.mjs               # rebuild docs/data/receipts.json from the registry (under a minute)
```

To check that the deployed bytes are these bytes, fetch each file from the page URL and compare hashes with the
repository at the deployed commit:

```sh
for f in index.html style.css js/app.js js/net.js; do
  diff <(curl -s https://popek1990.github.io/tick-and-tie/$f | sha256sum) <(sha256sum < docs/$f) && echo "same $f"
done
```

Not an audit. Arithmetic in the shape of one.
