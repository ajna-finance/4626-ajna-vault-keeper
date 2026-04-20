import { config, resolveArkSettings } from './config.ts';
import { env } from './env.ts';
import { log } from './logger.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { metavaultRun } from '../keepers/metavaultKeeper.ts';
import { arkRun } from '../keepers/arkKeeper.ts';
import {
  detectOnly as recoveryDetectOnly,
  execute as recoveryExecute,
  getRecoveryTargets,
} from '../keepers/recoveryKeeper.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function runScheduler() {
  if (config.metavaultAddress) {
    await metavaultRun();
  }

  for (const ark of config.arks) {
    const settings = resolveArkSettings(ark);
    await arkRun(ark.vaultAddress, ark.vaultAuthAddress, settings);
  }
}

async function runRecoveryDetect() {
  for (const target of getRecoveryTargets()) {
    await recoveryDetectOnly(target);
  }
}

async function runRecoveryExecute() {
  for (const target of getRecoveryTargets()) {
    if (!target.settings.enabled) {
      log.info(
        { event: 'recovery_skipped', ark: target.vaultAddress, reason: 'disabled_by_config' },
        'recovery disabled for this ark',
      );
      continue;
    }
    await recoveryExecute(target);
  }
}

async function runOnce() {
  switch (env.BOT_MODE) {
    case 'scheduler':
      return runScheduler();
    case 'recovery-detect':
      return runRecoveryDetect();
    case 'recovery-auto':
      return runRecoveryExecute();
    case 'recovery-oneshot':
      return runRecoveryExecute();
  }
}

export function startScheduler() {
  const interval = config.keeper.intervalMs;
  const isOneShot = env.BOT_MODE === 'recovery-oneshot';

  const ac = new AbortController();
  const { signal } = ac;

  const stop = () => {
    log.info({ event: 'keeper_stopping', mode: env.BOT_MODE }, 'keeper stopping');
    ac.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  log.info({ event: 'keeper_starting', mode: env.BOT_MODE }, `starting BOT_MODE=${env.BOT_MODE}`);

  (async () => {
    if (isOneShot) {
      try {
        await runOnce();
      } catch (e) {
        log.error({ event: 'keeper_run_failed', err: e }, 'recovery-oneshot run failed');
        process.exit(1);
      }
      process.exit(0);
    }

    while (!signal.aborted) {
      try {
        await runOnce();
      } catch (e) {
        log.error(
          { event: 'keeper_run_failed', err: e, mode: env.BOT_MODE },
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
