#!/usr/bin/env node
// The Senyap walkthrough, against the contract that is actually on preprod.
//
// Same story as `npm run demo`, with one difference that is the whole point:
// nothing here is simulated. Every line that says "sealed" is a transaction
// that a stranger can look up, and the leak check at the end reads the public
// ledger back out of the indexer rather than out of this process.
//
// Run with: npm run live
import { readFileSync } from 'node:fs';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { connect, deployRecordPath, die, preflightPrivateState, run } from '../src/midnight.js';
import {
  bytes32,
  emptyPrivateState,
  leHex,
  makerState,
  pureCircuits,
  slotOf,
  takerState,
} from '../src/venue.js';
import { ledger } from '../src/managed/senyap/contract/index.js';

const MID = 1000n;
const BAND = 500n;

// The same desk as the local demo, so the two printouts can be compared.
const MAKERS = {
  A: { sk: bytes32(11), price: 1010n, maxSize: 100n, nonce: bytes32(101) },
  B: { sk: bytes32(22), price: 995n, maxSize: 100n, nonce: bytes32(102) },
  C: { sk: bytes32(33), price: 1030n, maxSize: 50n, nonce: bytes32(103) },
};
const TAKER = { size: 40n, limit: 1000n };

const h = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const pub = (t) => console.log(`  \x1b[36m${t}\x1b[0m`);
const priv = (t) => console.log(`  \x1b[35m${t}\x1b[0m`);
const short = (u8) => {
  const s = Buffer.from(u8).toString('hex');
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
};

run(async () => {
  const record = JSON.parse(readFileSync(deployRecordPath, 'utf8'));
  console.log(`\n\x1b[1mSENYAP\x1b[0m  live on ${record.network}`);
  console.log(`contract ${record.address}`);

  const { providers, compiled, stop } = await connect();
  await preflightPrivateState(providers);

  // findDeployedContract compares the local verifier keys against the ones the
  // contract was deployed with. Any edit to senyap.compact changes them, and
  // the SDK reports that as a bare ContractTypeError several frames down. Said
  // plainly it is not an error at all, just a contract that predates the code.
  const senyap = await findDeployedContract(providers, {
    compiledContract: compiled,
    contractAddress: record.address,
    privateStateId: 'senyap',
    initialPrivateState: emptyPrivateState(),
  }).catch((e) => {
    if (String(e?.name ?? e).includes('ContractTypeError') || /verifier key/i.test(String(e))) {
      die(
        `The contract at ${record.address} was built from different circuits than\n` +
          'the ones in src/managed. Deploy the current contract with `npm run deploy`\n' +
          'and this will point at that one.',
      );
    }
    throw e;
  });

  // Each actor's vault is written to the store the circuit will read it from,
  // immediately before the call. A maker and a taker never share one, which is
  // the same separation the local simulator makes - it just costs a round trip
  // through a proof server and a block here.
  const call = async (circuit, privateState, ...args) => {
    await providers.privateStateProvider.set('senyap', privateState);
    const started = Date.now();
    const tx = await senyap.callTx[circuit](...args);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(
      `  \x1b[2m${circuit.padEnd(13)} ${tx.public.txId.slice(0, 18)}...  ` +
        `block ${tx.public.blockHeight}  ${secs}s\x1b[0m`,
    );
    return tx;
  };

  h('VENUE - publishing the band');
  pub(`mid ${MID}, band ${BAND} bps: quotes are accepted in [950, 1050]`);
  await call('setReference', emptyPrivateState(), MID, BAND);

  h('PRIVATE - three makers, three separate vaults');
  for (const [name, m] of Object.entries(MAKERS)) {
    priv(`maker ${name}   price ${String(m.price).padStart(5)}   max size ${String(m.maxSize).padStart(4)}`);
  }

  h('SEALING - one transaction per quote');
  for (const m of Object.values(MAKERS)) {
    await call('registerMaker', emptyPrivateState(), pureCircuits.makerIdOf(m.sk));
    await call('postQuote', makerState(m));
  }

  h('PRIVATE - the taker');
  priv(`size ${TAKER.size}   limit ${TAKER.limit}`);
  priv('holds all three openings, sent off-chain by the makers');

  h('FILLING - best execution proved against the live ledger');
  const book = [slotOf(MAKERS.A), slotOf(MAKERS.B), slotOf(MAKERS.C)];
  await call('takeQuote', takerState(book, TAKER.size, TAKER.limit, 1n));

  h('PUBLIC LEDGER - read back from the indexer, not from this process');
  const onChain = await providers.publicDataProvider.queryContractState(record.address);
  const l = ledger(onChain.data);
  // Not a list of commitments any more: a root, and a count of leaves under it.
  pub(`quote tree root  ${short(Buffer.from(l.quotes.root().field.toString(16).padStart(64, '0'), 'hex'))}`);
  pub(`leaves           ${l.quotes.firstFree()}`);
  pub(`fills            ${l.fills}`);
  pub(`nullifiers       ${l.spent.size()}`);
  pub(`lastFillPrice    ${l.lastFillPrice}`);

  h('LEAK CHECK - against the serialised state the chain actually holds');
  const raw = onChain.data.toString();
  const scan = [
    ['maker B - won', 995n],
    ['maker A - lost', 1010n],
    ['maker C - lost', 1030n],
  ].map(([label, price]) => ({ label, price, found: raw.includes(leHex(price)) }));

  const control = scan[0].found;
  for (const { label, price, found } of scan) {
    const verdict = found ? '\x1b[33mpresent\x1b[0m' : '\x1b[32mabsent \x1b[0m';
    console.log(`  ${verdict}  ${String(price).padStart(5)}  ${label}`);
  }
  if (control) {
    pub('the winner being present is the control: the scan can see prices at all');
  } else {
    // Absence proves nothing if the scan cannot find the price that did trade.
    // Saying so is the only honest option; a green row here would be a lie.
    console.log(
      '  \x1b[31mNO CONTROL\x1b[0m  the winning price is not in this encoding either,\n' +
        '              so the two absences above prove nothing about privacy.',
    );
    process.exitCode = 1;
  }

  console.log('');
  await stop();
});
