// Senyap taker console.
//
// Every button here runs the real compiled circuit in the browser. Nothing is
// validated in JavaScript first - when an action is refused, it is the contract
// refusing it, and the message you see is the assert that failed.
import {
  Senyap, emptyPrivateState, deadSlot, bytes32, pureCircuits,
  makerState, slotOf, takerState,
} from '../src/venue.js';

const MID = 1000n, BAND = 500n, EXPIRY = 10n;

const MAKERS = [
  { name: 'Maker A', sk: bytes32(11), price: 1010n, maxSize: 100n, nonce: bytes32(101) },
  { name: 'Maker B', sk: bytes32(22), price:  995n, maxSize: 100n, nonce: bytes32(102) },
  { name: 'Maker C', sk: bytes32(33), price: 1030n, maxSize:  50n, nonce: bytes32(103) },
];

const $ = (id) => document.getElementById(id);
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const seal = (u8) => `${hex(u8).slice(0, 10)}…${hex(u8).slice(-6)}`;

let venue;

// --------------------------------------------------------------------- venue

async function boot() {
  venue = await Senyap.deploy();
  await venue.call('setReference', emptyPrivateState(), MID, BAND);
  for (const m of MAKERS) {
    await venue.call('registerMaker', emptyPrivateState(), pureCircuits.makerIdOf(m.sk));
    await venue.call('postQuote', makerState(m));
  }
}

const book = () => MAKERS.map((m) => slotOf(m));

// The taker picks the cheapest opening it holds. The circuit does not trust this
// choice - it recomputes the minimum itself and refuses anything else.
const bestIndex = () =>
  BigInt(MAKERS.reduce((best, m, i) => (m.price < MAKERS[best].price ? i : best), 0));

// --------------------------------------------------------------------- render

function render() {
  const l = venue.ledger();
  const cheapest = Number(bestIndex());

  $('mid').textContent = MID;
  $('bandBps').textContent = `${BAND} bps`;
  const slack = (MID * BAND) / 10000n;
  $('range').textContent = `${MID - slack} – ${MID + slack}`;

  $('quotes').replaceChildren(...MAKERS.map((m, i) => {
    const li = document.createElement('li');
    if (i === cheapest) li.className = 'best';
    li.innerHTML = `<span class="who">${m.name}</span>
      <span class="px">${m.price}</span>
      ${i === cheapest ? '<span class="flag">best</span>' : ''}
      <span class="sz">max ${m.maxSize}</span>`;
    return li;
  }));

  const live = [...l.quotes].map(hex);
  $('seals').replaceChildren(...MAKERS.map((m) => {
    const c = pureCircuits.commitmentOf(
      { price: m.price, maxSize: m.maxSize, expiry: EXPIRY, makerId: pureCircuits.makerIdOf(m.sk) },
      m.nonce,
    );
    const gone = !live.includes(hex(c));
    const li = document.createElement('li');
    li.className = gone ? 'gone' : '';
    li.innerHTML = `<span class="hash">${seal(c)}</span>
      <span class="lbl">${gone ? 'consumed' : 'sealed — no price on chain'}</span>`;
    return li;
  }));

  $('sQuotes').textContent = l.quotes.size();
  $('sFills').textContent = l.fills;
  $('sSpent').textContent = l.spent.size();
  $('sPrint').textContent = l.lastFillPrice === 0n ? '—' : l.lastFillPrice;
}

function say(ok, verdict, reason) {
  const box = $('result');
  box.hidden = false;
  box.className = `result ${ok ? 'ok' : 'no'}`;
  $('verdict').textContent = verdict;
  $('reason').textContent = reason;
}

// Runs a circuit and reports whichever way it goes. `expectRefusal` only changes
// how the outcome is worded; it never changes what is executed.
async function run(label, fn, expectRefusal = false) {
  document.querySelectorAll('button').forEach((b) => (b.disabled = true));
  say(true, 'PROVING…', label);
  try {
    await fn();
    render();
    if (expectRefusal) {
      say(false, 'ACCEPTED', `${label} — this should have been refused. That is a bug.`);
    } else {
      say(true, `FILLED @ ${venue.ledger().lastFillPrice}`,
        'only this price reached the chain; the other two quotes stay sealed');
    }
  } catch (e) {
    const m = String(e.message ?? e).match(/failed assert: ([^\n]*)/);
    say(false, 'REFUSED', m ? m[1].trim() : String(e.message ?? e).slice(0, 160));
  } finally {
    document.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}

// -------------------------------------------------------------------- actions

const ATTACKS = [
  {
    title: 'Fade the committed price',
    sub: 'maker tries to settle 5 ticks better for itself',
    run: () => {
      const b = book();
      b[1] = slotOf(MAKERS[1], { price: 990n });
      return venue.call('takeQuote', takerState(b, 40n, 1000n, 1n));
    },
  },
  {
    title: 'Skip the best quote',
    sub: 'taker fills a worse quote it holds',
    run: () => venue.call('takeQuote', takerState(book(), 40n, 1100n, 0n)),
  },
  {
    title: 'Invent a competitor',
    sub: 'fake a terrible quote nobody posted, to fake best execution',
    run: () => venue.call('takeQuote', takerState([
      slotOf(MAKERS[0]),
      {
        terms: { price: 9999n, maxSize: 100n, expiry: EXPIRY, makerId: pureCircuits.makerIdOf(bytes32(99)) },
        nonce: bytes32(199), live: true,
      },
      deadSlot(),
    ], 40n, 1100n, 0n)),
  },
  {
    title: 'Fill the same quote twice',
    sub: 'replay a fill that already cleared',
    run: () => venue.call('takeQuote', takerState(book(), 40n, 1000n, bestIndex())),
  },
  {
    title: 'Beat your own limit',
    sub: 'fill above the limit price you set',
    run: () => venue.call('takeQuote', takerState(book(), 40n, 900n, bestIndex())),
  },
  {
    title: 'Reset the venue',
    sub: 'rebuild with three fresh sealed quotes',
    reset: true,
    run: async () => { await boot(); },
  },
];

// ----------------------------------------------------------------------- boot

try {
  await boot();
  render();
  $('boot').remove();
  $('app').hidden = false;

  $('fill').addEventListener('click', () => {
    const size = BigInt($('size').value || '0');
    const limit = BigInt($('limit').value || '0');
    return run('filling the best quote', () =>
      venue.call('takeQuote', takerState(book(), size, limit, bestIndex())));
  });

  $('attacks').replaceChildren(...ATTACKS.map((a) => {
    const b = document.createElement('button');
    b.innerHTML = `<span>${a.title}</span><span class="sub">${a.sub}</span>`;
    b.addEventListener('click', async () => {
      if (a.reset) {
        await a.run();
        render();
        return say(true, 'RESET', 'three fresh sealed quotes on the ledger');
      }
      return run(a.title, a.run, true);
    });
    return b;
  }));
} catch (e) {
  $('boot').textContent = `Could not start the circuits: ${e.message ?? e}`;
  console.error(e);
}
