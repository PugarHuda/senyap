import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Senyap, emptyPrivateState, bytes32, pureCircuits } from '../src/venue.js';

test('deploys with an empty book', async () => {
  const s = await Senyap.deploy();
  const l = s.ledger();
  assert.equal(l.fills, 0n);
  assert.equal(l.quotes.isEmpty(), true);
  assert.equal(l.epoch, 0n);
});

test('registerMaker lands on the public ledger', async () => {
  const s = await Senyap.deploy();
  const id = pureCircuits.makerIdOf(bytes32(7));
  await s.call('registerMaker', emptyPrivateState(), id);
  assert.equal(s.ledger().makers.member(id), true);
});
