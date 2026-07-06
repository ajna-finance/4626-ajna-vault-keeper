import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const VALID_CONFIG = `{
  "chainId": 1,
  "quoteTokenAddress": "0x0000000000000000000000000000000000000001",
  "keeper": {
    "intervalMs": 1,
    "haltIfLupBelowHtp": true
  },
  "oracle": {
    "onchainPrimary": true,
    "onchainAddress": "0x0000000000000000000000000000000000000002",
    "fixedPrice": null
  },
  "arkGlobal": {},
  "transaction": {
    "confirmations": 1
  },
  "arks": [],
  "buffer": {
    "address": "0x0000000000000000000000000000000000000003",
    "allocation": 0
  },
  "minRateDiff": 10
}`;

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

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
  vi.resetModules();
  vi.doUnmock('fs');
});

describe('config path handling', () => {
  it('reads the config file from CONFIG_PATH when provided', async () => {
    const readFileSync = vi.fn(() => VALID_CONFIG);

    process.env.CONFIG_PATH = '/tmp/keeper.runtime.json';

    vi.doMock('fs', () => ({
      readFileSync,
    }));

    await import('../../src/utils/config.ts');

    expect(readFileSync).toHaveBeenCalledWith('/tmp/keeper.runtime.json', 'utf-8');
  });

  it('surfaces a clear error when the configured path is missing', async () => {
    process.env.CONFIG_PATH = '/tmp/missing.runtime.json';

    vi.doMock('fs', () => ({
      readFileSync: () => {
        const error = new Error('ENOENT');
        (error as NodeJS.ErrnoException).code = 'ENOENT';
        throw error;
      },
    }));

    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'Configuration file not found at /tmp/missing.runtime.json. Set CONFIG_PATH or place config.json in the working directory.',
    );
  });
});
