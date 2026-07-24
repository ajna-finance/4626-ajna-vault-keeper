import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setCredentialTestEnv(overrides: Record<string, string | undefined>): void {
  restoreEnv(ORIGINAL_ENV);
  process.env.RPC_URL = 'https://rpc.example';

  delete process.env.PRIVATE_KEY;
  delete process.env.KEYSTORE_PATH;
  delete process.env.REMOTE_SIGNER_URL;
  delete process.env.REMOTE_SIGNER_ADDRESS;
  delete process.env.REMOTE_SIGNER_ALLOW_INSECURE;
  delete process.env.REMOTE_SIGNER_AUTH_TOKEN;
  delete process.env.REMOTE_SIGNER_TLS_CLIENT_CERT;
  delete process.env.REMOTE_SIGNER_TLS_CLIENT_KEY;
  delete process.env.REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD;
  delete process.env.REMOTE_SIGNER_TLS_CA;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
  vi.resetModules();
  vi.doUnmock('dotenv/config');
});

describe('credential mode validation', () => {
  it('rejects ambiguous credential configuration', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      KEYSTORE_PATH: './keystore/keeper-key.json',
      PRIVATE_KEY: '0xabc123',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      'Configure exactly one credential mode',
    );
  });

  it('rejects partial remote signer configuration', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      'REMOTE_SIGNER_URL and REMOTE_SIGNER_ADDRESS must both be specified together',
    );
  });

  it('accepts the remote signer credential mode', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    const { credentialMode, env } = await import('../../src/utils/env.ts');

    expect(credentialMode).toBe('remoteSigner');
    expect(env.PRIVATE_KEY).toBeUndefined();
    expect(env.KEYSTORE_PATH).toBeUndefined();
    expect(env.REMOTE_SIGNER_URL).toBe('https://signer.example');
    expect(env.REMOTE_SIGNER_ADDRESS).toBe('0x00000000000000000000000000000000000000A1');
  });

  it('rejects a malformed REMOTE_SIGNER_URL', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_URL: 'not-a-url',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      "REMOTE_SIGNER_URL is not a valid URL: 'not-a-url'",
    );
  });

  it('rejects an http REMOTE_SIGNER_URL without the insecure escape hatch', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_URL: 'http://signer.example',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      'REMOTE_SIGNER_URL must use https. To allow http for local testing, set REMOTE_SIGNER_ALLOW_INSECURE=true.',
    );
  });

  it('accepts an http REMOTE_SIGNER_URL when REMOTE_SIGNER_ALLOW_INSECURE=true', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_ALLOW_INSECURE: 'true',
      REMOTE_SIGNER_URL: 'http://signer.example',
    });

    const { credentialMode, env } = await import('../../src/utils/env.ts');

    expect(credentialMode).toBe('remoteSigner');
    expect(env.REMOTE_SIGNER_URL).toBe('http://signer.example');
    expect(env.REMOTE_SIGNER_ALLOW_INSECURE).toBe(true);
  });

  it('accepts an https REMOTE_SIGNER_URL', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    const { credentialMode, env } = await import('../../src/utils/env.ts');

    expect(credentialMode).toBe('remoteSigner');
    expect(env.REMOTE_SIGNER_URL).toBe('https://signer.example');
    expect(env.REMOTE_SIGNER_ALLOW_INSECURE).toBe(false);
  });

  it('rejects a non-http(s) REMOTE_SIGNER_URL even when REMOTE_SIGNER_ALLOW_INSECURE=true', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_ALLOW_INSECURE: 'true',
      REMOTE_SIGNER_URL: 'ws://signer.example',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      "REMOTE_SIGNER_URL must use https (got 'ws:')",
    );
  });

  it('treats REMOTE_SIGNER_ALLOW_INSECURE values other than the literal string "true" as false', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_ALLOW_INSECURE: '1',
      REMOTE_SIGNER_URL: 'http://signer.example',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      'REMOTE_SIGNER_URL must use https',
    );
  });

  it('reports a malformed REMOTE_SIGNER_URL before the credential-mode mutual-exclusion check', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      PRIVATE_KEY: '0xabc123',
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_URL: 'not-a-url',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      'REMOTE_SIGNER_URL is not a valid URL',
    );
  });
});

describe('remote signer TLS validation', () => {
  let tmpDir: string;
  let certPath: string;
  let keyPath: string;
  let caPath: string;
  let missingPath: string;

  function createTlsFiles(): void {
    tmpDir = mkdtempSync(join(tmpdir(), 'env-tls-test-'));
    certPath = join(tmpDir, 'client.pem');
    keyPath = join(tmpDir, 'client.key');
    caPath = join(tmpDir, 'ca.pem');
    missingPath = join(tmpDir, 'does-not-exist.pem');
    writeFileSync(
      certPath,
      '-----BEGIN CERTIFICATE-----\nplaceholder\n-----END CERTIFICATE-----\n',
    );
    writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----\n');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nplaceholder\n-----END CERTIFICATE-----\n');
  }

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { force: true, recursive: true });
  });

  it('rejects setting REMOTE_SIGNER_TLS_CLIENT_CERT without REMOTE_SIGNER_TLS_CLIENT_KEY', async () => {
    createTlsFiles();
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_TLS_CLIENT_CERT: certPath,
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      'REMOTE_SIGNER_TLS_CLIENT_CERT and REMOTE_SIGNER_TLS_CLIENT_KEY must both be specified together',
    );
  });

  it('rejects setting REMOTE_SIGNER_TLS_CLIENT_KEY without REMOTE_SIGNER_TLS_CLIENT_CERT', async () => {
    createTlsFiles();
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_TLS_CLIENT_KEY: keyPath,
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      'REMOTE_SIGNER_TLS_CLIENT_CERT and REMOTE_SIGNER_TLS_CLIENT_KEY must both be specified together',
    );
  });

  it('rejects setting REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD without REMOTE_SIGNER_TLS_CLIENT_KEY', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD: 'secret',
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      'REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD requires REMOTE_SIGNER_TLS_CLIENT_KEY to be set',
    );
  });

  it('rejects a non-existent REMOTE_SIGNER_TLS_CLIENT_CERT path', async () => {
    createTlsFiles();
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_TLS_CLIENT_CERT: missingPath,
      REMOTE_SIGNER_TLS_CLIENT_KEY: keyPath,
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      `REMOTE_SIGNER_TLS_CLIENT_CERT points to a file that is not readable: '${missingPath}'`,
    );
  });

  it('rejects a non-existent REMOTE_SIGNER_TLS_CLIENT_KEY path', async () => {
    createTlsFiles();
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_TLS_CLIENT_CERT: certPath,
      REMOTE_SIGNER_TLS_CLIENT_KEY: missingPath,
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      `REMOTE_SIGNER_TLS_CLIENT_KEY points to a file that is not readable: '${missingPath}'`,
    );
  });

  it('rejects a non-existent REMOTE_SIGNER_TLS_CA path', async () => {
    createTlsFiles();
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_TLS_CA: missingPath,
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      `REMOTE_SIGNER_TLS_CA points to a file that is not readable: '${missingPath}'`,
    );
  });

  it('accepts REMOTE_SIGNER_TLS_CLIENT_CERT and REMOTE_SIGNER_TLS_CLIENT_KEY when both point to readable files', async () => {
    createTlsFiles();
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_TLS_CLIENT_CERT: certPath,
      REMOTE_SIGNER_TLS_CLIENT_KEY: keyPath,
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    const { env } = await import('../../src/utils/env.ts');

    expect(env.REMOTE_SIGNER_TLS_CLIENT_CERT).toBe(certPath);
    expect(env.REMOTE_SIGNER_TLS_CLIENT_KEY).toBe(keyPath);
  });

  it('accepts REMOTE_SIGNER_TLS_CA on its own when it points to a readable file', async () => {
    createTlsFiles();
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_TLS_CA: caPath,
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    const { env } = await import('../../src/utils/env.ts');

    expect(env.REMOTE_SIGNER_TLS_CA).toBe(caPath);
    expect(env.REMOTE_SIGNER_TLS_CLIENT_CERT).toBeUndefined();
    expect(env.REMOTE_SIGNER_TLS_CLIENT_KEY).toBeUndefined();
  });
});
