import pino from 'pino';
import { env } from './env.ts';

export const log = pino(
  {
    level: env.LOG_LEVEL ?? 'info',
    redact: ['env.PRIVATE_KEY', 'env.ORACLE_API_KEY', 'env.RPC_URL'],
  },
  pino.destination({ sync: true }),
);

export function setUpCrashHandlers() {
  process.on('uncaughtException', (err) => {
    log.fatal({ event: 'uncaught_exception', err }, 'uncaughtException, process exiting');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.fatal(
      {
        event: 'unhandled_rejection',
        err: reason instanceof Error ? reason : new Error(String(reason)),
      },
      'unhandledRejection, process exiting',
    );
    process.exit(1);
  });
}
