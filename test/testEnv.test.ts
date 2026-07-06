import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CREDENTIAL_ENV_KEYS,
  createTestConfigPath,
  loadTestEnv,
  removeTestConfigPath,
} from './setup/testEnv.ts';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function writeEnvFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ajna-keeper-test-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, contents);
  return file;
}

describe('loadTestEnv', () => {
  afterEach(restoreEnv);

  it('loads non-credential vars from the env file into process.env', () => {
    delete process.env.CUSTOM_KEEPER_ENV_A;
    delete process.env.CUSTOM_KEEPER_ENV_B;
    const envFile = writeEnvFile('CUSTOM_KEEPER_ENV_A=value-a\nCUSTOM_KEEPER_ENV_B=value-b\n');

    loadTestEnv(envFile);

    expect(process.env.CUSTOM_KEEPER_ENV_A).toBe('value-a');
    expect(process.env.CUSTOM_KEEPER_ENV_B).toBe('value-b');
  });

  it('strips every credential-mode key from process.env after loading', () => {
    const envFile = writeEnvFile(
      [
        'PRIVATE_KEY=0xabc',
        'KEYSTORE_PATH=/keys/k.json',
        'REMOTE_SIGNER_URL=https://signer.example',
        'REMOTE_SIGNER_ADDRESS=0x00000000000000000000000000000000000000A1',
        'REMOTE_SIGNER_ALLOW_INSECURE=true',
        'REMOTE_SIGNER_AUTH_TOKEN=tok',
        'REMOTE_SIGNER_TLS_CLIENT_CERT=/tls/c.pem',
        'REMOTE_SIGNER_TLS_CLIENT_KEY=/tls/c.key',
        'REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD=pw',
        'REMOTE_SIGNER_TLS_CA=/tls/ca.pem',
        'CUSTOM_KEEPER_ENV_FOR_TEST=value-from-test-env-file',
      ].join('\n'),
    );
    delete process.env.CUSTOM_KEEPER_ENV_FOR_TEST;

    loadTestEnv(envFile);

    for (const key of CREDENTIAL_ENV_KEYS) {
      expect(process.env[key], `${key} should be cleared`).toBeUndefined();
    }
    expect(process.env.CUSTOM_KEEPER_ENV_FOR_TEST).toBe('value-from-test-env-file');
  });

  it('strips credential keys that were already in process.env before the call', () => {
    process.env.KEYSTORE_PATH = '/preset/key.json';
    process.env.REMOTE_SIGNER_URL = 'https://preset.signer';
    process.env.REMOTE_SIGNER_ADDRESS = '0x00000000000000000000000000000000000000A2';

    loadTestEnv(join(tmpdir(), 'this-file-does-not-exist'));

    expect(process.env.KEYSTORE_PATH).toBeUndefined();
    expect(process.env.REMOTE_SIGNER_URL).toBeUndefined();
    expect(process.env.REMOTE_SIGNER_ADDRESS).toBeUndefined();
  });

  it('does not throw when the env file is missing', () => {
    expect(() => loadTestEnv(join(tmpdir(), 'missing-env-file-' + Date.now()))).not.toThrow();
  });

  it('lists exactly the set of credential keys that env.ts inspects', () => {
    const envSource = readFileSync(
      join(import.meta.dirname, '..', 'src', 'utils', 'env.ts'),
      'utf-8',
    );
    const referenced = new Set<string>();
    for (const match of envSource.matchAll(/readOptionalEnv\('([A-Z_]+)'\)/g)) {
      referenced.add(match[1]!);
    }
    expect(referenced.size).toBeGreaterThan(0);
    for (const key of referenced) {
      expect(CREDENTIAL_ENV_KEYS).toContain(key);
    }
  });
});

describe('createTestConfigPath / removeTestConfigPath', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const p of created.splice(0)) removeTestConfigPath(p);
  });

  it('returns a path whose parent directory exists and is unique per call', () => {
    const a = createTestConfigPath();
    const b = createTestConfigPath();
    created.push(a, b);

    expect(a).not.toBe(b);
    for (const p of [a, b]) {
      const parent = join(p, '..');
      expect(existsSync(parent)).toBe(true);
      expect(statSync(parent).isDirectory()).toBe(true);
      expect(parent.includes('ajna-keeper-test-')).toBe(true);
    }
  });

  it('lets the caller write the generated config and read it back', () => {
    const configPath = createTestConfigPath();
    created.push(configPath);

    writeFileSync(configPath, '{"chainId":1}');

    expect(readFileSync(configPath, 'utf-8')).toBe('{"chainId":1}');
  });

  it('removes the entire temp directory created by createTestConfigPath', () => {
    const configPath = createTestConfigPath();
    writeFileSync(configPath, '{}');
    const parent = join(configPath, '..');

    removeTestConfigPath(configPath);

    expect(existsSync(parent)).toBe(false);
  });

  it('is a no-op when given undefined', () => {
    expect(() => removeTestConfigPath(undefined)).not.toThrow();
  });

  it('is a no-op when the directory was already removed', () => {
    const configPath = createTestConfigPath();
    removeTestConfigPath(configPath);
    expect(() => removeTestConfigPath(configPath)).not.toThrow();
  });

  it('refuses to delete when given a relative path', () => {
    expect(() => removeTestConfigPath('config.json')).toThrow(/requires an absolute path/);
  });

  it('refuses to delete a parent dir outside tmpdir', () => {
    expect(() => removeTestConfigPath('/etc/passwd')).toThrow(/must be a subdirectory of/);
  });

  it('refuses to delete tmpdir itself', () => {
    expect(() => removeTestConfigPath(join(tmpdir(), 'config.json'))).toThrow(
      /must be a subdirectory of/,
    );
  });

  it('refuses paths that normalize to outside tmpdir via .. traversal', () => {
    expect(() =>
      removeTestConfigPath(join(tmpdir(), 'foo', '..', '..', 'etc', 'config.json')),
    ).toThrow(/must be a subdirectory of/);
  });
});

describe('global setup does not clobber the developer config.json', () => {
  it('points CONFIG_PATH at a per-run temp file instead of cwd/config.json', () => {
    const configPath = process.env.CONFIG_PATH;
    expect(configPath, 'global setup must set CONFIG_PATH').toBeDefined();
    expect(configPath).not.toBe(join(process.cwd(), 'config.json'));
    expect(configPath!.includes('ajna-keeper-test-')).toBe(true);
    expect(existsSync(configPath!)).toBe(true);
  });
});
