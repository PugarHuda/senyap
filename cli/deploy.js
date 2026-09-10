#!/usr/bin/env node
// Put Senyap on a Midnight network.
//
// Needs a funded wallet with DUST registered and a proof server on :6300 -
// see the Deploying section of the README. Everything about getting there
// lives in src/midnight.js; this file is only the deploy itself.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deployContract } from '@midnight-ntwrk/midnight-js/contracts';
import { connect, deployRecordPath, NETWORK, preflightPrivateState, run } from '../src/midnight.js';
import { emptyPrivateState } from '../src/venue.js';

run(async () => {
  const { providers, compiled, stop } = await connect();
  await preflightPrivateState(providers);

  console.log('proving and submitting the deploy transaction...');
  const deployed = await deployContract(providers, {
    compiledContract: compiled,
    privateStateId: 'senyap',
    initialPrivateState: emptyPrivateState(),
  });

  const address = deployed.deployTxData.public.contractAddress;
  mkdirSync(dirname(deployRecordPath), { recursive: true });
  writeFileSync(
    deployRecordPath,
    JSON.stringify({ network: NETWORK, address, deployedAt: new Date().toISOString() }, null, 2) +
      '\n',
  );

  console.log(`\ndeployed at ${address}`);
  console.log(`written to ${deployRecordPath}`);
  await stop();
});
