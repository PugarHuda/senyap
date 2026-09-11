import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type QuoteTerms = { price: bigint;
                           maxSize: bigint;
                           expiry: bigint;
                           makerId: Uint8Array
                         };

export type QuoteSlot = { terms: QuoteTerms; nonce: Uint8Array; live: boolean };

export type Witnesses<PS> = {
  makerSecret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  quoteToPost(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, QuoteTerms];
  quoteNonce(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  takerOrder(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, [bigint,
                                                                          bigint]];
  receivedQuotes(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, QuoteSlot[]];
  chosenIndex(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint];
  quotePaths(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, { leaf: Uint8Array,
                                                                           path: { sibling: { field: bigint
                                                                                            },
                                                                                   goes_left: boolean
                                                                                 }[]
                                                                         }[]];
}

export type ImpureCircuits<PS> = {
  registerMaker(context: __compactRuntime.CircuitContext<PS>, id_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  tick(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  setReference(context: __compactRuntime.CircuitContext<PS>,
               price_0: bigint,
               band_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  postQuote(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, Uint8Array>;
  takeQuote(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  cancelQuote(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  registerMaker(context: __compactRuntime.CircuitContext<PS>, id_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  tick(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  setReference(context: __compactRuntime.CircuitContext<PS>,
               price_0: bigint,
               band_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  postQuote(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, Uint8Array>;
  takeQuote(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  cancelQuote(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
  makerIdOf(sk_0: Uint8Array): Uint8Array;
  commitmentOf(t_0: QuoteTerms, nonce_0: Uint8Array): Uint8Array;
  nullifierOf(c_0: Uint8Array): Uint8Array;
  residualNonceOf(nonce_0: Uint8Array): Uint8Array;
  effectivePrice(s_0: QuoteSlot): bigint;
  min2(a_0: bigint, b_0: bigint): bigint;
}

export type Circuits<PS> = {
  makerIdOf(context: __compactRuntime.CircuitContext<PS>, sk_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  commitmentOf(context: __compactRuntime.CircuitContext<PS>,
               t_0: QuoteTerms,
               nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  nullifierOf(context: __compactRuntime.CircuitContext<PS>, c_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  residualNonceOf(context: __compactRuntime.CircuitContext<PS>,
                  nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  effectivePrice(context: __compactRuntime.CircuitContext<PS>, s_0: QuoteSlot): __compactRuntime.CircuitResults<PS, bigint>;
  min2(context: __compactRuntime.CircuitContext<PS>, a_0: bigint, b_0: bigint): __compactRuntime.CircuitResults<PS, bigint>;
  registerMaker(context: __compactRuntime.CircuitContext<PS>, id_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  tick(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  setReference(context: __compactRuntime.CircuitContext<PS>,
               price_0: bigint,
               band_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  postQuote(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, Uint8Array>;
  takeQuote(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  cancelQuote(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  makers: {
    isEmpty(): boolean;
    size(): bigint;
    member(elem_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<Uint8Array>
  };
  quotes: {
    isFull(): boolean;
    checkRoot(rt_0: { field: bigint }): boolean;
    root(): __compactRuntime.MerkleTreeDigest;
    firstFree(): bigint;
    pathForLeaf(index_0: bigint, leaf_0: Uint8Array): __compactRuntime.MerkleTreePath<Uint8Array>;
    findPathForLeaf(leaf_0: Uint8Array): __compactRuntime.MerkleTreePath<Uint8Array> | undefined;
    history(): Iterator<__compactRuntime.MerkleTreeDigest>
  };
  spent: {
    isEmpty(): boolean;
    size(): bigint;
    member(elem_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<Uint8Array>
  };
  readonly fills: bigint;
  readonly referencePrice: bigint;
  readonly bandBps: bigint;
  readonly lastFillPrice: bigint;
  readonly epoch: bigint;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
