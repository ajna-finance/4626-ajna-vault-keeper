import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('fs');
});

function configWith(remoteSignerSnippet: string, intervalMs: number = 60000): string {
  return `{
    "chainId": 1,
    "quoteTokenAddress": "0x0000000000000000000000000000000000000001",
    "keeper": {
      "intervalMs": ${intervalMs},
      "haltIfLupBelowHtp": true
    },
    "oracle": {
      "onchainPrimary": false,
      "fixedPrice": "1.00"
    },
    "arkGlobal": {
      "optimalBucketDiff": 1
    },
    "transaction": {
      "confirmations": 1
    }${remoteSignerSnippet ? `,\n    ${remoteSignerSnippet}` : ''},
    "arks": [],
    "buffer": {
      "address": "0x0000000000000000000000000000000000000003",
      "allocation": 0
    },
    "minRateDiff": 10
  }`;
}

describe('config remoteSigner.requestTimeoutMs', () => {
  it('defaults to 30000 when the remoteSigner block is omitted', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => configWith(''),
    }));

    const { config } = await import('../../src/utils/config.ts');
    expect(config.remoteSigner.requestTimeoutMs).toBe(30000);
  });

  it('defaults to 30000 when the remoteSigner block is present but the field is omitted', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => configWith('"remoteSigner": {}'),
    }));

    const { config } = await import('../../src/utils/config.ts');
    expect(config.remoteSigner.requestTimeoutMs).toBe(30000);
  });

  it('accepts a valid positive integer value', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => configWith('"remoteSigner": { "requestTimeoutMs": 5000 }'),
    }));

    const { config } = await import('../../src/utils/config.ts');
    expect(config.remoteSigner.requestTimeoutMs).toBe(5000);
  });

  it('rejects zero', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => configWith('"remoteSigner": { "requestTimeoutMs": 0 }'),
    }));

    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: remoteSigner.requestTimeoutMs must be a positive integer',
    );
  });

  it('rejects negative values', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => configWith('"remoteSigner": { "requestTimeoutMs": -1 }'),
    }));

    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: remoteSigner.requestTimeoutMs must be a positive integer',
    );
  });

  it('rejects non-integer values', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => configWith('"remoteSigner": { "requestTimeoutMs": 1.5 }'),
    }));

    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: remoteSigner.requestTimeoutMs must be a positive integer',
    );
  });

  it('rejects values that exceed keeper.intervalMs', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => configWith('"remoteSigner": { "requestTimeoutMs": 90000 }', 60000),
    }));

    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: remoteSigner.requestTimeoutMs (90000) must not exceed keeper.intervalMs (60000)',
    );
  });
});
