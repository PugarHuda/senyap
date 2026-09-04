# Senyap

**Sealed-quote RFQ on Midnight.** Makers post quotes the chain cannot read. Takers prove they filled the best one. Losing prices are never published, and a quote that has been committed cannot be walked back.

*Senyap* is Indonesian for hushed — the sound a market makes when nobody can hear your order.

Built for the Midnight Buildathon, Wave 1.

![Senyap taker console](docs/screenshot.png)

---

## The problem

Request-for-quote is how large trades actually happen, and its defining failure is information leakage.

Ask five market makers to price 10,000 ETH and all five now know a large seller exists. Four of them lose the trade and keep the information. They can widen, trade ahead, or simply remember. This is why dark pools exist in traditional finance, and why the largest crypto flow still routes through chat windows rather than on-chain venues.

The second failure is *last look*. In FX and crypto RFQ a maker may see the taker accept, then decline if the market has moved. The taker carries all the optionality and pays for none of it. It survives because a quote sent over a chat window is not binding.

Senyap addresses both, and the mechanism is the same in each case: a quote is a cryptographic commitment.

- A commitment binds the maker. The price cannot change after the taker accepts, so there is no last look.
- A commitment reveals nothing. The chain stores a hash, so the losing quotes stay sealed forever.

## What is actually proven

The taker holds the openings for every quote it received, sent off-chain by the makers. It then proves, in circuit:

1. Every quote in its book corresponds to a commitment that really is live on the ledger.
2. The quote it consumed has the best price among them.
3. That price satisfies the taker's own limit, and the quote covers the taker's size.
4. The quote has not expired and has not already been filled.
5. Settlement happens at exactly the committed price.

The chain learns one number: the price that traded.

## Dual-ledger model

Midnight splits state in two. Getting the line in the right place *is* the design.

| Public ledger — on chain, anyone can recompute | Private state — witness, never leaves the machine |
| --- | --- |
| `quotes` — sealed quote commitments | quote `price` and `maxSize` |
| `spent` — nullifiers of filled quotes | maker secret key and inventory |
| `makers` — authorised maker ids | taker order `size` |
| `fills` — how many trades cleared | taker `limitPrice` |
| `referencePrice`, `bandBps` — the public band | the openings the taker received |
| `lastFillPrice` — the print, winner only | which slot the taker chose |
| `epoch` — the expiry clock | |

Two decisions in that table are worth calling out.

**The price band is checked against a sealed price.** `postQuote` enforces `|price − mid| × 10000 ≤ mid × bandBps` without the price ever becoming public. The venue proves a quote is honest relative to the public mid while learning nothing about it. This is the clearest example on the contract of doing real work on data you cannot see.

**There is no division anywhere in the contract.** The band check is written in multiplication form. A division would either need a non-zero proof or silently truncate, and both are soundness bugs rather than style problems.

## Private state management

Private state is modelled as one actor's local vault, and every witness is a single read out of it (`test/harness.js`):

```js
const witnesses = {
  makerSecret:    (ctx) => [ctx.privateState, ctx.privateState.makerSecret],
  quoteToPost:    (ctx) => [ctx.privateState, ctx.privateState.quoteToPost],
  quoteNonce:     (ctx) => [ctx.privateState, ctx.privateState.quoteNonce],
  takerOrder:     (ctx) => [ctx.privateState, ctx.privateState.takerOrder],
  receivedQuotes: (ctx) => [ctx.privateState, ctx.privateState.receivedQuotes],
  chosenIndex:    (ctx) => [ctx.privateState, ctx.privateState.chosenIndex],
};
```

Each call names its actor's vault explicitly. A maker and a taker never share one, which is the point: the maker's price is not reachable from the taker's process, and the chain sees neither.

## Circuits

| Circuit | Who | What it enforces |
| --- | --- | --- |
| `postQuote` | maker | authorised maker, quote bound to that maker, positive size, unexpired, inside the public band. Emits a sealed commitment. |
| `takeQuote` | taker | all three checks above plus best execution, limit, size coverage, expiry, and a fresh nullifier. Prints the winning price only. |
| `cancelQuote` | maker | ownership is proved from the secret key, not asserted. |
| `registerMaker` | venue | admits a maker id. |
| `setReference` | venue | publishes the mid and the band. |
| `tick` | venue | advances the expiry clock. |

## Two soundness holes that were closed

Both were found while writing the tests, and both are the kind that leave a contract looking correct.

**Fabricated competition.** Best execution originally checked only the quote being consumed. A taker could invent a terrible quote nobody posted, put it in its book, and manufacture a best-execution proof against fictional competition. `takeQuote` now verifies *every* live slot against the ledger. Test: `a fabricated competing quote is refused`.

**A padding slot that wins.** The book is a fixed three slots, so unused slots are padding. Padding priced at zero would beat every real quote and be selectable. Padding now prices at the `Uint<64>` ceiling and the chosen slot must be `live`. Tests: `a padding slot can never be chosen`, `a padding slot never wins the price comparison`.

A third was caught by the compiler rather than by us. Writing the ledger check as `!live || quotes.member(...)` lets short-circuit evaluation skip the read for padding slots, and *whether the read happens* is itself observable — it leaks how many real quotes were in the book. The disclosure analysis rejected it. All three reads are now unconditional.

## A test that passed for the wrong reason

The privacy test originally scanned `JSON.stringify(state)` for the losing prices and found nothing. It found nothing because a `ChargedState` serialises to a wasm pointer and nothing else. Every assertion in it was vacuously true.

The fix was not a better scan, it was a **positive control**. The test now asserts the winning price *is* present in the dump before asserting the losing ones are absent. A scan that cannot see the price that traded fails loudly instead of passing quietly.

Taker size gets a different treatment. A one-byte value has no searchable encoding, so a substring scan would prove nothing. Instead the test runs the same fill twice with different private orders and asserts the resulting public state is byte-identical — indistinguishability rather than absence.

## Running it

Requires the Compact toolchain. On Windows use WSL2; the compiler is Linux-only.

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
compact update
```

Then:

```bash
npm install
npm run build   # compact compile src/senyap.compact src/managed/senyap
npm test        # 22 tests
npm run demo    # the end-to-end walkthrough

npm run build:web && npm run dev   # the taker console
npm run verify:web                 # drives the built page in real Chrome
```

`npm run demo` prints the private side, the public ledger, a leak scan with its control, and the four refusals.

The web console runs the same compiled circuits in the browser. Nothing on that page is validated in JavaScript first — when the UI says REFUSED, that string is the assert that failed inside the circuit. `npm run verify:web` drives it in headless Chrome and fails on any console error, because a successful `vite build` only proves the wasm bundled, not that it executes.

### Toolchain notes

Measured on this build, since both cost time to find:

- Compiler **0.34.0** pairs with `@midnight-ntwrk/compact-runtime` **0.19.0**. The compiler writes its expected `runtime-version` into `src/managed/senyap/compiler/contract-info.json`; match it there rather than guessing. This toolchain resolves `onchain-runtime-v4`, so the `v3` version clash reported by other Buildathon teams does not apply here.
- Ubuntu 26.04 minimal ships without `unzip`, and `compact update` fails with `Failed to spawn artifact extraction command` — an error that never mentions the missing binary. `sudo apt install -y unzip` fixes it.

## Test coverage

22 tests, all passing, none skipped or stubbed.

```
happy path      4   deploy, maker registration, quotes seal, best quote fills
privacy         2   losing prices absent with a positive control; size indistinguishable
refusals        8   fade, not-best, over-limit, undersized, expired, double-fill,
                    fabricated competitor, padding selection
maker guards    5   unauthorised, out-of-band, wrong maker id, cancel, cancel by impostor
primitives      3   commitment binding, nullifier domain separation, padding price
```

## Limits, stated plainly

- **Fills are all-or-nothing.** A quote is consumed whole. Partial fills need a residual commitment.
- **Losing commitments are disclosed at fill time.** Their *prices* never are, and they were already public when posted, but the fill links them into one RFQ. Unlinkable membership needs a `MerkleTree` proof instead of a `Set` lookup.
- **The book is three slots.** ZK circuits need fixed bounds. Widening it is a constant, not a redesign.
- **Settlement is not custody.** Senyap proves a match is valid and binding. It does not move assets. This is a price-discovery layer, not a DEX.
- **`registerMaker` is open and `tick` is manual.** Both are demo scaffolding, marked in the source. Neither is load-bearing for the privacy claim.
- **Not yet deployed to preprod.** Everything above runs against the compiled circuits in the local simulator.

## Named deltas for Wave 2

Stated in advance so progress can be measured against them:

1. Deploy to Midnight preprod and wire the demo to the deployed contract.
2. Replace the `Set` membership check with a `MerkleTree` proof, so losing commitments stay unlinkable at fill time.
3. Partial fills via residual commitments.
4. A taker-facing frontend over the deployed contract.

## Prior art

Sealed-quote and dark-pool matching are not new — Renegade on Arbitrum and Penumbra in Cosmos both build in this space. Neither exists on Midnight. What is specific here is the mapping onto Midnight's dual-ledger model: a price band enforced against a sealed price, and best execution proved against on-chain commitments.

## Licence

Apache 2.0. See [LICENSE](LICENSE).

Built on [Midnight](https://docs.midnight.network/) with the Compact toolchain.
