import pino from 'pino';
import { env } from './env.ts';

export const log = pino({
  level: env.LOG_LEVEL ?? 'info',
  redact: ['env.PRIVATE_KEY', 'env.ORACLE_API_KEY', 'env.RPC_URL'],
});
