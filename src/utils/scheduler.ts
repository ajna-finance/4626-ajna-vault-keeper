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
import { createSwapExecutor } from '../ark/swapAdapters/index.ts';
import type { SwapExecutor } from '../ark/swapExecutor.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Built once at startup for the execute modes; undefined lets recoveryExecute fall
// back to its fail-closed UnconfiguredSwapExecutor default.
let swapExecutor: SwapExecutor | undefined;

export async function runKeeperInterval() {
  if (config.metavaultAddress) {
    await metavaultRun();
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

async function runRecoveryDetect() {
  for (const target of getRecoveryTargets()) {
    await recoveryDetectOnly(target);
  }
}

// True only when every enabled ark ran without needing operator attention —
// recovery-oneshot turns this into its process exit code.
async function runRecoveryExecute(): Promise<boolean> {
  let allOk = true;
  for (const target of getRecoveryTargets()) {
    if (!target.settings.enabled) {
      log.info(
        { event: 'recovery_skipped', ark: target.vaultAddress, reason: 'disabled_by_config' },
        'recovery disabled for this ark',
      );
      continue;
    }
    try {
      const ok = await recoveryExecute(target, swapExecutor);
      allOk &&= ok;
    } catch (e) {
      // Per-ark isolation, mirroring runKeeperInterval: one ark's thrown RPC error
      // must not skip the remaining arks this tick.
      log.error(
        { event: 'recovery_run_failed', ark: target.vaultAddress, err: e },
        `recovery run failed for ${target.vaultAddress}; continuing to next ark`,
      );
      allOk = false;
    }
  }
  return allOk;
}

async function runOnce(): Promise<boolean | void> {
  switch (env.BOT_MODE) {
    case 'scheduler':
      return runKeeperInterval();
    case 'recovery-detect':
      return runRecoveryDetect();
    case 'recovery-auto':
    case 'recovery-oneshot':
      return runRecoveryExecute();
    default: {
      const unreachable: never = env.BOT_MODE;
      throw new Error(`Unhandled BOT_MODE: ${unreachable}`);
    }
  }
}

export function startScheduler() {
  const interval = config.keeper.intervalMs;
  const isOneShot = env.BOT_MODE === 'recovery-oneshot';

  if (env.BOT_MODE === 'recovery-auto' || env.BOT_MODE === 'recovery-oneshot') {
    // Fail closed at startup: a misconfigured adapter must not tick-loop with the
    // swapper key loaded. With no swapExecutor block configured this returns the
    // UnconfiguredSwapExecutor, which the keeper's preflight probe handles per run.
    try {
      swapExecutor = createSwapExecutor();
    } catch (e) {
      log.error({ event: 'swap_executor_init_failed', err: e }, 'swap executor init failed');
      process.exit(1);
      return;
    }
    log.info(
      {
        event: 'swap_executor_configured',
        adapter: config.recovery.swapExecutor?.adapter ?? 'unconfigured',
      },
      'swap executor ready',
    );
  }

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
      let ok = false;
      try {
        ok = (await runOnce()) === true;
      } catch (e) {
        log.error({ event: 'keeper_run_failed', err: e }, 'recovery-oneshot run failed');
        process.exit(1);
        return;
      }
      if (!ok) {
        log.error(
          { event: 'recovery_oneshot_incomplete', mode: env.BOT_MODE },
          'recovery-oneshot finished with at least one ark needing operator attention',
        );
      }
      // Exit code carries the outcome: operator runbooks chain on it
      // (`recovery-oneshot && resume`), so a swallowed failure must not exit 0.
      process.exit(ok ? 0 : 1);
      return;
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
