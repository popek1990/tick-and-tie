// Reading Base at two nodes and deciding what the answers mean. This file is where "tied" is defined.
//
// A line is TIED only when all of this holds:
//   - at least two nodes run by different operators answered, each on chain id 8453;
//   - they agree on the block hash of the block in question, and on every decoded value;
//   - that block is at or below the LOWER of their finalized heads;
//   - no node that answered disagrees (stricter than "2 of 3": one liar is enough to stop a tick).
// One answer is ½ (read once, not tied). Disagreement is ≠. Both count as not read. A throttle, an error or a
// null is "not read", never zero and never "not there".

import { NODES, TIE_NODES, FALLBACK_NODE, rpc } from "./net.js";
import { balanceOfData } from "./abi.js";
import { decodeTransfer, parseQuantity, parseWord, lc } from "./codec.js";

export const STATE = Object.freeze({
  TIED: "tied",
  BROKEN: "broken", // two nodes agree on a value that differs from the claim
  BLIND: "blind", // the registry's own figure is not a reading by its own rule; we read the chain instead
  UNREAD: "unread",
  PENDING: "pending", // exists, but above finalized
  NIL: "nil", // the claim names nothing on chain
});

const hexN = (n) => "0x" + BigInt(n).toString(16);

/** chunk a list for nodes that cap batch sizes (drpc's free plan: 3). */
function chunks(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** Batch the same kind of call at one node, respecting its batch size. Returns answers in input order. */
export async function batchAt(nodeId, calls) {
  const size = NODES[nodeId].batch;
  const out = [];
  for (const part of chunks(calls, size)) out.push(...(await rpc(nodeId, part)));
  return out;
}

/**
 * The finalized head at each node that answers. Every tie below is pinned to min(finalized), so a node that is
 * behind cannot make a younger block look final.
 */
export async function heads(nodeIds = ["base", "tenderly", "drpc", "publicnode"]) {
  const per = {};
  await Promise.all(
    nodeIds.map(async (id) => {
      const [chain, fin] = await rpc(id, [
        { method: "eth_chainId", params: [] },
        { method: "eth_getBlockByNumber", params: ["finalized", false] },
      ]);
      const chainId = parseQuantity(chain.result);
      const number = parseQuantity(fin.result?.number);
      const ts = parseQuantity(fin.result?.timestamp);
      if (chainId !== 8453n || number === null) {
        per[id] = { notRead: chain.notRead || fin.notRead || (chainId !== 8453n ? "not read: wrong chain id" : "not read") };
        return;
      }
      per[id] = { number: Number(number), hash: lc(fin.result.hash), time: new Date(Number(ts) * 1000) };
    })
  );
  const answered = Object.entries(per).filter(([, v]) => v.number);
  const archive = answered.filter(([id]) => NODES[id].archive);
  const minFinal = archive.length ? Math.min(...archive.map(([, v]) => v.number)) : null;
  return { per, minFinal, answered: answered.map(([id]) => id) };
}

/** Decide a tie from per-node values. `same(a, b)` compares two node answers; `claim(v)` compares to the claim. */
export function decide(perNode, { same, matchesClaim, blockOf, minFinal }) {
  const answers = Object.entries(perNode).filter(([, v]) => v && !v.notRead);
  const reasons = Object.entries(perNode).filter(([, v]) => v?.notRead).map(([id, v]) => `${NODES[id]?.url ? new URL(NODES[id].url).host : id}: ${v.notRead}`);
  if (answers.length === 0) return { state: STATE.UNREAD, mark: "?", why: reasons.join("; ") || "not read: no node answered" };
  if (answers.length === 1) return { state: STATE.UNREAD, mark: "½", why: `read once, not tied (only ${answers[0][0]} answered)${reasons.length ? "; " + reasons.join("; ") : ""}` };
  const [first, ...rest] = answers;
  if (!rest.every(([, v]) => same(first[1], v))) return { state: STATE.UNREAD, mark: "≠", why: "the nodes that answered disagree" };
  const operators = new Set(answers.map(([id]) => NODES[id].operator));
  if (operators.size < 2) return { state: STATE.UNREAD, mark: "½", why: "only one operator answered" };
  const block = blockOf ? blockOf(first[1]) : null;
  if (block !== null && minFinal !== null && block > minFinal) return { state: STATE.PENDING, mark: "◔", why: `in block ${block}, above the finalized head ${minFinal}` };
  if (!matchesClaim(first[1])) return { state: STATE.BROKEN, mark: "✗", why: "two nodes agree, and not with the claim" };
  return { state: STATE.TIED, mark: "✓", why: `${answers.length} nodes, ${operators.size} operators agree` };
}

// ---- receipts ---------------------------------------------------------------------------------------------

// A receipt a node gave once is not asked for again during this reading: schedules A, C and D often name the same
// transaction. Only answers are kept; a "not read" is asked again next time.
const receiptCache = new Map();

async function receiptsFrom(id, txs) {
  const fresh = {};
  const need = txs.filter((tx) => !receiptCache.has(`${id}:${tx}`));
  if (need.length) {
    const answers = await batchAt(id, need.map((tx) => ({ method: "eth_getTransactionReceipt", params: [tx] })));
    need.forEach((tx, i) => (answers[i]?.notRead ? (fresh[tx] = answers[i]) : receiptCache.set(`${id}:${tx}`, answers[i])));
  }
  return Object.fromEntries(txs.map((tx) => [tx, receiptCache.get(`${id}:${tx}`) ?? fresh[tx]]));
}

/**
 * Receipts for many tx hashes, batched: at the two tie nodes, then at the third node for any transaction one of
 * them did not answer, so a single throttle does not turn a line into "read once". Returns {node: {tx: answer}};
 * the third node appears only for the transactions it was asked about.
 */
export async function receiptsAt(txs, nodeIds = TIE_NODES, fallback = FALLBACK_NODE) {
  const uniq = [...new Set(txs.map(lc))];
  const per = {};
  await Promise.all(nodeIds.map(async (id) => (per[id] = await receiptsFrom(id, uniq))));
  const answered = (tx) => nodeIds.filter((id) => per[id][tx] && !per[id][tx].notRead).length;
  const missing = fallback && !nodeIds.includes(fallback) ? uniq.filter((tx) => answered(tx) < 2) : [];
  if (missing.length) per[fallback] = await receiptsFrom(fallback, missing);
  return per;
}

/**
 * What one node's receipt says about one expected transfer. Ties on the LOG, never on tx.from: ERC-3009 and
 * ERC-4337 payments are sent by a relayer, so the sender is not the payer.
 */
export function readTransfer(answer, logIndex) {
  if (!answer || answer.notRead) return { notRead: answer?.notRead ?? "not read" };
  const r = answer.result;
  if (!r || typeof r !== "object") return { notRead: "not read: no receipt" };
  const log = (r.logs ?? []).find((l) => Number(parseQuantity(l.logIndex)) === logIndex);
  const t = log ? decodeTransfer(log) : null;
  return {
    status: r.status,
    block: Number(parseQuantity(r.blockNumber)),
    blockHash: lc(r.blockHash),
    sender: lc(r.from),
    transfer: t,
    transfersInTx: (r.logs ?? []).map(decodeTransfer).filter(Boolean).length,
  };
}

const sameTransfer = (a, b) =>
  a.status === b.status && a.block === b.block && a.blockHash === b.blockHash &&
  !!a.transfer === !!b.transfer &&
  (!a.transfer || (a.transfer.token === b.transfer.token && a.transfer.from === b.transfer.from && a.transfer.to === b.transfer.to && a.transfer.value === b.transfer.value));

/**
 * Tie one claimed transfer {tx, logIndex, token, from, to, value(BigInt), block?, blockHash?} against receipts
 * read at several nodes. `from` may be null when the claim does not name a payer.
 */
export function tieTransfer(claim, receiptsByNode, minFinal) {
  const perNode = {};
  const tx = lc(claim.tx);
  for (const [id, byTx] of Object.entries(receiptsByNode)) if (byTx && Object.hasOwn(byTx, tx)) perNode[id] = readTransfer(byTx[tx], claim.logIndex);
  const verdict = decide(perNode, {
    same: sameTransfer,
    blockOf: (v) => v.block,
    minFinal,
    matchesClaim: (v) =>
      v.status === "0x1" && !!v.transfer &&
      v.transfer.token === lc(claim.token) && v.transfer.to === lc(claim.to) && v.transfer.value === claim.value &&
      (claim.from == null || v.transfer.from === lc(claim.from)) &&
      (claim.block == null || v.block === claim.block) &&
      (claim.blockHash == null || v.blockHash === lc(claim.blockHash)),
  });
  return { ...verdict, perNode };
}

// ---- balances ---------------------------------------------------------------------------------------------

/**
 * balanceOf for many (token, holder) pairs at one block, at the two tie nodes (both archive), then at the third
 * node for any pair one of them did not answer. publicnode serves recent state only, so it is never asked here.
 */
export async function balancesAt(pairs, blockNumber, nodeIds = TIE_NODES, fallback = FALLBACK_NODE) {
  if (!Number.isInteger(blockNumber)) return pairs.map((p) => ({ ...p, perNode: { [nodeIds[0]]: { notRead: "not read: no finalized head was read" } } }));
  const per = {};
  const calls = pairs.map(({ token, holder }) => ({ method: "eth_call", params: [{ to: lc(token), data: balanceOfData(holder) }, hexN(blockNumber)] }));
  const value = (a) => (a.notRead ? { notRead: a.notRead } : parseWord(a.result) === null ? { notRead: "not read: empty answer" } : { value: parseWord(a.result) });
  await Promise.all(nodeIds.map(async (id) => (per[id] = (await batchAt(id, calls)).map(value))));
  const missing = fallback && !nodeIds.includes(fallback) ? pairs.map((_, i) => i).filter((i) => nodeIds.filter((id) => !per[id][i].notRead).length < 2) : [];
  if (missing.length) {
    const answers = await batchAt(fallback, missing.map((i) => calls[i]));
    per[fallback] = [];
    missing.forEach((i, k) => (per[fallback][i] = value(answers[k])));
  }
  return pairs.map((p, i) => ({ ...p, perNode: Object.fromEntries(Object.entries(per).filter(([, arr]) => arr[i] !== undefined).map(([id, arr]) => [id, arr[i]])) }));
}

/** Tie a balance read at two nodes to an expected value (BigInt), or just agree on it when expected is null. */
export function tieBalance(perNode, expected, { tolerance = 0n } = {}) {
  return decide(perNode, {
    same: (a, b) => a.value === b.value,
    matchesClaim: (v) => expected === null || (v.value >= expected - tolerance && v.value <= expected + tolerance),
    blockOf: null,
    minFinal: null,
  });
}

/** The agreed value of a balance read, or null. */
export function agreedValue(perNode) {
  const vals = Object.values(perNode).filter((v) => v && !v.notRead).map((v) => v.value);
  return vals.length >= 2 && vals.every((v) => v === vals[0]) ? vals[0] : null;
}

// ---- logs -------------------------------------------------------------------------------------------------

/**
 * Transfer logs of the canonical tokens from/to a set of wallets over (fromBlock, toBlock], walked in windows the
 * node accepts, at ONE node. Used only for the short live stretch after the committed baseline; the result is a
 * list of candidates that the caller then ties at two nodes.
 */
export async function transferLogs(nodeId, tokens, wallets, fromBlock, toBlock, direction) {
  const span = NODES[nodeId].logsSpan;
  if (!span) return { notRead: `${nodeId} does not serve logs` };
  const topicList = wallets.map((w) => "0x" + "0".repeat(24) + lc(w).slice(2));
  const out = [];
  for (let a = fromBlock; a <= toBlock; a += span) {
    const b = Math.min(a + span - 1, toBlock);
    const topics = direction === "from" ? ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topicList] : ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", null, topicList];
    const [ans] = await rpc(nodeId, [{ method: "eth_getLogs", params: [{ address: tokens.map(lc), fromBlock: hexN(a), toBlock: hexN(b), topics }] }]);
    if (ans.notRead) return { notRead: ans.notRead, partial: out, stoppedAt: a };
    for (const l of ans.result ?? []) {
      const t = decodeTransfer(l);
      if (t) out.push({ ...t, block: Number(parseQuantity(l.blockNumber)), tx: lc(l.transactionHash) });
    }
  }
  return { logs: out };
}
