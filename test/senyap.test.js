import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Senyap, emptyPrivateState, deadSlot, bytes32, pureCircuits, stateDump, leHex,
         termsOf, makerState, slotOf, takerState } from '../src/venue.js';

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
  assert.equal(l.quotes.size(), 3n);
  assert.equal(l.lastFillPrice, 0n, 'nothing has traded yet');
});

test('taker fills the best quote and only that price is printed', async () => {
  const s = await venue();
  await s.call('takeQuote', takerState(fullBook(), 40n, 1000n, 1n));
  const l = s.ledger();
  assert.equal(l.fills, 1n);
  assert.equal(l.lastFillPrice, 995n, 'the winning price is the print');
  assert.equal(l.quotes.size(), 2n, 'the filled quote is consumed');
  assert.equal(l.spent.size(), 1n, 'a nullifier was recorded');
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

test('the public state is identical whatever the taker size was', async () => {
  // Stronger than grepping for the size: two fills that differ only in private
  // data must be byte-identical on chain. A one-byte size has no searchable
  // encoding anyway, so a substring scan would prove nothing here.
  const runWith = async (size, limit) => {
    const s = await venue();
    await s.call('takeQuote', takerState(fullBook(), size, limit, 1n));
    return stateDump(s);
  };
  assert.equal(await runWith(40n, 1000n), await runWith(90n, 1048n),
    'the public state moved with the taker order, so the order leaked');
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
  // C is the only live slot, so it is trivially best, but it caps at 50.
  const book = [deadSlot(), deadSlot(), slotOf(MAKERS.C)];
  await assert.rejects(
    s.call('takeQuote', takerState(book, 80n, 1100n, 2n)),
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
  await assert.rejects(
    s.call('takeQuote', takerState(fullBook(), 40n, 1000n, 1n)),
    /not a live on-chain quote/,
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
  const book = [slotOf(MAKERS.A), ghost, deadSlot()];
  await assert.rejects(
    s.call('takeQuote', takerState(book, 40n, 1100n, 0n)),
    /slot 1 is not a live on-chain quote/,
  );
});

test('a padding slot can never be chosen', async () => {
  const s = await venue();
  const book = [slotOf(MAKERS.B), deadSlot(), deadSlot()];
  await assert.rejects(
    s.call('takeQuote', takerState(book, 40n, 1000n, 1n)),
    /chosen slot is empty/,
  );
});

test('a padding slot never wins the price comparison', async () => {
  const dead = deadSlot();
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
  assert.equal(s.ledger().quotes.size(), 2n);
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
