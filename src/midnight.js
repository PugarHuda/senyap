// Everything needed to talk to a real Midnight network: wallet, providers, and
// the two workarounds the SDK needs to actually submit a transaction.
//
// cli/deploy.js puts the contract on chain; cli/live.js drives the one that is
// already there. Both start from connect().
//
// Everything here is the v8 stack described in the README: compact-runtime
// 0.16, midnight-js 4.1.1, wallet SDK 1.2.0, ledger-v8. Nothing is simulated.
//
// Needs three things the code cannot provide for itself:
//   MIDNIGHT_SEED         64 hex chars, a funded wallet on the target network
//   a proof server        docker run -p 6300:6300 midnightntwrk/proof-server:8.1.0
//   NIGHT registered for dust generation, so the deploy can pay its fee
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Rx from 'rxjs';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { u8aToHex } from '@polkadot/util';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {
  DustWallet,
  HDWallet,
  NoOpTransactionHistoryStorage,
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
import { sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract } from './managed/senyap/contract/index.js';
import { emptyPrivateState, witnesses } from './venue.js';

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
const deployRecordPath = resolve(root, `deploy/${NETWORK}.json`);

// nativeToken() is {tag, raw}; the balance and UTXO maps are keyed by the raw
// hex alone. Indexing them with the object reads undefined, which looks exactly
// like an unfunded wallet.
export const NIGHT = ledger.nativeToken().raw;

// Every phase here is minutes long and silent on its own, so each one says so.
export const step = (msg) => console.log(`  ${new Date().toISOString().slice(11, 19)} ${msg}`);

// Several SDK calls wait forever rather than failing - a balancer short of a
// coin, a sub-wallet waiting on a socket that closed. Silence then reads as
// slowness, and the only way to tell them apart is to make waiting an error.
const DEADLINE_MS = Number(process.env.MIDNIGHT_STEP_TIMEOUT_MS ?? 300_000);

// Which sub-wallets get asked to balance. An override because the three of them
// fail in three different ways and bisecting them is the only way to find out
// which one is at fault on a given transaction.
const BALANCE_KINDS = (process.env.MIDNIGHT_BALANCE_KINDS ?? 'unshielded,dust').split(',');
const deadline = (promise, what, ms = DEADLINE_MS) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${what} did not finish in ${ms / 1000}s - it is waiting, not slow`)),
        ms,
      ).unref(),
    ),
  ]);

export const die = (msg) => {
  console.error(`\n${msg}\n`);
  process.exit(1);
};

// The seed has to survive between runs or the funded wallet is a different
// wallet next time. MIDNIGHT_SEED wins; otherwise .wallet/ holds one.
const seedHex = () => {
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
  return hex;
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
// a stall is only diagnosable per wallet. Completeness is appliedIndex against
// highestRelevantWalletIndex, not highestIndex, which reads 0 throughout.
//
// The unshielded wallet reports a different shape - appliedId and
// highestTransactionId - and its completeness check reads the fields it does
// not have. |undefined - undefined| is 0, so it calls itself complete the
// moment it connects, and isSynced never really waits for it.
const progress = (name, p) => {
  const applied = p.appliedIndex ?? p.appliedId;
  const highest = p.highestRelevantWalletIndex ?? p.highestTransactionId;
  return `${name} ${applied}/${highest}${p.isConnected ? '' : ' (offline)'}`;
};

// The SDK's own node client closes its websocket after loading metadata and
// reopens one per operation. Against preprod that dance loses: .send() rejects
// with "disconnected ... 1000:: Normal Closure" and nothing reaches the chain -
// deterministically, on every attempt. One connection held open submits fine,
// so the facade gets this instead of the default.
export const makeSubmissionService = async () => {
  const api = await ApiPromise.create({
    provider: new WsProvider(NODE, 2000),
    noInitWarn: true,
    throwOnConnect: false,
  });
  return {
    submitTransaction: (tx, waitFor = 'InBlock') =>
      new Promise((resolve, reject) => {
        api.tx.midnight
          .sendMnTransaction(u8aToHex(tx.serialize()))
          .send((result) => {
            const s = result.status;
            if (s.isInvalid || s.isDropped || s.isUsurped) {
              reject(new Error(`the node reported the transaction ${s.type}`));
              return;
            }
            const reached =
              waitFor === 'Finalized'
                ? s.isFinalized
                : waitFor === 'Submitted'
                  ? s.isReady || s.isBroadcast
                  : s.isInBlock || s.isFinalized;
            if (reached) resolve({ _tag: waitFor, tx, txHash: result.txHash.toString() });
          })
          .catch(reject);
      }),
    close: () => api.disconnect(),
  };
};

const startWallet = async ({ shieldedSecretKeys, dustSecretKey, unshieldedKeystore }) => {
  const configuration = {
    networkId: NETWORK,
    indexerClientConnection: {
      indexerHttpUrl: INDEXER,
      indexerWsUrl: INDEXER_WS,
      // The default lets 10,000 events sit in flight between the socket and the
      // apply loop. The dust wallet applies far slower than the indexer pushes,
      // so that queue stays full and every event in it is a live object — which
      // is how a cold sync ends as an OOM rather than a wait.
      bufferSize: 250,
      resumeThreshold: 25,
    },
    // The default is 10 events per batch with 4ms of spacing, which is fine for
    // a live wallet and slow for a 1.5M-event backfill. Bigger batches help the
    // shielded wallet a lot and the dust wallet barely, so this is only as big
    // as memory allows rather than as big as possible.
    batchUpdates: { size: 100, timeout: 100, spacing: 0 },
    relayURL: new URL(NODE),
    provingServerUrl: new URL(PROOF_SERVER),
    // Nothing here ever reads transaction history, and keeping it costs real
    // memory: the in-memory store accumulates an entry per applied event, and
    // preprod is 1.5M events deep. That is what was killing balancing.
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    // The dust balancer is a fixed-point loop with no iteration cap: it picks
    // coins to cover the fee, then recomputes the fee including the cost of the
    // inputs it just picked. Ask for a fat margin and a call transaction - which
    // carries a proof, so it is large - needs enough small dust coins that each
    // new input costs more than it contributes, and the loop never converges.
    // It does not hang in any observable way either, because it runs
    // synchronously through Effect.runSync: the event loop stops, so no timer
    // fires and nothing is logged.
    costParameters: {
      feeBlocksMargin: Number(process.env.MIDNIGHT_FEE_MARGIN ?? 1),
      // The overhead is what makes the dust balancer terminate. Its loop only
      // stops when the coins it selected cover the fee it then recomputes - but
      // it selects them to cover the *previous* fee, so coverage is always one
      // step behind, and on a call transaction the fee keeps growing by the
      // cost of the input just added. Over-asking up front puts the first
      // selection above the final fee, and the fixed point is reached at once.
      additionalFeeOverhead: BigInt(process.env.MIDNIGHT_FEE_OVERHEAD ?? 1_000_000_000_000n),
    },
  };

  const cache = loadCache();
  if (cache.dust) console.log(`resuming from ${CACHE_FILE}`);

  const facade = await WalletFacade.init({
    configuration,
    submissionService: () => makeSubmissionService(),
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
export const registerDust = async (facade, state, keys) => {
  const nightUtxos = state.unshielded.availableCoins.filter(
    (c) => c.utxo.type === NIGHT && !c.meta.registeredForDustGeneration,
  );
  if (nightUtxos.length === 0) die('No unregistered NIGHT UTXOs to register.');

  const { fee } = await facade.estimateRegistration(nightUtxos);
  console.log(`registering ${nightUtxos.length} NIGHT utxo(s), fee ${fee}`);
  step('waiting for projected dust to cover the fee');
  await facade.waitForGeneratedDust(nightUtxos, fee, { timeoutMs: 1_800_000 });

  const { unshieldedKeystore } = keys;
  step('building the registration transaction');
  const recipe = await facade.registerNightUtxosForDustGeneration(
    nightUtxos,
    unshieldedKeystore.getPublicKey(),
    (payload) => unshieldedKeystore.signData(payload),
  );
  // Not balanced on purpose. A registration pays its own fee out of the dust
  // its UTXOs have already generated, so asking the wallet to balance it means
  // asking for DUST that only exists after this transaction lands — and the
  // balancer waits for it rather than failing.
  step('proving');
  const finalized = await facade.finalizeRecipe(recipe);
  step('submitting');
  const txId = await facade.submitTransaction(finalized);
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
  // Each of these can take minutes and says nothing while it does, so they
  // announce themselves. A stall with no output is indistinguishable from slow.
  async balanceTx(tx, ttl = new Date(Date.now() + 3_600_000)) {
    const { shieldedSecretKeys, dustSecretKey } = this.keys;
    step('balancing');
    const recipe = await deadline(
      // Unshielded then dust, never shielded. The shielded wallet holds no
      // coins and asking it to balance nothing hangs instead of returning.
      // Dropping unshielded too is not an option: dust balances whatever the
      // unshielded step produced, and handed the raw transaction instead the
      // ledger panics with `unreachable` from inside the wasm.
      this.facade.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys, dustSecretKey },
        { ttl, tokenKindsToBalance: BALANCE_KINDS },
      ),
      'balancing',
    );
    step('finalizing (proving)');
    const finalized = await this.facade.finalizeRecipe(recipe);
    step('balanced');
    return finalized;
  }
  async submitTx(tx) {
    step('submitting');
    const id = await this.facade.submitTransaction(tx);
    step(`submitted ${String(id).slice(0, 18)}`);
    return id;
  }
}


// Brings up a wallet against NETWORK and returns everything a CLI needs to
// touch the chain. Refuses to continue if the wallet cannot pay: an unfunded
// wallet stops here, an unregistered one registers itself and stops.
export const connect = async () => {
  setNetworkId(NETWORK);

  const seed = seedHex();
  const keys = deriveKeys(Uint8Array.from(Buffer.from(seed, 'hex')));
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
        'run this again once there is a balance to pay the fee with.',
    );
  }

  const walletProvider = new FacadeProvider(facade, keys);
  const zkConfigProvider = new NodeZkConfigProvider(managed);
  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'senyap-private-state',
      signingKeyStoreName: 'senyap-signing-keys',
      // Derived from the seed, not the env var, which is usually empty because
      // the seed lives in .wallet/. The prefix is not decoration: the store
      // demands three of four character classes and hex is only two.
      privateStoragePasswordProvider: () => `Senyap!${seed}`,
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

  return { facade, state, providers, compiled, nightAddress, stop: () => facade.stop() };
};

// A private state store that rejects its password throws only once a
// transaction has already landed, and takes the contract address with it.
// Prove the store works while failing is still free.
export const preflightPrivateState = async (providers) => {
  providers.privateStateProvider.setContractAddress(sampleContractAddress());
  await providers.privateStateProvider.set('senyap-preflight', emptyPrivateState());
  await providers.privateStateProvider.remove('senyap-preflight');
};

// The SDK wraps failures in tagged errors whose own message is a category, not
// a reason: "Transaction submission error" tells you nothing without the cause
// underneath it. Effect then rethrows as a FiberFailure that keeps the real
// cause on a symbol, so the chain alone comes back empty and inspect() is the
// only thing that sees all of it.
const explain = (e, depth = 0) => {
  if (!e || depth > 5) return '';
  const head = e.message ?? String(e);
  const extra = Object.entries(e)
    .filter(([k, v]) => k !== 'cause' && k !== 'stack' && typeof v !== 'function')
    .map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');
  return [head, extra, explain(e.cause, depth + 1)].filter(Boolean).join('\n');
};

export const run = (main) =>
  main().catch((e) =>
    die(`${explain(e)}\n\n${inspect(e, { depth: 8, showHidden: true, colors: false })}`),
  );

export { NETWORK, root, deployRecordPath };
