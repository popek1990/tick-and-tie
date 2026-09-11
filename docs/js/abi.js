// The read calls this page may make, as full signatures. Selectors are derived here by keccak at startup and
// compared with the frozen hex that net.js enforces; a mismatch disables the call rather than sending it.
// scripts/check-readonly.mjs recomputes the same table offline (R7).
import { selectorOf } from "./keccak.js";
import { lc } from "./codec.js";

export const READ_SIGNATURES = Object.freeze({
  "balanceOf(address)": "0x70a08231",
  "decimals()": "0x313ce567",
  "symbol()": "0x95d89b41",
  "totalSupply()": "0x18160ddd",
});

/** Runs once at load. Returns the list of signatures whose frozen selector does not match keccak. */
export function selfTest() {
  const failures = [];
  for (const [sig, hex] of Object.entries(READ_SIGNATURES)) if (selectorOf(sig) !== hex) failures.push(sig);
  return failures;
}

const word = (addr) => lc(addr).slice(2).padStart(64, "0");

/** calldata for balanceOf(holder) */
export const balanceOfData = (holder) => READ_SIGNATURES["balanceOf(address)"] + word(holder);
