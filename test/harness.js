// Local simulator for the Senyap contract.
//
// Private state here is deliberately shaped like what it models: one actor's
// local vault. Every witness is a one-line read out of it, so "what is private"
// is legible at a glance rather than buried in plumbing.
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits } from '../src/managed/senyap/contract/index.js';

const COIN_PK = { bytes: new Uint8Array(32) };

const witnesses = {
  makerSecret:    (ctx) => [ctx.privateState, ctx.privateState.makerSecret],
  quoteToPost:    (ctx) => [ctx.privateState, ctx.privateState.quoteToPost],
  quoteNonce:     (ctx) => [ctx.privateState, ctx.privateState.quoteNonce],
  takerOrder:     (ctx) => [ctx.privateState, ctx.privateState.takerOrder],
  receivedQuotes: (ctx) => [ctx.privateState, ctx.privateState.receivedQuotes],
  chosenIndex:    (ctx) => [ctx.privateState, ctx.privateState.chosenIndex],
};

export const bytes32 = (n) => {
  const b = new Uint8Array(32);
  b[31] = n & 0xff;
  b[30] = (n >> 8) & 0xff;
  return b;
};

export const emptyPrivateState = () => ({
  makerSecret: bytes32(0),
  quoteToPost: { price: 0n, maxSize: 0n, expiry: 0n, makerId: bytes32(0) },
  quoteNonce: bytes32(0),
  takerOrder: [0n, 0n],
  receivedQuotes: [deadSlot(), deadSlot(), deadSlot()],
  chosenIndex: 0n,
});

export const deadSlot = () => ({
  terms: { price: 0n, maxSize: 0n, expiry: 0n, makerId: bytes32(0) },
  nonce: bytes32(0),
  live: false,
});

export class Senyap {
  static async deploy() {
    const s = new Senyap();
    s.contract = new Contract(witnesses);
    s.address = sampleContractAddress();
    const init = await s.contract.initialState(
      createConstructorContext(emptyPrivateState(), COIN_PK),
    );
    s.state = init.currentContractState;
    return s;
  }

  // Each call names the actor's private state explicitly. Two actors never share
  // a vault, which is the whole point: the maker's price is not reachable from
  // the taker's process, and vice versa.
  async call(circuit, privateState, ...args) {
    const ctx = createCircuitContext(
      circuit, this.address, COIN_PK, this.state, privateState,
    );
    const res = await this.contract.impureCircuits[circuit](ctx, ...args);
    this.state = res.context.callContext.currentQueryContext.state;
    return res.result;
  }

  ledger() {
    return ledger(this.state.data ?? this.state);
  }
}

// The serialised on-chain state, exactly as the ledger holds it. JSON.stringify
// is useless here - a ChargedState serialises to its wasm pointer and nothing
// else, so a scan over it silently finds nothing and every leak test passes for
// the wrong reason. toString() is the real dump.
export const stateDump = (s) => s.state.toString();

// Scalars appear in the dump little-endian, minimal width: 1000 -> "e803".
// Zero is rendered as "-", so it has no hex form to search for.
export const leHex = (n) => {
  let v = BigInt(n), out = '';
  while (v > 0n) {
    out += (v & 0xffn).toString(16).padStart(2, '0');
    v >>= 8n;
  }
  return out;
};

export { pureCircuits };
