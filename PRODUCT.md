# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Market makers and the OTC desks that ask them for prices. The person opening the
console is weighing whether this could sit in their workflow — not learning what
zero-knowledge proofs are. They arrive knowing what a quote, a fill, a limit and
a print are, and they are unimpressed by explanation and persuaded by behaviour.

Hackathon judges read the same surface, but they are not who it is designed for.

## Product Purpose

Senyap is a request-for-quote venue where the quotes are sealed. A maker posts a
cryptographic commitment to its price; the taker collects openings off-chain and
proves, in circuit, that the quote it filled was the best one it held. The chain
learns one number: the price that traded.

It exists because RFQ leaks. Ask five makers to price a block and all five now
know a large order exists; four lose the trade and keep the information. And a
quote sent over a chat window is not binding, so a maker can decline after the
taker accepts — last look. A commitment fixes both: it binds the maker, and it
reveals nothing.

Success is a market participant reading the page and concluding the mechanism is
real, because they watched it refuse something that should be refused.

## Positioning

A venue that proves **best execution across a set of hidden prices**, not a
predicate over one hidden value. Most privacy tooling proves "x ≥ threshold" for
a single secret. Senyap proves a relation across several numbers nobody can see,
and enforces a public price band against a price that stays sealed.

A neighbouring product cannot truthfully copy the second half: the losing quotes
are never published, and their makers are not published either, because
membership is proved by Merkle path rather than by naming the commitment.

## Operating Context

A desk asks several makers for a price on a size. Quotes arrive off-book. The
desk picks one, and everyone else learns nothing. That is the ritual the product
has to fit; the chain is only where the binding and the print happen.

Running against the live network needs a Midnight wallet in the browser and a
proof server the browser can reach (Midnight proves client-side; there is no
hosted prover). Without both, the same circuits still run locally against a
simulator, and the page must say which of the two it is doing.

## Capabilities and Constraints

- Six circuits: `postQuote`, `takeQuote`, `cancelQuote`, `registerMaker`,
  `setReference`, `tick`.
- Quotes live in a `HistoricMerkleTree<10>`; spent quotes and cancelled quotes
  are both nullifiers, so on-chain the two are indistinguishable.
- The book is a fixed three slots. ZK circuits need fixed bounds.
- Partial fills append the remainder as a fresh commitment under a derived
  nonce, so the maker reconstructs the residual without hearing from the taker.
- Fills are proved, not settled: Senyap does not move assets.
- `registerMaker` is open and `tick` is manual — demo scaffolding, marked as
  such in the source.
- Terminology is the desk's, not the chain's: quote, fill, size, limit, mid,
  band, print, fade, last look, best execution.

## Brand Commitments

The name is **Senyap**, Indonesian for hushed — the sound a market makes when
nobody can hear your order. The user has made the Indonesian origin binding: it
should be felt on the page, not hidden behind a generic crypto identity.

Refusals are the product. When the interface says a thing is refused, that string
is the assert that failed inside the circuit, and the page must never perform a
refusal that JavaScript decided.

## Evidence on Hand

- Deployed on Midnight preprod: contract
  `039be0bd3efb108ed649179e0e3b26666a27140bd4bbf64e7d13e813aa9bf3b6`.
- A whole RFQ ran through it: eight transactions, fill in block 2,497,257,
  `lastFillPrice` 995, three quotes plus one residual under the tree root.
- 34 tests, none skipped, and every refusal message in the contract appears in a
  test that expects it.
- CI compiles the contract from source and checks the committed artifacts match
  byte for byte.
- Live console: <https://senyap.vercel.app>.

No customers, no volume, no benchmarks, no audit. Future work must not invent
any of these.

## Product Principles

1. **Show a refusal, not an explanation.** The mechanism is believed when it is
   watched rejecting something, so the attacks belong next to the action, not in
   a tab someone has to find.
2. **Say which chain you are on.** Local simulator and live preprod must never
   be confusable by a reader; every number carries where it came from.
3. **Desk vocabulary wins over chain vocabulary.** A market participant reads
   "print" and "fade", not "ledger field" and "nullifier", unless the chain term
   is the honest one.
4. **State limits in the same voice as capabilities.** What the venue does not
   do is part of what makes the rest credible.
5. **Nothing on the page is taken on trust.** Anything asserted has a way for the
   reader to check it themselves.

## Accessibility & Inclusion

WCAG AA contrast is a hard floor, and functional text stays at or above 11px.
The current implementation fails both — 22 contrast findings and 11 undersized
text findings — and that is a defect to fix, not a style to preserve.
