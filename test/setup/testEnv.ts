import dotenv from 'dotenv';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, relative } from 'path';

export const CREDENTIAL_ENV_KEYS = [
  'PRIVATE_KEY',
  'KEYSTORE_PATH',
  'REMOTE_SIGNER_URL',
  'REMOTE_SIGNER_ADDRESS',
  'REMOTE_SIGNER_ALLOW_INSECURE',
  'REMOTE_SIGNER_AUTH_TOKEN',
  'REMOTE_SIGNER_TLS_CLIENT_CERT',
  'REMOTE_SIGNER_TLS_CLIENT_KEY',
  'REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD',
  'REMOTE_SIGNER_TLS_CA',
] as const;

export function loadTestEnv(envPath: string): void {
  dotenv.config({ path: envPath });
  for (const key of CREDENTIAL_ENV_KEYS) {
    delete process.env[key];
  }
}

export function createTestConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ajna-keeper-test-'));
  return join(dir, 'config.json');
}

export function removeTestConfigPath(configPath: string | undefined): void {
  if (!configPath) return;
  if (!isAbsolute(configPath)) {
    throw new Error(`removeTestConfigPath requires an absolute path (got '${configPath}')`);
  }
  const parent = join(configPath, '..');
  const rel = relative(tmpdir(), parent);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `removeTestConfigPath refuses to remove '${parent}' (must be a subdirectory of ${tmpdir()})`,
    );
  }
  rmSync(parent, { recursive: true, force: true });
}
