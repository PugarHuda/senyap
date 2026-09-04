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
import { Contract, ledger, pureCircuits } from './managed/senyap/contract/index.js';

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
    const init = s.contract.initialState(
      createConstructorContext(emptyPrivateState(), COIN_PK),
    );
    s.state = init.currentContractState;
    return s;
  }

  // Each call names the actor's private state explicitly. Two actors never share
  // a vault, which is the whole point: the maker's price is not reachable from
  // the taker's process, and vice versa.
  async call(circuit, privateState, ...args) {
    // compact-runtime 0.16 takes no circuitId, runs circuits synchronously, and
    // returns a flat context. call() stays async so callers and assert.rejects
    // do not have to care which runtime is underneath.
    const ctx = createCircuitContext(this.address, COIN_PK, this.state, privateState);
    const res = this.contract.impureCircuits[circuit](ctx, ...args);
    this.state = res.context.currentQueryContext.state;
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

// ---------------------------------------------------------------- desk shapes
// A "maker" here is {sk, price, maxSize, nonce, expiry}. These four helpers were
// copied into the tests, the CLI demo and the web app before being lifted here.

export const DEFAULT_EXPIRY = 10n;

export const termsOf = (m, over = {}) => ({
  price: m.price,
  maxSize: m.maxSize,
  expiry: m.expiry ?? DEFAULT_EXPIRY,
  makerId: pureCircuits.makerIdOf(m.sk),
  ...over,
});

// What a maker holds locally when it seals a quote.
export const makerState = (m, over = {}) => ({
  ...emptyPrivateState(),
  makerSecret: m.sk,
  quoteToPost: termsOf(m, over),
  quoteNonce: m.nonce,
});

// One opening in the taker's book.
export const slotOf = (m, over = {}) => ({
  terms: termsOf(m, over),
  nonce: m.nonce,
  live: true,
});

// What a taker holds locally when it fills.
export const takerState = (book, size, limit, idx) => ({
  ...emptyPrivateState(),
  receivedQuotes: book,
  takerOrder: [size, limit],
  chosenIndex: idx,
});

export { pureCircuits };
