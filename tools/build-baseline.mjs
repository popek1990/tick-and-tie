#!/usr/bin/env node
// Builds docs/data/baseline.json: every canonical-token Transfer (USDC, 1F916, WETH) into or out of the wallets
// the society's money moves through, from FROM_BLOCK to a finalized block N, read with eth_getLogs straight from a
// Base node. It never contacts 1f916.ai except one GET /api/rail to learn which funder wallets exist.
//
// Why a baseline at all: walking 1.7M blocks of logs in a visitor's browser would be slow and rude to public
// nodes, and Blockscout (the obvious shortcut) is wrong about this treasury. It shows 2,140 USDC against 28,810
// on chain, because it never indexed the treasury's own 2026-09-09 swap (research/data.md §4). So the heavy walk
// happens once, here, and the page then CHECKS it rather than trusting it:
//   - the start and end balances are re-read at two nodes, and the logs must foot to them;
//   - every outflow the page talks about is re-read as a receipt at two nodes;
//   - two random rows are re-read on every load as a sample that can fail;
//   - anything after block N is read live.
// Anyone can rerun this file and diff the output.
//
// Usage: node tools/build-baseline.mjs [--from 49500000] [--to <block>] [--out docs/data/baseline.json]

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);

const NODE = "https://mainnet.base.org";
const CHECK_NODES = ["https://mainnet.base.org", "https://base.drpc.org"];
const WINDOW = 2000; // mainnet.base.org's eth_getLogs range limit since about 2026-09-10
const FROM_BLOCK = Number(arg("--from", "49500000"));
const OUT = arg("--out", new URL("../docs/data/baseline.json", import.meta.url).pathname);

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TOKEN = "0x9e00fc92493451eba1c63dd3880d68b622037ba3";
const WETH = "0x4200000000000000000000000000000000000006";
const TOKENS = [USDC, TOKEN, WETH];
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TREASURY = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
const PAYOUT_WALLET = "0xf32c99ae17c17022889b2288749ca433a2504211";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "0x" + BigInt(n).toString(16);
const topic = (addr) => "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();
let calls = 0;

async function rpc(url, method, params, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) throw new Error("HTTP 429");
      const j = await res.json();
      if (j.error) throw new Error(`${j.error.code}: ${j.error.message}`);
      if (j.result === null || j.result === undefined) throw new Error("null result");
      return j.result;
    } catch (e) {
      last = e;
      await sleep(1200 * (i + 1));
    }
  }
  throw new Error(`${url} ${method}: ${last?.message}`);
}

async function main() {
  const rail = await (await fetch("https://1f916.ai/api/rail", { headers: { accept: "application/json" } })).json();
  const wallets = new Map([
    [TREASURY, "the society treasury"],
    [PAYOUT_WALLET, "the society's payout wallet (named in ledger row 14)"],
  ]);
  for (const l of rail.listings ?? []) if (l.funder_address) wallets.set(l.funder_address.toLowerCase(), `funder wallet of ${l.funder}`);
  for (const m of rail.observer?.marks ?? []) if (m.funder_address && !wallets.has(m.funder_address.toLowerCase())) wallets.set(m.funder_address.toLowerCase(), "a wallet the registry's observer watches");
  const list = [...wallets.keys()];
  console.error(`watching ${list.length} wallets: ${list.join(", ")}`);

  const fin = await rpc(NODE, "eth_getBlockByNumber", ["finalized", false]);
  const toBlock = Number(arg("--to", String(Number(BigInt(fin.number)))));
  const toHeader = await rpc(NODE, "eth_getBlockByNumber", [hex(toBlock), false]);
  const fromHeader = await rpc(NODE, "eth_getBlockByNumber", [hex(FROM_BLOCK), false]);

  const seen = new Map();
  const topicsList = list.map(topic);
  const windows = Math.ceil((toBlock - FROM_BLOCK + 1) / WINDOW);
  let w = 0;
  for (let a = FROM_BLOCK; a <= toBlock; a += WINDOW) {
    const b = Math.min(a + WINDOW - 1, toBlock);
    for (const topics of [[TRANSFER, topicsList], [TRANSFER, null, topicsList]]) {
      const logs = await rpc(NODE, "eth_getLogs", [{ address: TOKENS, fromBlock: hex(a), toBlock: hex(b), topics }]);
      for (const l of logs) {
        if (l.removed || l.topics.length !== 3) continue;
        const key = `${l.transactionHash}:${Number(BigInt(l.logIndex))}`;
        if (seen.has(key)) continue;
        seen.set(key, {
          block: Number(BigInt(l.blockNumber)),
          tx: l.transactionHash.toLowerCase(),
          log_index: Number(BigInt(l.logIndex)),
          token: l.address.toLowerCase(),
          from: "0x" + l.topics[1].slice(26).toLowerCase(),
          to: "0x" + l.topics[2].slice(26).toLowerCase(),
          value: BigInt(l.data).toString(),
        });
      }
      await sleep(260);
    }
    if (++w % 50 === 0) console.error(`window ${w}/${windows} (block ${b}), ${seen.size} logs, ${calls} calls`);
  }
  const logs = [...seen.values()].sort((x, y) => x.block - y.block || x.log_index - y.log_index);

  // Balances at both ends, at two nodes, and the footing per wallet and token.
  const balanceAt = async (url, token, wallet, block) =>
    BigInt(await rpc(url, "eth_call", [{ to: token, data: "0x70a08231" + wallet.slice(2).padStart(64, "0") }, hex(block)])).toString();
  const balances = {};
  const footing = {};
  for (const wallet of list) {
    balances[wallet] = {};
    footing[wallet] = {};
    for (const token of TOKENS) {
      const start = {};
      const end = {};
      for (const url of CHECK_NODES) {
        try {
          start[new URL(url).host] = await balanceAt(url, token, wallet, FROM_BLOCK);
          end[new URL(url).host] = await balanceAt(url, token, wallet, toBlock);
        } catch (e) {
          start[new URL(url).host] ??= null;
          end[new URL(url).host] ??= null;
        }
        await sleep(300);
      }
      balances[wallet][token] = { at_from_block: start, at_to_block: end };
      let inflow = 0n;
      let outflow = 0n;
      for (const l of logs) {
        if (l.token !== token) continue;
        if (l.to === wallet) inflow += BigInt(l.value);
        if (l.from === wallet) outflow += BigInt(l.value);
      }
      const s = Object.values(start).find((v) => v !== null);
      const e = Object.values(end).find((v) => v !== null);
      footing[wallet][token] = {
        in: inflow.toString(),
        out: outflow.toString(),
        foots: s != null && e != null ? BigInt(s) + inflow - outflow === BigInt(e) : null,
      };
    }
  }

  const out = {
    kind: "tick-and-tie.baseline.v1",
    built_at: new Date().toISOString(),
    built_by: "tools/build-baseline.mjs (rerun it and diff)",
    method: `eth_getLogs at ${new URL(NODE).host}, topic0 Transfer, from-or-to any watched wallet, tokens USDC/1F916/WETH, windows of ${WINDOW} blocks; balances by eth_call balanceOf at ${CHECK_NODES.map((u) => new URL(u).host).join(" and ")}`,
    from_block: FROM_BLOCK,
    from_block_time: new Date(Number(BigInt(fromHeader.timestamp)) * 1000).toISOString(),
    to_block: toBlock,
    to_block_hash: toHeader.hash,
    to_block_time: new Date(Number(BigInt(toHeader.timestamp)) * 1000).toISOString(),
    wallets: Object.fromEntries(wallets),
    tokens: TOKENS,
    rpc_calls: calls,
    limits: [
      "Completeness is shown by footing: start balance + logs in − logs out = end balance, per wallet and token. An inflow and an outflow of the same size that are both missing would still foot.",
      "Only ERC-20 Transfer logs of the three canonical tokens are here. Native ETH, other tokens and approvals are not.",
      "One node answered the log walk. The page re-reads what it relies on at two.",
    ],
    balances,
    footing,
    logs,
  };
  writeFileSync(OUT, JSON.stringify(out) + "\n");
  console.error(`wrote ${OUT}: ${logs.length} logs, blocks ${FROM_BLOCK}..${toBlock}, ${calls} RPC calls`);
  for (const [wallet, byToken] of Object.entries(footing)) {
    for (const [token, f] of Object.entries(byToken)) if (f.foots === false) console.error(`DOES NOT FOOT: ${wallet} ${token}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
