// Senyap end-to-end demo: three makers, one taker, one fill.
//
// Run with: npm run demo
//
// The point of the printout is the contrast. Everything under PRIVATE lives on
// one actor's machine and is fed to the circuit as a witness. Everything under
// PUBLIC LEDGER is what the chain actually holds. Two of the three prices never
// cross that line, and the refusals at the end are enforced by the circuit, not
// by this script.
import {
  Senyap,
  emptyPrivateState,
  deadSlot,
  bytes32,
  pureCircuits,
  stateDump,
  leHex,
} from '../test/harness.js';

const MID = 1000n, BAND = 500n, EXPIRY = 10n;

const MAKERS = {
  A: { sk: bytes32(11), price: 1010n, maxSize: 100n, nonce: bytes32(101) },
  B: { sk: bytes32(22), price:  995n, maxSize: 100n, nonce: bytes32(102) },
  C: { sk: bytes32(33), price: 1030n, maxSize:  50n, nonce: bytes32(103) },
};

const TAKER = { size: 40n, limit: 1000n };

const termsOf = (m, over = {}) => ({
  price: m.price, maxSize: m.maxSize, expiry: EXPIRY,
  makerId: pureCircuits.makerIdOf(m.sk), ...over,
});

const makerState = (m, over = {}) => ({
  ...emptyPrivateState(),
  makerSecret: m.sk,
  quoteToPost: termsOf(m, over),
  quoteNonce: m.nonce,
});

const slotOf = (m, over = {}) => ({ terms: termsOf(m, over), nonce: m.nonce, live: true });

const takerState = (book, size, limit, idx) => ({
  ...emptyPrivateState(),
  receivedQuotes: book, takerOrder: [size, limit], chosenIndex: idx,
});

const hex = (u8) => Buffer.from(u8).toString('hex');
const short = (u8) => `${hex(u8).slice(0, 8)}...${hex(u8).slice(-4)}`;
const h = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const priv = (t) => console.log(`  \x1b[35m${t}\x1b[0m`);
const pub = (t) => console.log(`  \x1b[36m${t}\x1b[0m`);

function showLedger(s) {
  const l = s.ledger();
  pub(`quotes live      ${l.quotes.size()}`);
  pub(`fills            ${l.fills}`);
  pub(`nullifiers       ${l.spent.size()}`);
  pub(`lastFillPrice    ${l.lastFillPrice === 0n ? '-  (nothing traded yet)' : l.lastFillPrice}`);
}

async function refuses(label, fn) {
  try {
    await fn();
    console.log(`  \x1b[31m! ${label}\x1b[0m  ACCEPTED - this is a bug`);
    process.exitCode = 1;
  } catch (e) {
    const reason = (e.message.match(/failed assert: (.*)/) ?? [null, e.message])[1];
    console.log(`  \x1b[32mREFUSED\x1b[0m  ${label}\n           ${reason.trim().slice(0, 80)}`);
  }
}

const main = async () => {
  console.log('\n\x1b[1mSENYAP\x1b[0m  sealed-quote RFQ on Midnight');
  console.log(`reference mid ${MID} - band ${BAND} bps - quotes accepted in [950, 1050]`);

  const s = await Senyap.deploy();
  await s.call('setReference', emptyPrivateState(), MID, BAND);

  h('PRIVATE - three makers, three separate machines');
  for (const [name, m] of Object.entries(MAKERS)) {
    priv(`maker ${name}   price ${String(m.price).padStart(5)}   max size ${String(m.maxSize).padStart(4)}`);
  }

  for (const m of Object.values(MAKERS)) {
    await s.call('registerMaker', emptyPrivateState(), pureCircuits.makerIdOf(m.sk));
    await s.call('postQuote', makerState(m));
  }

  h('PUBLIC LEDGER - after all three post');
  for (const c of s.ledger().quotes) pub(`sealed quote     ${short(c)}`);
  showLedger(s);
  pub('no price among them: a commitment is all the chain is given');

  h('PRIVATE - the taker');
  priv(`size ${TAKER.size}   limit ${TAKER.limit}`);
  priv('holds all three openings, sent off-chain by the makers');

  const book = [slotOf(MAKERS.A), slotOf(MAKERS.B), slotOf(MAKERS.C)];
  await s.call('takeQuote', takerState(book, TAKER.size, TAKER.limit, 1n));

  h('PUBLIC LEDGER - after the fill');
  showLedger(s);

  h('LEAK CHECK - scanning the real serialised on-chain state');
  const raw = stateDump(s);
  for (const [label, p] of [
    ['maker B - won',  995n],
    ['maker A - lost', 1010n],
    ['maker C - lost', 1030n],
  ]) {
    const found = raw.includes(leHex(p));
    const verdict = found ? '[33mpresent[0m' : '[32mabsent [0m';
    console.log(`  ${verdict}  ${String(p).padStart(5)}  ${label}`);
  }
  pub('the winner being present is the control: it proves the scan can see prices at all');

  const other = await (async () => {
    const t = await Senyap.deploy();
    await t.call('setReference', emptyPrivateState(), MID, BAND);
    for (const m of Object.values(MAKERS)) {
      await t.call('registerMaker', emptyPrivateState(), pureCircuits.makerIdOf(m.sk));
      await t.call('postQuote', makerState(m));
    }
    await t.call('takeQuote', takerState(
      [slotOf(MAKERS.A), slotOf(MAKERS.B), slotOf(MAKERS.C)], 90n, 1048n, 1n));
    return stateDump(t);
  })();
  const same = other === raw;
  console.log(`  ${same ? '[32midentical[0m' : '[31mDIFFERENT[0m'}  the same fill with taker size 90 and limit 1048`);
  pub('a one-byte size has no searchable encoding, so indistinguishability is the honest test');

  h('REFUSALS - all four enforced by the circuit');
  await refuses('maker fades the committed price', () =>
    s.call('takeQuote', takerState(
      [slotOf(MAKERS.A), slotOf(MAKERS.B, { price: 990n }), slotOf(MAKERS.C)], 40n, 1000n, 1n)));
  await refuses('taker fills the same quote twice', () =>
    s.call('takeQuote', takerState(book, 40n, 1000n, 1n)));
  await refuses('taker skips the best quote it holds', () =>
    s.call('takeQuote', takerState(
      [slotOf(MAKERS.A), deadSlot(), slotOf(MAKERS.C)], 40n, 1100n, 2n)));
  await refuses('taker invents a competitor nobody posted', () =>
    s.call('takeQuote', takerState([
      slotOf(MAKERS.A),
      { terms: { price: 9999n, maxSize: 100n, expiry: EXPIRY, makerId: pureCircuits.makerIdOf(bytes32(99)) },
        nonce: bytes32(199), live: true },
      deadSlot(),
    ], 40n, 1100n, 0n)));

  console.log('');
};

main().catch((e) => { console.error(e); process.exit(1); });
