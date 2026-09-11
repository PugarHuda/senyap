# Senyap — submission text

**Tagline:** Sealed-quote RFQ on Midnight. Makers post quotes the chain cannot
read; takers prove they filled the best one.

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
| Repository | *(add before submitting)* |

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

**28 tests**, none skipped or stubbed, running the compiled circuits in process.
Most of them assert refusals.

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

1. Drive the deployed contract end to end from `cli/live.js` (written; blocked
   on a non-convergent fee loop in the wallet SDK's dust balancer).
2. A wallet bridge so the console can prove against preprod, not only read it.
3. Widen the book past three slots.
4. Unlinkable residuals, so repeated partial fills of one quote cannot be
   chained together by an observer.
