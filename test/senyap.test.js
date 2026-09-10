import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Senyap, emptyPrivateState, padWith, bytes32, pureCircuits, stateDump, leHex,
         termsOf, makerState, residualOf, slotOf, takerState } from '../src/venue.js';

// Public mid is 1000 with a 500 bps band, so a quote is only accepted in
// [950, 1050]. The band is checked against a sealed price: the contract proves
// the quote is sane without ever learning it.
const MID = 1000n, BAND = 500n, EXPIRY = 10n;

const MAKERS = {
  A: { sk: bytes32(11), price: 1010n, maxSize: 100n, nonce: bytes32(101) },
  B: { sk: bytes32(22), price:  995n, maxSize: 100n, nonce: bytes32(102) }, // best
  C: { sk: bytes32(33), price: 1030n, maxSize:  50n, nonce: bytes32(103) },
};





// A live venue: three authorised makers, three sealed quotes on the ledger.
async function venue() {
  const s = await Senyap.deploy();
  await s.call('setReference', emptyPrivateState(), MID, BAND);
  for (const m of Object.values(MAKERS)) {
    await s.call('registerMaker', emptyPrivateState(), pureCircuits.makerIdOf(m.sk));
    await s.call('postQuote', makerState(m));
  }
  return s;
}

const fullBook = () => [slotOf(MAKERS.A), slotOf(MAKERS.B), slotOf(MAKERS.C)];

// --------------------------------------------------------------- happy path

test('three sealed quotes reach the ledger without revealing a price', async () => {
  const s = await venue();
  const l = s.ledger();
  assert.equal(l.quotes.firstFree(), 3n);
  assert.equal(l.lastFillPrice, 0n, 'nothing has traded yet');
});

test('taker fills the best quote and only that price is printed', async () => {
  const s = await venue();
  await s.call('takeQuote', takerState(fullBook(), 40n, 1000n, 1n));
  const l = s.ledger();
  assert.equal(l.fills, 1n);
  assert.equal(l.lastFillPrice, 995n, 'the winning price is the print');
  assert.equal(l.spent.size(), 1n, 'the quote is consumed by its nullifier');
  // A tree cannot delete, so the filled leaf stays and a residual joins it.
  assert.equal(l.quotes.firstFree(), 4n, 'the residual was appended');
});

// ------------------------------------------------------------------ privacy

test('losing prices never appear anywhere in the public state', async () => {
  const s = await venue();
  await s.call('takeQuote', takerState(fullBook(), 40n, 1000n, 1n));

  // Field level. ledger() exposes the complete declared public surface, so this
  // is exhaustive over named state.
  const l = s.ledger();
  const publicNumbers = [l.fills, l.referencePrice, l.bandBps, l.lastFillPrice, l.epoch];
  for (const losing of [1010n, 1030n]) {
    assert.ok(!publicNumbers.includes(losing), `losing price ${losing} leaked into a ledger field`);
  }

  // Raw level, over the actual serialised on-chain state.
  const raw = stateDump(s);
  // Positive control, and it has to come first: if the scan cannot find the
  // price that did trade, the scan is broken and every "absent" below would be
  // vacuously true. An earlier version of this test passed for exactly that
  // reason - JSON.stringify on a ChargedState yields only a wasm pointer.
  assert.ok(raw.includes(leHex(995n)), 'scan is vacuous: the traded price is not in the dump');
  for (const losing of [1010n, 1030n]) {
    assert.ok(!raw.includes(leHex(losing)), `losing price ${losing} leaked into the raw state`);
  }
});

test('the public state is identical whatever the taker limit was', async () => {
  // Two fills that differ only in the taker's limit price must be byte-identical
  // on chain. A limit has no searchable encoding, so a substring scan would
  // prove nothing; indistinguishability is the honest test.
  const runWith = async (size, limit) => {
    const s = await venue();
    await s.call('takeQuote', takerState(fullBook(), size, limit, 1n));
    return stateDump(s);
  };
  assert.equal(await runWith(40n, 1000n), await runWith(40n, 1048n),
    'the public state moved with the taker limit, so the limit leaked');
});

test('the fill size moves the state, and only through a hiding commitment', async () => {
  // Stated plainly because partial fills cost the older, stronger property:
  // two fills of different sizes leave different residual commitments, so the
  // state is no longer byte-identical. What remains is that the difference is
  // confined to that one leaf - every named public field is unchanged - and the
  // leaf is a commitment, so recovering the size from it is the commitment
  // being broken, not a leak this contract can fix.
  const runWith = async (size) => {
    const s = await venue();
    await s.call('takeQuote', takerState(fullBook(), size, 1000n, 1n));
    return { dump: stateDump(s), l: s.ledger() };
  };
  const small = await runWith(40n);
  const large = await runWith(90n);

  assert.notEqual(small.dump, large.dump, 'the residual is meant to differ');
  for (const field of ['fills', 'referencePrice', 'bandBps', 'lastFillPrice', 'epoch']) {
    assert.equal(small.l[field], large.l[field], `${field} moved with the fill size`);
  }
  assert.equal(small.l.quotes.firstFree(), large.l.quotes.firstFree());
  assert.equal(small.l.spent.size(), large.l.spent.size());
});

// ------------------------------------------------------------ partial fills

test('a partial fill leaves a residual the maker can still sell', async () => {
  const s = await venue();
  // B quotes 995 for up to 100. The taker lifts 30 of it.
  await s.call('takeQuote', takerState(fullBook(), 30n, 1000n, 1n));

  // The maker never heard from the taker: it derives the residual opening from
  // its own nonce and hands it to the next taker off-chain.
  const rest = residualOf(MAKERS.B, 30n);
  assert.equal(rest.terms.maxSize, 70n);

  await s.call('takeQuote', takerState([rest], 70n, 1000n, 0n));
  const l = s.ledger();
  assert.equal(l.fills, 2n, 'both fills counted');
  assert.equal(l.lastFillPrice, 995n, 'the residual trades at the committed price');
  assert.equal(l.spent.size(), 2n);
});

test('a residual cannot be filled for more than is left of it', async () => {
  const s = await venue();
  await s.call('takeQuote', takerState(fullBook(), 30n, 1000n, 1n));
  await assert.rejects(
    s.call('takeQuote', takerState([residualOf(MAKERS.B, 30n)], 71n, 1000n, 0n)),
    /does not cover/,
  );
});

test('a fully consumed quote leaves a residual nobody can fill', async () => {
  const s = await venue();
  // The residual is inserted whether or not anything is left, so that a full
  // fill and a partial one look the same on chain. A zero-size residual is
  // unfillable because takeQuote requires a positive size.
  await s.call('takeQuote', takerState(fullBook(), 100n, 1000n, 1n));
  assert.equal(s.ledger().quotes.firstFree(), 4n, 'the residual leaf exists either way');
  await assert.rejects(
    s.call('takeQuote', takerState([residualOf(MAKERS.B, 100n)], 1n, 1000n, 0n)),
    /does not cover/,
  );
});

test('a fill of zero is refused', async () => {
  const s = await venue();
  await assert.rejects(
    s.call('takeQuote', takerState(fullBook(), 0n, 1000n, 1n)),
    /fill size must be positive/,
  );
});

// ------------------------------------------------ the refusals are the product

test('a maker cannot fade: settling off the committed price is refused', async () => {
  const s = await venue();
  // The taker tries to settle maker B at 990 instead of the committed 995.
  const book = [slotOf(MAKERS.A), slotOf(MAKERS.B, { price: 990n }), slotOf(MAKERS.C)];
  await assert.rejects(
    s.call('takeQuote', takerState(book, 40n, 1000n, 1n)),
    /not a live on-chain quote/,
  );
});

test('taking a worse quote than the best one held is refused', async () => {
  const s = await venue();
  await assert.rejects(
    s.call('takeQuote', takerState(fullBook(), 40n, 1100n, 0n)), // picks A at 1010
    /not best execution/,
  );
});

test('a fill worse than the taker limit is refused', async () => {
  const s = await venue();
  await assert.rejects(
    s.call('takeQuote', takerState(fullBook(), 40n, 900n, 1n)),
    /limit/,
  );
});

test('a quote that does not cover the taker size is refused', async () => {
  const s = await venue();
  // C is the only slot the taker declares, so it is trivially best, but it
  // caps at 50. takerState pads the book out with copies of C, lights off.
  await assert.rejects(
    s.call('takeQuote', takerState([slotOf(MAKERS.C)], 80n, 1100n, 0n)),
    /does not cover/,
  );
});

test('an expired quote is refused', async () => {
  const s = await venue();
  for (let i = 0; i < 10; i++) await s.call('tick', emptyPrivateState());
  await assert.rejects(
    s.call('takeQuote', takerState(fullBook(), 40n, 1000n, 1n)),
    /has expired/,
  );
});

test('the same quote cannot be filled twice', async () => {
  const s = await venue();
  await s.call('takeQuote', takerState(fullBook(), 40n, 1000n, 1n));
  // The leaf is still in the tree - a tree cannot delete - so what refuses the
  // second fill is the nullifier, which is the only thing that ever did.
  await assert.rejects(
    s.call('takeQuote', takerState(fullBook(), 40n, 1000n, 1n)),
    /already been filled/,
  );
});

test('a fabricated competing quote is refused', async () => {
  const s = await venue();
  // The soundness hole this closes: invent a terrible quote nobody posted, and
  // a mediocre real quote starts to look like best execution.
  const ghost = {
    terms: { price: 9999n, maxSize: 100n, expiry: EXPIRY, makerId: pureCircuits.makerIdOf(bytes32(99)) },
    nonce: bytes32(199), live: true,
  };
  await assert.rejects(
    s.call('takeQuote', takerState([slotOf(MAKERS.A), ghost], 40n, 1100n, 0n)),
    /slot 1 is not a live on-chain quote/,
  );
});

test('a padding slot can never be chosen', async () => {
  const s = await venue();
  await assert.rejects(
    s.call('takeQuote', takerState([slotOf(MAKERS.B)], 40n, 1000n, 1n)),
    /chosen slot is empty/,
  );
});

test('a padding slot never wins the price comparison', async () => {
  // Padding is now a copy of a real quote with the light off, so this matters
  // more than it used to: the terms are a genuine 995 and it still must lose.
  const dead = padWith(slotOf(MAKERS.B));
  assert.equal(pureCircuits.effectivePrice(dead), 18446744073709551615n);
  assert.equal(pureCircuits.min2(pureCircuits.effectivePrice(dead), 995n), 995n);
});

// -------------------------------------------------------------- maker guards

test('an unauthorised maker cannot post', async () => {
  const s = await Senyap.deploy();
  await s.call('setReference', emptyPrivateState(), MID, BAND);
  await assert.rejects(
    s.call('postQuote', makerState(MAKERS.A)),
    /not authorised/,
  );
});

test('a quote outside the public band is refused', async () => {
  const s = await Senyap.deploy();
  await s.call('setReference', emptyPrivateState(), MID, BAND);
  await s.call('registerMaker', emptyPrivateState(), pureCircuits.makerIdOf(MAKERS.A.sk));
  await assert.rejects(
    s.call('postQuote', makerState(MAKERS.A, { price: 1100n })),
    /outside the public band/,
  );
});

test('a quote cannot be bound to a maker id the poster does not control', async () => {
  const s = await Senyap.deploy();
  await s.call('setReference', emptyPrivateState(), MID, BAND);
  await s.call('registerMaker', emptyPrivateState(), pureCircuits.makerIdOf(MAKERS.A.sk));
  await assert.rejects(
    s.call('postQuote', makerState(MAKERS.A, { makerId: pureCircuits.makerIdOf(MAKERS.B.sk) })),
    /not bound to this maker/,
  );
});

test('a maker can cancel its own quote', async () => {
  const s = await venue();
  await s.call('cancelQuote', makerState(MAKERS.A));
  const l = s.ledger();
  // A cancel is a nullifier now, not a deletion: the leaf stays in the tree and
  // stops being fillable, which is exactly what a fill does. On chain the two
  // are the same event, so a cancelled quote does not announce itself.
  assert.equal(l.quotes.firstFree(), 3n, 'the tree is append-only');
  assert.equal(l.spent.member(pureCircuits.nullifierOf(
    pureCircuits.commitmentOf(termsOf(MAKERS.A), MAKERS.A.nonce))), true);
});

test('a cancelled quote can no longer be filled', async () => {
  const s = await venue();
  await s.call('cancelQuote', makerState(MAKERS.B));
  await assert.rejects(
    s.call('takeQuote', takerState(fullBook(), 40n, 1000n, 1n)),
    /already been filled/,
  );
});

test('a maker cannot cancel a quote it does not own', async () => {
  const s = await venue();
  const impostor = { ...makerState(MAKERS.B), makerSecret: MAKERS.C.sk };
  await assert.rejects(
    s.call('cancelQuote', impostor),
    /not the maker of this quote/,
  );
});

// ---------------------------------------------------------------- primitives

test('commitments bind every field of the quote', async () => {
  const base = termsOf(MAKERS.A);
  const c = pureCircuits.commitmentOf(base, MAKERS.A.nonce);
  for (const over of [{ price: 1011n }, { maxSize: 99n }, { expiry: 11n }]) {
    const moved = pureCircuits.commitmentOf({ ...base, ...over }, MAKERS.A.nonce);
    assert.notDeepEqual(moved, c, `commitment did not move for ${Object.keys(over)[0]}`);
  }
  const reNonced = pureCircuits.commitmentOf(base, bytes32(255));
  assert.notDeepEqual(reNonced, c, 'commitment did not move for the nonce');
});

test('the nullifier is domain separated from the commitment', async () => {
  const c = pureCircuits.commitmentOf(termsOf(MAKERS.A), MAKERS.A.nonce);
  const nf = pureCircuits.nullifierOf(c);
  assert.notDeepEqual(nf, c, 'nullifier must not equal the commitment it consumes');
  const other = pureCircuits.commitmentOf(termsOf(MAKERS.B), MAKERS.B.nonce);
  assert.notDeepEqual(nf, pureCircuits.nullifierOf(other));
});
