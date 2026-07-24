import { readFileSync } from 'fs';

const REQUIRED = ['RPC_URL'] as const;

function readOptionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function assertReadableFile(envVar: string, path: string): void {
  try {
    readFileSync(path);
  } catch (cause) {
    throw new Error(`${envVar} points to a file that is not readable: '${path}'`, { cause });
  }
}

export type CredentialMode = 'privateKey' | 'keystore' | 'remoteSigner';

for (const key of REQUIRED) {
  if (!process.env[key]) {
    throw new Error(`${key} must be specified`);
  }
}

const PRIVATE_KEY = readOptionalEnv('PRIVATE_KEY');
const KEYSTORE_PATH = readOptionalEnv('KEYSTORE_PATH');
const REMOTE_SIGNER_URL = readOptionalEnv('REMOTE_SIGNER_URL');
const REMOTE_SIGNER_ADDRESS = readOptionalEnv('REMOTE_SIGNER_ADDRESS');
const REMOTE_SIGNER_ALLOW_INSECURE = readOptionalEnv('REMOTE_SIGNER_ALLOW_INSECURE') === 'true';
const REMOTE_SIGNER_AUTH_TOKEN = readOptionalEnv('REMOTE_SIGNER_AUTH_TOKEN');
const REMOTE_SIGNER_TLS_CLIENT_CERT = readOptionalEnv('REMOTE_SIGNER_TLS_CLIENT_CERT');
const REMOTE_SIGNER_TLS_CLIENT_KEY = readOptionalEnv('REMOTE_SIGNER_TLS_CLIENT_KEY');
const REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD = readOptionalEnv(
  'REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD',
);
const REMOTE_SIGNER_TLS_CA = readOptionalEnv('REMOTE_SIGNER_TLS_CA');

if (REMOTE_SIGNER_URL !== undefined) {
  let parsed: URL;
  try {
    parsed = new URL(REMOTE_SIGNER_URL);
  } catch {
    throw new Error(`REMOTE_SIGNER_URL is not a valid URL: '${REMOTE_SIGNER_URL}'`);
  }

  if (parsed.protocol === 'http:') {
    if (!REMOTE_SIGNER_ALLOW_INSECURE) {
      throw new Error(
        'REMOTE_SIGNER_URL must use https. To allow http for local testing, set REMOTE_SIGNER_ALLOW_INSECURE=true.',
      );
    }
  } else if (parsed.protocol !== 'https:') {
    throw new Error(`REMOTE_SIGNER_URL must use https (got '${parsed.protocol}')`);
  }
}

if (Boolean(REMOTE_SIGNER_URL) !== Boolean(REMOTE_SIGNER_ADDRESS)) {
  throw new Error('REMOTE_SIGNER_URL and REMOTE_SIGNER_ADDRESS must both be specified together');
}

if (Boolean(REMOTE_SIGNER_TLS_CLIENT_CERT) !== Boolean(REMOTE_SIGNER_TLS_CLIENT_KEY)) {
  throw new Error(
    'REMOTE_SIGNER_TLS_CLIENT_CERT and REMOTE_SIGNER_TLS_CLIENT_KEY must both be specified together',
  );
}

if (
  REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD !== undefined &&
  REMOTE_SIGNER_TLS_CLIENT_KEY === undefined
) {
  throw new Error(
    'REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD requires REMOTE_SIGNER_TLS_CLIENT_KEY to be set',
  );
}

if (REMOTE_SIGNER_TLS_CLIENT_CERT !== undefined) {
  assertReadableFile('REMOTE_SIGNER_TLS_CLIENT_CERT', REMOTE_SIGNER_TLS_CLIENT_CERT);
}

if (REMOTE_SIGNER_TLS_CLIENT_KEY !== undefined) {
  assertReadableFile('REMOTE_SIGNER_TLS_CLIENT_KEY', REMOTE_SIGNER_TLS_CLIENT_KEY);
}

if (REMOTE_SIGNER_TLS_CA !== undefined) {
  assertReadableFile('REMOTE_SIGNER_TLS_CA', REMOTE_SIGNER_TLS_CA);
}

const credentialModes = [
  PRIVATE_KEY ? 'privateKey' : null,
  KEYSTORE_PATH ? 'keystore' : null,
  REMOTE_SIGNER_URL ? 'remoteSigner' : null,
].filter((mode): mode is CredentialMode => mode !== null);

if (credentialModes.length !== 1) {
  throw new Error(
    'Configure exactly one credential mode: PRIVATE_KEY, KEYSTORE_PATH, or REMOTE_SIGNER_URL with REMOTE_SIGNER_ADDRESS',
  );
}

if (process.env.ORACLE_API_KEY && !process.env.ORACLE_API_TIER) {
  throw new Error('API key tier must be specified');
}

export const credentialMode = credentialModes[0]!;

export const env = {
  RPC_URL: process.env.RPC_URL!,
  PRIVATE_KEY,
  KEYSTORE_PATH,
  REMOTE_SIGNER_URL,
  REMOTE_SIGNER_ADDRESS,
  REMOTE_SIGNER_ALLOW_INSECURE,
  REMOTE_SIGNER_AUTH_TOKEN,
  REMOTE_SIGNER_TLS_CLIENT_CERT,
  REMOTE_SIGNER_TLS_CLIENT_KEY,
  REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD,
  REMOTE_SIGNER_TLS_CA,
  ORACLE_API_KEY: process.env.ORACLE_API_KEY,
  ORACLE_API_TIER: process.env.ORACLE_API_TIER,
};
