// Reads the deployed contract's public state straight from the preprod indexer.
//
// This is the half of a taker console that needs no wallet: anyone can check
// what the chain holds. It runs the same `ledger()` decoder the tests and the
// CLI use, so what the page shows is the contract's own view of its state, not
// a re-implementation of it that could drift.
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { ledger } from '../src/managed/senyap/contract/index.js';
import record from '../deploy/preprod.json';

const INDEXER =
  import.meta.env?.VITE_MIDNIGHT_INDEXER ??
  `https://indexer.${record.network}.midnight.network/api/v4/graphql`;

export const deployed = record;

export const explorerNote = `${record.network} · ${record.address}`;

// Decoding is where a stale deployment shows up: the contract on chain was
// built from whatever circuits existed then, and ledger() is built from the
// ones in this bundle. A mismatch throws somewhere inside the decoder with no
// useful message, so it is caught and named here.
export const readLive = async () => {
  setNetworkId(record.network);
  // The third argument matters in a browser: the provider defaults to the `ws`
  // package's WebSocket, which does not exist here. Passing the platform's own
  // keeps the node dependency out of the bundle's runtime path.
  const provider = indexerPublicDataProvider(
    INDEXER,
    INDEXER.replace(/^http/, 'ws') + '/ws',
    WebSocket,
  );

  const state = await provider.queryContractState(record.address);
  if (!state) {
    return { ok: false, reason: `no contract at ${record.address} on ${record.network}` };
  }

  try {
    const l = ledger(state.data);
    return {
      ok: true,
      root: l.quotes.root().field.toString(16).padStart(64, '0'),
      leaves: l.quotes.firstFree(),
      fills: l.fills,
      nullifiers: l.spent.size(),
      lastFillPrice: l.lastFillPrice,
      referencePrice: l.referencePrice,
      bandBps: l.bandBps,
    };
  } catch (e) {
    return {
      ok: false,
      reason:
        'the contract on chain was built from different circuits than this page ' +
        `(${e?.message ?? e})`,
    };
  }
};
