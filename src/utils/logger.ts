import pino from 'pino';
import { config } from './config.ts';

const redact = [
  'env.PRIVATE_KEY',
  'env.ORACLE_API_KEY',
  'env.REMOTE_SIGNER_URL',
  'env.REMOTE_SIGNER_AUTH_TOKEN',
  'env.REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD',
  'env.RPC_URL',
];

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const SENSITIVE_ERROR_KEYS = new Set(['url', 'headers', 'body', 'raw']);

function maskSecrets(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return value.replace(URL_PATTERN, '[redacted-url]');
  if (Array.isArray(value)) return value.map((entry) => maskSecrets(entry, seen));
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const masked: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_ERROR_KEYS.has(key)) continue;
      masked[key] = maskSecrets(entry, seen);
    }
    return masked;
  }
  return value;
}

export function serializeError(err: unknown): unknown {
  return maskSecrets(pino.stdSerializers.err(err as Error), new WeakSet());
}

const serializers = { err: serializeError, error: serializeError };
const destination = pino.destination({ sync: true });

export const log = pino(
  {
    level: config.keeper.logLevel ?? 'info',
    redact,
    serializers,
  },
  destination,
);

// Startup safety notices should remain visible even when the main logger is configured more strictly.
export const startupNoticeLog = pino(
  {
    level: 'warn',
    redact,
    serializers,
  },
  destination,
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
