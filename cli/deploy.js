#!/usr/bin/env node
// Deploy Senyap to a Midnight network.
//
// Everything here is the v8 stack described in the README: compact-runtime
// 0.16, midnight-js 4.1.1, wallet SDK 1.2.0, ledger-v8. Nothing is simulated.
//
// Needs three things the code cannot provide for itself:
//   MIDNIGHT_SEED         64 hex chars, a funded wallet on the target network
//   a proof server        docker run -p 6300:6300 midnightntwrk/proof-server:8.1.0
//   NIGHT registered for dust generation, so the deploy can pay its fee
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {
  DustWallet,
  HDWallet,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  Roles,
  ShieldedWallet,
  UnshieldedWallet,
  WalletFacade,
  createKeystore,
} from '@midnight-ntwrk/wallet-sdk';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { deployContract } from '@midnight-ntwrk/midnight-js/contracts';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { Contract } from '../src/managed/senyap/contract/index.js';
import { emptyPrivateState, witnesses } from '../src/venue.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const managed = resolve(root, 'src/managed/senyap');

const NETWORK = process.env.MIDNIGHT_NETWORK ?? 'preprod';
const INDEXER =
  process.env.MIDNIGHT_INDEXER ?? `https://indexer.${NETWORK}.midnight.network/api/v4/graphql`;
const NODE = process.env.MIDNIGHT_NODE ?? `wss://rpc.${NETWORK}.midnight.network`;
const PROOF_SERVER = process.env.MIDNIGHT_PROOF_SERVER ?? 'http://127.0.0.1:6300';
const SYNC_TIMEOUT_MS = Number(process.env.MIDNIGHT_SYNC_TIMEOUT_MS ?? 7_200_000);
const INDEXER_WS = INDEXER.replace(/^http/, 'ws') + '/ws';
const SEED_FILE = resolve(root, `.wallet/${NETWORK}.seed`);
const CACHE_FILE = resolve(root, `.wallet/${NETWORK}.state.json`);

const NIGHT = ledger.nativeToken();

const die = (msg) => {
  console.error(`\n${msg}\n`);
  process.exit(1);
};

// The seed has to survive between runs or the funded wallet is a different
// wallet next time. MIDNIGHT_SEED wins; otherwise .wallet/ holds one.
const seedBytes = () => {
  let hex = (process.env.MIDNIGHT_SEED ?? '').trim().replace(/^0x/, '');
  if (!hex && existsSync(SEED_FILE)) hex = readFileSync(SEED_FILE, 'utf8').trim();
  if (!hex) {
    hex = randomBytes(32).toString('hex');
    mkdirSync(dirname(SEED_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(SEED_FILE, hex + '\n', { mode: 0o600 });
    console.log(`new wallet seed written to ${SEED_FILE} — back it up, it is the wallet`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    die(`A wallet seed must be 64 hex characters. Got ${hex.length} characters.`);
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
};

// Preprod is 1.5M events deep and the dust wallet applies them at roughly
// 16k/min, so a cold sync is over an hour. Serialized state turns every run
// after the first into a catch-up.
const loadCache = () =>
  existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};

const saveCache = async (facade) => {
  const [shielded, unshielded, dust] = await Promise.all([
    facade.shielded.serializeState(),
    facade.unshielded.serializeState(),
    facade.dust.serializeState(),
  ]);
  mkdirSync(dirname(CACHE_FILE), { recursive: true, mode: 0o700 });
  // Serialized wallet state is coin data, not just a cache.
  writeFileSync(CACHE_FILE, JSON.stringify({ shielded, unshielded, dust }), { mode: 0o600 });
};

// The HD tree gives each role its own key. Zswap is the shielded side, Dust
// pays fees, NightExternal signs unshielded spends.
const deriveKeys = (seed) => {
  const hd = HDWallet.fromSeed(seed);
  // Deliberately not echoing hd.error — it is the SDK's report on the seed.
  if (hd.type !== 'seedOk') die('The HD wallet rejected this seed.');
  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.Dust, Roles.NightExternal])
    .deriveKeysAt(0);
  if (derived.type !== 'keysDerived') die(`Key derivation out of bounds: ${derived.roles}`);
  hd.hdWallet.clear();
  return {
    shieldedSecretKeys: ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]),
    dustSecretKey: ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]),
    unshieldedKeystore: createKeystore(derived.keys[Roles.NightExternal], NETWORK),
  };
};

// Three sub-wallets sync independently and isSynced is the AND of all three, so
// a stall is only diagnosable per wallet.
// Completeness is appliedIndex vs highestRelevantWalletIndex, not highestIndex.
const progress = (name, p) =>
  `${name} ${p.appliedIndex}/${p.highestRelevantWalletIndex}${p.isConnected ? '' : ' (offline)'}`;

const startWallet = async ({ shieldedSecretKeys, dustSecretKey, unshieldedKeystore }) => {
  const configuration = {
    networkId: NETWORK,
    indexerClientConnection: { indexerHttpUrl: INDEXER, indexerWsUrl: INDEXER_WS },
    // The defaults are 10 events per batch with 4ms of spacing between them,
    // which is fine for a live wallet and hopeless for a first sync: preprod is
    // 1.5M events deep and the dust wallet crawls it at ~11k/min.
    batchUpdates: { size: 1000, timeout: 100, spacing: 0 },
    relayURL: new URL(NODE),
    provingServerUrl: new URL(PROOF_SERVER),
    // ponytail: in-memory history, so every run re-reads the chain. A durable
    // store only matters once something wants to query past transactions.
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    costParameters: { feeBlocksMargin: 10 },
  };

  const cache = loadCache();
  if (cache.dust) console.log(`resuming from ${CACHE_FILE}`);

  const facade = await WalletFacade.init({
    configuration,
    shielded: (c) =>
      cache.shielded
        ? ShieldedWallet(c).restore(cache.shielded)
        : ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c) =>
      cache.unshielded
        ? UnshieldedWallet(c).restore(cache.unshielded)
        : UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (c) =>
      cache.dust
        ? DustWallet(c).restore(cache.dust)
        : DustWallet(c).startWithSecretKey(
            dustSecretKey,
            ledger.LedgerParameters.initialParameters().dust,
          ),
  });

  await facade.start(shieldedSecretKeys, dustSecretKey);

  // start() returns when sync begins, not when it finishes. Balancing against a
  // half-synced wallet picks coins that are already spent.
  console.log(`syncing against ${NETWORK}...`);
  // A cold sync is long enough that losing it to a crash matters.
  const checkpoint = setInterval(() => void saveCache(facade).catch(() => {}), 300_000);
  let lastLog = 0;
  const state = await Rx.firstValueFrom(
    facade.state().pipe(
      Rx.tap((s) => {
        if (Date.now() - lastLog < 5_000) return;
        lastLog = Date.now();
        console.log(
          `  ${progress('shielded', s.shielded.state.progress)}  ` +
            `${progress('unshielded', s.unshielded.progress)}  ` +
            `${progress('dust', s.dust.state.progress)}`,
        );
      }),
      Rx.filter((s) => s.isSynced),
      Rx.timeout({
        each: SYNC_TIMEOUT_MS,
        with: () =>
          Rx.throwError(
            () => new Error(`wallet did not finish syncing in ${SYNC_TIMEOUT_MS / 1000}s`),
          ),
      }),
      Rx.finalize(() => clearInterval(checkpoint)),
    ),
  );
  await saveCache(facade);
  return { facade, state };
};

// Fees are paid in DUST, and NIGHT only produces spendable DUST after its UTXOs
// are registered on chain. The apparent circularity — a registration that costs
// a fee the wallet cannot yet pay — resolves because unregistered NIGHT still
// accrues *projected* dust from its creation time. So: estimate the fee, wait
// for the projection to cover it, then register.
const registerDust = async (facade, state, keys) => {
  const nightUtxos = state.unshielded.availableCoins.filter(
    (c) => c.utxo.type === NIGHT && !c.meta.registeredForDustGeneration,
  );
  if (nightUtxos.length === 0) die('No unregistered NIGHT UTXOs to register.');

  const { fee } = await facade.estimateRegistration(nightUtxos);
  console.log(`registering ${nightUtxos.length} NIGHT utxo(s), fee ${fee}`);
  await facade.waitForGeneratedDust(nightUtxos, fee, { timeoutMs: 1_800_000 });

  const { unshieldedKeystore, shieldedSecretKeys, dustSecretKey } = keys;
  const recipe = await facade.registerNightUtxosForDustGeneration(
    nightUtxos,
    unshieldedKeystore.getPublicKey(),
    (payload) => unshieldedKeystore.signData(payload),
  );
  const balanced = await facade.balanceUnprovenTransaction(
    recipe.transaction,
    { shieldedSecretKeys, dustSecretKey },
    { ttl: new Date(Date.now() + 3_600_000) },
  );
  const txId = await facade.submitTransaction(await facade.finalizeRecipe(balanced));
  console.log(`registration submitted, tx ${txId}`);
};

// WalletProvider and MidnightProvider are two halves of the same wallet.
class FacadeProvider {
  constructor(facade, keys) {
    this.facade = facade;
    this.keys = keys;
  }
  getCoinPublicKey() {
    return this.keys.shieldedSecretKeys.coinPublicKey;
  }
  getEncryptionPublicKey() {
    return this.keys.shieldedSecretKeys.encryptionPublicKey;
  }
  async balanceTx(tx, ttl = new Date(Date.now() + 3_600_000)) {
    const { shieldedSecretKeys, dustSecretKey } = this.keys;
    const recipe = await this.facade.balanceUnboundTransaction(
      tx,
      { shieldedSecretKeys, dustSecretKey },
      { ttl },
    );
    return this.facade.finalizeRecipe(recipe);
  }
  submitTx(tx) {
    return this.facade.submitTransaction(tx);
  }
}

const main = async () => {
  setNetworkId(NETWORK);

  const keys = deriveKeys(seedBytes());
  // The address comes straight out of the keystore, so it is printable before
  // the long sync rather than after it. Funding can start immediately.
  const nightAddress = keys.unshieldedKeystore.getBech32Address().asString();
  console.log(`night address  ${nightAddress}`);

  const { facade, state } = await startWallet(keys);

  const night = state.unshielded.balances[NIGHT] ?? 0n;
  const dust = state.dust.balance(new Date());
  console.log(`night balance  ${night}`);
  console.log(`dust balance   ${dust}`);

  if (night === 0n) {
    await facade.stop();
    die(`This wallet holds no NIGHT on ${NETWORK}. Fund the address above from the faucet.`);
  }
  if (!dust) {
    await registerDust(facade, state, keys);
    await facade.stop();
    die(
      'Registered this wallet for DUST generation. DUST accrues over time, so\n' +
        'run the deploy again once there is a balance to pay the fee with.',
    );
  }

  const walletProvider = new FacadeProvider(facade, keys);
  const zkConfigProvider = new NodeZkConfigProvider(managed);
  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'senyap-private-state',
      signingKeyStoreName: 'senyap-signing-keys',
      privateStoragePasswordProvider: () => process.env.MIDNIGHT_SEED,
      accountId: nightAddress,
    }),
    publicDataProvider: indexerPublicDataProvider(INDEXER, INDEXER_WS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(PROOF_SERVER, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  const compiled = CompiledContract.withCompiledFileAssets(
    CompiledContract.withWitnesses(CompiledContract.make('senyap', Contract), witnesses),
    managed,
  );

  console.log('proving and submitting the deploy transaction...');
  const deployed = await deployContract(providers, {
    compiledContract: compiled,
    privateStateId: 'senyap',
    initialPrivateState: emptyPrivateState(),
  });

  const address = deployed.deployTxData.public.contractAddress;
  const record = { network: NETWORK, address, deployedAt: new Date().toISOString() };
  mkdirSync(resolve(root, 'deploy'), { recursive: true });
  writeFileSync(resolve(root, `deploy/${NETWORK}.json`), JSON.stringify(record, null, 2) + '\n');

  console.log(`\ndeployed at ${address}`);
  console.log(`written to deploy/${NETWORK}.json`);
  await facade.stop();
};

main().catch((e) => die(e?.stack ?? String(e)));
