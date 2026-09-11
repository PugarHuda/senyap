# Senyap — submission text

**Tagline:** Sealed-quote RFQ and private OTC on Midnight. Makers post quotes
the chain cannot read; takers prove they filled the best one.

**Categories:** Market Infrastructure · DeFi · Privacy

---

## What it is

Request-for-quote is how large trades actually happen, and its defining failure
is information leakage. Ask five market makers to price 10,000 ETH and all five
now know a large seller exists. Four lose the trade and keep the information.
The second failure is *last look*: a maker sees the taker accept, then declines
if the market moved. Both survive because a quote sent over a chat window is
not binding.

Senyap makes a quote a cryptographic commitment. A commitment binds the maker,
so the price cannot change after acceptance. A commitment reveals nothing, so
losing quotes stay sealed forever.

This is the OTC shape. Block trades are negotiated off-book precisely because
putting them on one moves the price against you, and the settled trade is the
only part anyone else is entitled to see. Senyap keeps the negotiation sealed
and the print public — with the maker's quote made binding, which chat windows
never managed.

What the taker proves, in circuit: every quote in its book is under the
on-chain quote tree; the one it consumed has the best price among them; that
price satisfies its own limit and covers its size; the quote has not expired or
been filled; settlement is at exactly the committed price. The chain learns one
number — the price that traded.

Most privacy demos prove a predicate over one hidden value: age ≥ 18, balance ≥
threshold. Senyap proves a **relation across a set** of hidden values, which is
what makes best execution hard and what makes it worth doing on Midnight.

## Live

| | |
| --- | --- |
| Taker console | https://senyap.vercel.app |
| Contract (preprod) | `039be0bd3efb108ed649179e0e3b26666a27140bd4bbf64e7d13e813aa9bf3b6` |
| Fill tx | `ad17396ba677bb56f9c7b58ddd098050edef76f34b704406ba47d13c7e2e0f52`, block 2,497,257 |
| Repository | *(add before submitting)* |

`npm run live` runs a whole RFQ against that contract — the venue publishes the
band, three makers register and seal a quote each, the taker fills. Eight
transactions, each a real proof against the live ledger. What the chain held
afterwards, read back from the indexer rather than from the process that wrote
it:

```
quote tree root  52343dfb...0f96
leaves           4          three sealed quotes, plus the residual
fills            1
nullifiers       1
lastFillPrice    995        maker B, the best of the three

present    995  maker B - won      <- the control
absent    1010  maker A - lost
absent    1030  maker C - lost
```

The console runs the compiled circuits in the browser. Nothing on that page is
validated in JavaScript first: when it says REFUSED, that string is the assert
that failed inside the circuit. Five attack buttons sit next to the fill button
rather than being hidden away.

Verify the contract without trusting this repo:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"query":"{contractAction(address:\"039be0bd3efb108ed649179e0e3b26666a27140bd4bbf64e7d13e813aa9bf3b6\"){__typename address transaction{hash block{height}}}}"}' \
  https://indexer.preprod.midnight.network/api/v4/graphql
```

## What shipped

**The contract.** Six circuits on the pinned ledger-v8 toolchain. Quotes live
in a `HistoricMerkleTree<10, Bytes<32>>`; nullifiers in a `Set`. The band check
enforces `|price − mid| × 10000 ≤ mid × bandBps` against a price the chain
never sees — real arithmetic on data it cannot read. There is no division
anywhere in the contract: a division would need a non-zero proof or silently
truncate, and both are soundness bugs rather than style problems.

**Membership that hides participation, not just value.** The first version kept
quotes in a `Set` and proved membership with `quotes.member(c)`. That works and
it leaks: to show its book was real the taker had to name every commitment it
held, so a fill published *which makers were asked* even though their prices
stayed sealed. Quotes now live in a Merkle tree and the taker supplies a path.
Only the recomputed root is disclosed, never the path — a path carries the
leaf's position, and the position says when the quote was posted.

**Partial fills.** A fill takes `size` and appends the remainder as a fresh
commitment under a derived nonce, so the maker reconstructs the residual
opening from its own records without hearing from the taker. The residual is
appended even when nothing is left, because a conditional insert would publish
whether each trade was partial.

**34 tests**, none skipped or stubbed, running the compiled circuits in process.
Most of them assert refusals, and every assert in the contract has one — all 19
distinct refusal messages appear in a test that expects them. Three of those
tests exist because an audit found the guards had no coverage, including the
leaf binding that stops a taker proving three real quotes exist while its book
holds something else.

## Three things we got wrong, and how they were caught

**A privacy test that passed for the wrong reason.** It scanned
`JSON.stringify(state)` for the losing prices and found nothing — because a
`ChargedState` serialises to a wasm pointer and nothing else. Every assertion
in it was vacuously true. The fix was not a better scan but a **positive
control**: the test now asserts the winning price *is* present before asserting
the losing ones are absent. A scan that cannot see the price that traded fails
loudly instead of passing quietly.

**Fabricated competition.** Best execution originally checked only the quote
being consumed, so a taker could invent a terrible quote nobody posted and
manufacture a proof against fictional competition. Every slot is now checked
against the ledger.

**A padding slot that wins.** Unused book slots priced at zero would beat every
real quote. Padding now prices at the `Uint<64>` ceiling and the chosen slot
must be live. With the Merkle change padding had to go further: every slot is
checked unconditionally, so padding is now a copy of a real quote with the
light off — checking paths only for live slots would publish how many there
were.

## What it does not do, stated plainly

- **A partial fill moves the public state.** The residual commitment differs
  with the size taken, so the byte-identical property holds only across fills of
  equal size. The residual is a hiding commitment, so the size is not readable
  from it — but that is a cryptographic assumption, not something the leak scan
  demonstrates. The earlier README claimed the stronger property; it no longer
  does.
- **The book is three slots.** ZK circuits need fixed bounds. Widening it is a
  constant, not a redesign.
- **Settlement is not custody.** Senyap proves a match is valid and binding. It
  does not move assets. This is a price-discovery layer, not a DEX.
- **`registerMaker` is open and `tick` is manual.** Demo scaffolding, marked in
  the source, not load-bearing for the privacy claim.
- **The console runs the circuits locally.** It reads the deployed contract's
  public state from the indexer, but proving from the browser against preprod
  needs a wallet bridge, which is next.

## Two contracts we lost

`deployContract` writes private state only *after* the deploy transaction has
succeeded on chain. A private-state store that rejects its password therefore
throws once the contract already exists — and the address goes with the
exception. That happened twice before the password was right: once because it
read an environment variable the seed does not live in, once because the raw
hex seed is two character classes where the store wants three.

So there are two orphaned Senyap contracts on preprod that nothing references.
Harmless, untidy, and worth saying out loud. The deploy now proves the store
works with a write and a delete before it submits anything, while failing is
still free.

## One more bug worth naming

Call transactions never reached the chain, and for five runs it looked like a
slow network. It was the wallet SDK's dust balancer: a fixed-point loop with no
iteration cap, which selects coins to cover the fee and then recomputes the fee
*including the cost of the inputs it just selected*. Coverage is therefore
always one step behind, and on a call transaction — larger than a deploy,
because it carries a proof — the fee grows by the cost of each added input and
the loop never terminates.

It runs through `Effect.runSync`, so it blocks the event loop: no timer fires,
nothing logs, and a stall is indistinguishable from slowness. Bisecting the
three sub-balancers found it — unshielded alone finishes in a second and the
node then rejects the unpaid transaction with `Custom error: 138`; dust alone
panics in wasm with `unreachable`; together they loop. Asking for more fee
overhead than needed puts the first selection above the final fee, and the
fixed point is reached at once.

## The toolchain, because it cost real time

The compiler you get by default is not the one that deploys. `compact update`
installs 0.34.0, which emits runtime 0.19 / `onchain-runtime-v4` / ledger v9,
and the only `midnight-js` that speaks v4 is a beta whose wallet SDK ships
canary-only. The stable line is v8 all the way down: compiler **0.31.1**,
compact-runtime **0.16.0**, midnight-js **4.1.1**, wallet SDK **1.2.0**.

Two copies of `onchain-runtime-v3` is two wasm modules and two `StateValue`
classes, so a value built by one fails `instanceof` in the other. An npm
`overrides` entry does not fix it — npm keeps two physical copies of the same
version — `npm dedupe` does.

## Next

1. A wallet bridge so the console can prove against preprod, not only read it.
2. Widen the book past three slots.
3. Unlinkable residuals, so repeated partial fills of one quote cannot be
   chained together by an observer.
4. Read block time instead of the manual `tick`, and gate `registerMaker`.
