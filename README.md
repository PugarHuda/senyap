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

1. Every quote in its book is under the on-chain quote tree — proved by a path, so the chain never learns which leaf.
2. The quote it consumed has the best price among them.
3. That price satisfies the taker's own limit, and the quote covers the taker's size.
4. The quote has not expired and has not already been filled.
5. Settlement happens at exactly the committed price.

The chain learns one number: the price that traded.

## Dual-ledger model

Midnight splits state in two. Getting the line in the right place *is* the design.

| Public ledger — on chain, anyone can recompute | Private state — witness, never leaves the machine |
| --- | --- |
| `quotes` — a Merkle tree of sealed commitments | quote `price` and `maxSize` |
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

Private state is modelled as one actor's local vault, and almost every witness is a single read out of it (`src/venue.js`):

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

The one exception earns its place. `quotePaths` is not read out of the vault at
all — it is derived from the public tree:

```js
quotePaths: (ctx) => [ctx.privateState, ctx.privateState.receivedQuotes.map(
  (s) => pathFor(ctx.ledger, pureCircuits.commitmentOf(s.terms, s.nonce)))],
```

That is the right shape for it. A membership path is public information about a
public tree; what is private is *which* path you hold, and that never leaves the
circuit. A real client does the same thing against `queryContractState`.

Each call names its actor's vault explicitly. A maker and a taker never share one, which is the point: the maker's price is not reachable from the taker's process, and the chain sees neither.

## Circuits

| Circuit | Who | What it enforces |
| --- | --- | --- |
| `postQuote` | maker | authorised maker, quote bound to that maker, positive size, unexpired, inside the public band. Emits a sealed commitment. |
| `takeQuote` | taker | a membership path for every slot, best execution, limit, size coverage, expiry, and a fresh nullifier. Appends the residual. Prints the winning price only. |
| `cancelQuote` | maker | ownership is proved from the secret key, not asserted. Nullifies rather than deletes. |
| `registerMaker` | venue | admits a maker id. |
| `setReference` | venue | publishes the mid and the band. |
| `tick` | venue | advances the expiry clock. |

## From a Set to a Merkle tree

The first version kept live quotes in a `Set<Bytes<32>>` and proved membership
with `quotes.member(c)`. That works, and it leaks. To show its book was real the
taker had to name every commitment it held, so the fill published the losing
quotes as *participants* even though their prices stayed sealed. Anyone watching
could see which three makers were asked, and that is most of what an RFQ is
trying not to say.

Quotes now live in a `HistoricMerkleTree<10, Bytes<32>>`. The taker supplies a
path per slot, the circuit recomputes the root, and only the root is disclosed:

```compact
assert(quotes.checkRoot(disclose(merkleTreePathRoot<10, Bytes<32>>(paths[0]))),
       "slot 0 is not a live on-chain quote");
```

Three details in that one line took the most work.

**Only the root is disclosed, never the path.** The obvious spelling is
`disclose(path)` and it type-checks. It is also wrong: a path carries the
sibling hashes *and* the leaf's position, and the position says when the quote
was posted. Disclosing the recomputed root instead gives the ledger exactly what
it needs to check and nothing else.

**Historic, not plain.** A `MerkleTree` changes its root on every insert, so a
path built when the taker assembled its book would stop verifying the moment any
other maker posted. `HistoricMerkleTree` keeps recent roots valid, which is what
makes the proof usable by someone who is not the last writer.

**Padding had to change shape.** Every slot is checked unconditionally — the
short-circuit lesson below still applies — so padding needs a path that
verifies. An all-zero slot has none. Padding is now a copy of a real quote with
`live: false`: a genuine proof, still unselectable, still losing every price
comparison. The alternative was checking paths only for live slots, which would
publish how many of them there were.

A tree cannot delete, so two things follow. A filled quote's leaf stays where it
is and the nullifier does the work — which was always true, the removal was
decoration. And a cancel is now a nullifier as well, which means the chain
cannot tell a cancelled quote from a filled one.

## Partial fills

A taker takes `size` out of a quote and the circuit appends the rest as a fresh
commitment. The residual nonce is derived, not chosen:

```compact
persistentHash<Vector<2, Bytes<32>>>([pad(32, "senyap:residual:v1"), nonce])
```

so the maker can reconstruct the residual opening from its own records. It never
has to hear back from the taker to keep the remainder of its quote sellable.

The residual is inserted whether or not anything is left. A full fill appends
the commitment of a zero-size quote, which no later fill can consume because
`takeQuote` requires a positive size. Making the insert conditional would have
been cheaper and would have published, on every trade, whether it was partial.

## Two soundness holes that were closed

Both were found while writing the tests, and both are the kind that leave a contract looking correct.

**Fabricated competition.** Best execution originally checked only the quote being consumed. A taker could invent a terrible quote nobody posted, put it in its book, and manufacture a best-execution proof against fictional competition. `takeQuote` now verifies *every* live slot against the ledger. Test: `a fabricated competing quote is refused`.

**A padding slot that wins.** The book is a fixed three slots, so unused slots are padding. Padding priced at zero would beat every real quote and be selectable. Padding now prices at the `Uint<64>` ceiling and the chosen slot must be `live`. Tests: `a padding slot can never be chosen`, `a padding slot never wins the price comparison`.

A third was caught by the compiler rather than by us. Writing the ledger check as `!live || quotes.member(...)` lets short-circuit evaluation skip the read for padding slots, and *whether the read happens* is itself observable — it leaks how many real quotes were in the book. The disclosure analysis rejected it. All three reads are now unconditional.

## A test that passed for the wrong reason

The privacy test originally scanned `JSON.stringify(state)` for the losing prices and found nothing. It found nothing because a `ChargedState` serialises to a wasm pointer and nothing else. Every assertion in it was vacuously true.

The fix was not a better scan, it was a **positive control**. The test now asserts the winning price *is* present in the dump before asserting the losing ones are absent. A scan that cannot see the price that traded fails loudly instead of passing quietly.

The taker's limit gets a different treatment. It has no searchable encoding, so a substring scan would prove nothing. Instead the test runs the same fill twice with different limits and asserts the resulting public state is byte-identical — indistinguishability rather than absence.

The fill size used to get that treatment too, and no longer can: partial fills mean the size moves the residual commitment. The test that claimed otherwise was changed rather than deleted — it now asserts that the difference is confined to that one leaf and every named public field is unchanged. What hides the size after that is the commitment being hiding, which is an assumption, not a demonstration. Saying so is cheaper than a test that quietly stops meaning anything.

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
npm test        # 28 tests
npm run demo    # the end-to-end walkthrough

npm run build:web && npm run dev   # the taker console
npm run verify:web                 # drives the built page in real Chrome
```

`npm run demo` prints the private side, the public ledger, a leak scan with its control, and the four refusals.

The web console runs the same compiled circuits in the browser. Nothing on that page is validated in JavaScript first — when the UI says REFUSED, that string is the assert that failed inside the circuit. `npm run verify:web` drives it in headless Chrome and fails on any console error, because a successful `vite build` only proves the wasm bundled, not that it executes.

### On chain

Senyap is deployed to Midnight preprod, and a whole RFQ has been run through it.

| | |
| --- | --- |
| Console | <https://senyap.vercel.app> |
| Contract | `039be0bd3efb108ed649179e0e3b26666a27140bd4bbf64e7d13e813aa9bf3b6` |
| Fill tx | `ad17396ba677bb56f9c7b58ddd098050edef76f34b704406ba47d13c7e2e0f52`, block 2,497,257 |

`npm run live` drives that contract: the venue publishes the band, three makers
register and seal a quote each, and the taker fills. Eight transactions, each
one a real proof against the live ledger. What the chain held afterwards, read
back from the indexer rather than from the process that wrote it:

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

Confirm it independently, without trusting anything in this repo:

```bash
curl -s -X POST -H 'Content-Type: application/json'   -d '{"query":"{contractAction(address:\"039be0bd3efb108ed649179e0e3b26666a27140bd4bbf64e7d13e813aa9bf3b6\"){__typename address transaction{hash block{height}}}}"}'   https://indexer.preprod.midnight.network/api/v4/graphql
```

### Deploying

`npm run deploy` puts the contract on a real network. It defaults to preprod
and takes everything else from the environment:

| variable | default |
| --- | --- |
| `MIDNIGHT_SEED` | whatever is in `.wallet/<network>.seed`, generated on first run |
| `MIDNIGHT_NETWORK` | `preprod` |
| `MIDNIGHT_INDEXER` | `https://indexer.preprod.midnight.network/api/v4/graphql` |
| `MIDNIGHT_NODE` | `wss://rpc.preprod.midnight.network` |
| `MIDNIGHT_PROOF_SERVER` | `http://127.0.0.1:6300` |

Three things have to be true before it can work, and none of them are code.

**A proof server is running.** Proving happens on your machine, not on the node.

```bash
docker run -p 6300:6300 midnightntwrk/proof-server:8.1.0 midnight-proof-server -v
```

**The wallet holds NIGHT.** The preprod faucet is at
<https://midnight-tmnight-preprod.nethermind.dev/> and sends 1,000 tNIGHT per
request, behind a Cloudflare Turnstile check, so this step is a human with a
browser. `npm run deploy` prints the Night address before it does anything
slow, and stops if the balance is zero.

**That NIGHT is registered for DUST generation.** Fees are paid in DUST, which
NIGHT only generates after an explicit on-chain registration of its UTXOs. A
funded but unregistered wallet cannot pay for anything.

The circularity here is only apparent — a registration transaction costs a fee
the wallet cannot yet pay — and the resolution is worth stating: unregistered
NIGHT still accrues *projected* dust from the moment it lands. So the deploy
estimates the registration fee, waits for the projection to cover it, submits
the registration, and tells you to come back once DUST has actually accrued.
It does this automatically rather than failing somewhere inside transaction
balancing with a message about coin selection.

Sync is the slow part, and worth describing because the numbers are not
obvious. The three sub-wallets — shielded, unshielded, dust — scan the chain
independently and `isSynced` is the AND of all three, so the run prints each
one's progress rather than sitting silent. Preprod is about 1.5M events deep.
The shielded wallet applies them in a couple of minutes; the dust wallet
manages roughly 16k a minute, which is an hour and a half. Raising the sync
batch size from its default of 10 helps the shielded side a great deal and the
dust side barely at all, so the fix is not to do it twice: after a cold sync
every sub-wallet's state is serialised into `.wallet/`, and later runs restore
and catch up instead. Long syncs also checkpoint every five minutes.

That checkpoint is not a nicety. On a 16GB machine the cold sync does not
finish in one process: the wallet grows as it applies events and the run is
killed for memory somewhere past the million mark, repeatedly. Capping the V8
heap does not help, because the ledger's wasm memory is not part of it.
Shrinking the indexer's in-flight event queue from its default of 10,000 does
help, and helps throughput too — less garbage, less collection — but the run
still dies. What actually gets you to a synced wallet is running `npm run
deploy` again: each attempt advances a couple of hundred thousand events and
checkpoints them, so the sync completes across several processes rather than
one. Restarting is the design, not a workaround.

Nothing is balanced until all three are complete: a half-synced wallet picks
coins that were already spent.

Two things in `cli/deploy.js` are not the documented way to do it, and both are
there because the documented way does not work.

**The facade gets its own submission service.** The SDK's node client closes its
websocket after loading metadata and reopens one per operation. Against preprod
that dance loses the race: `.send()` rejects with `disconnected … 1000:: Normal
Closure` and nothing reaches the chain, deterministically, on every attempt.
The node itself is fine — a plain `WsProvider` connects, reports `Midnight
Preprod`, and stays up. So the facade is handed a submission service that holds
one connection open, and the same transaction that failed six times went
`Ready → Broadcast → InBlock` on the first try.

**The private state store is proved to work before anything is submitted.**
`deployContract` writes private state only *after* the deploy transaction has
succeeded, so a store that rejects its password throws when the contract
already exists — and the address goes with the exception. Two contracts were
lost that way before the password was right. The store now takes a write and a
delete first, while a failure is still free. The password itself is derived
rather than raw: the store demands three of four character classes and a hex
seed is two.

### Toolchain notes

The version matrix cost real time to work out, so here it is.

The compiler you get by default is not the one that deploys. `compact update`
installs the newest compiler — 0.34.0 at the time of writing — and that emits
`runtime-version` 0.19.0, which resolves `onchain-runtime-v4` and ledger v9. The
only `midnight-js` that speaks v4 is `5.0.0-beta.7`, and the only wallet SDK
that pairs with it is canary-tagged. That is two layers of pre-release under a
deploy.

The stable line is entirely v8:

| | version | pulls |
| --- | --- | --- |
| Compact compiler | **0.31.1** | runtime 0.16.0 |
| `@midnight-ntwrk/compact-runtime` | **0.16.0** | `onchain-runtime-v3` |
| `@midnight-ntwrk/midnight-js` | **4.1.1** | ledger-v8, compact-runtime 0.16.0 |
| `@midnight-ntwrk/wallet-sdk` | **1.2.0** | wallet-sdk-facade 4.1.0, ledger-v8 |

The four provider packages — `midnight-js-indexer-public-data-provider`,
`-http-client-proof-provider`, `-node-zk-config-provider` and
`-level-private-state-provider` — are versioned in lockstep with `midnight-js`
and are all pinned to 4.1.1 as well.

This build is pinned to that line. The contract compiles under both compilers
with no source change at all, so the pin lives in `build.sh` rather than in the
`.compact` file.

Two API differences bite when moving between them, and neither is mentioned in
an error message:

- `createCircuitContext` takes a `circuitId` first argument in 0.19 and does not
  in 0.16. Pass the 0.19 argument list to 0.16 and everything shifts one place,
  surfacing as `'contractState' parameter [object Object] has unexpected type`.
- Circuits are `async` in 0.19 and synchronous in 0.16. The context they return
  is nested under `callContext` in 0.19 and flat in 0.16.

Also worth knowing: Ubuntu 26.04 minimal ships without `unzip`, and
`compact update` then fails with `Failed to spawn artifact extraction command`,
an error that never names the missing binary. `sudo apt install -y unzip`.

## Test coverage

28 tests, all passing, none skipped or stubbed.

```
happy path      4   deploy, maker registration, quotes seal, best quote fills
privacy         3   losing prices absent with a positive control; limit
                    indistinguishable; fill size confined to a hiding commitment
partial fills   4   residual is sellable, cannot be overdrawn, a full fill leaves
                    an unfillable residual, a zero fill is refused
refusals        8   fade, not-best, over-limit, undersized, expired, double-fill,
                    fabricated competitor, padding selection
maker guards    6   unauthorised, out-of-band, wrong maker id, cancel, cancel by
                    impostor, cancelled quote cannot be filled
primitives      3   commitment binding, nullifier domain separation, padding price
```

## Limits, stated plainly

- **A partial fill moves the public state; a full one does not have to.** The residual commitment differs with the size taken, so the byte-identical property now holds only across fills of equal size. The residual is a hiding commitment, so the size is not readable from it, but that is a cryptographic assumption rather than something the leak scan can demonstrate. Stated because the older README claimed the stronger property.
- **The book is three slots.** ZK circuits need fixed bounds. Widening it is a constant, not a redesign.
- **Settlement is not custody.** Senyap proves a match is valid and binding. It does not move assets. This is a price-discovery layer, not a DEX.
- **`registerMaker` is open and `tick` is manual.** Both are demo scaffolding, marked in the source. Neither is load-bearing for the privacy claim.
- **The console reads the chain but does not write to it.** `npm run live` drives the deployed contract end to end from Node. The hosted console runs the same circuits in the browser against a local simulator and reads the deployed contract's public state; proving from the browser needs a wallet bridge, which is not built.

## Named deltas for Wave 2

Stated in advance so progress can be measured against them:

1. ~~Deploy to Midnight preprod and wire the demo to the deployed contract.~~ Done — `npm run live`, eight transactions, see *On chain*.
2. ~~Replace the `Set` membership check with a `MerkleTree` proof, so losing commitments stay unlinkable at fill time.~~ Done — see *From a Set to a Merkle tree*.
3. ~~Partial fills via residual commitments.~~ Done — see *Partial fills*.
4. A taker-facing frontend over the deployed contract. Half done: <https://senyap.vercel.app> runs the real circuits in the browser and reads the deployed contract's state from the indexer, but proving against preprod from the browser needs a wallet bridge.

## Prior art

Sealed-quote and dark-pool matching are not new — Renegade on Arbitrum and Penumbra in Cosmos both build in this space. Neither exists on Midnight. What is specific here is the mapping onto Midnight's dual-ledger model: a price band enforced against a sealed price, and best execution proved against on-chain commitments.

## Licence

Apache 2.0. See [LICENSE](LICENSE).

Built on [Midnight](https://docs.midnight.network/) with the Compact toolchain.
