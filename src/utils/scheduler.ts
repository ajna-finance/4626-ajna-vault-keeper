import { config, resolveArkSettings } from './config.ts';
import { client } from './client.ts';
import { log } from './logger.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { metavaultRun } from '../keepers/metavaultKeeper.ts';
import { arkRun } from '../keepers/arkKeeper.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function runKeeperInterval() {
  if (await _hasPendingTransaction()) return;

  if (config.metavaultAddress) {
    try {
      await metavaultRun();
    } catch (e) {
      log.error(
        { event: 'metavault_run_failed', err: e },
        'metavault run failed; continuing to ark runs',
      );
    }
  }

  for (const ark of config.arks) {
    try {
      const settings = resolveArkSettings(ark);
      await arkRun(ark.vaultAddress, ark.vaultAuthAddress, settings);
    } catch (e) {
      log.error(
        { event: 'ark_run_failed', ark: ark.vaultAddress, vaultAuth: ark.vaultAuthAddress, err: e },
        `ark run failed for ${ark.vaultAddress}; continuing to next ark`,
      );
    }
  }
}

async function _hasPendingTransaction(): Promise<boolean> {
  const address = client.account.address;
  const [pending, latest] = await Promise.all([
    client.getTransactionCount({ address, blockTag: 'pending' }),
    client.getTransactionCount({ address, blockTag: 'latest' }),
  ]);

  if (pending > latest) {
    log.warn(
      { event: 'pending_transaction_detected', address, pending, latest },
      'skipping keeper run: a previously submitted transaction is still pending',
    );
    return true;
  }
  return false;
}

export function startScheduler() {
  const interval = config.keeper.intervalMs;

  const ac = new AbortController();
  const { signal } = ac;

  const stop = () => {
    log.info({ event: 'keeper_stopping' }, 'keeper stopping');
    ac.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  (async () => {
    while (!signal.aborted) {
      try {
        await runKeeperInterval();
      } catch (e) {
        log.error(
          { event: 'keeper_run_failed', err: e },
          `keeper run failed, attempting again in ${interval} ms`,
        );
      }

      try {
        await sleep(interval, undefined, { signal });
      } catch (err: any) {
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') break;
        throw err;
      }
    }
  })();
}
