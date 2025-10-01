import { env } from './env';
import { log } from './logger';
import { setTimeout as sleep } from 'node:timers/promises';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function startScheduler(run: () => Promise<void> | void) {
  const interval = env.KEEPER_INTERVAL_MS;

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
        await run();
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
