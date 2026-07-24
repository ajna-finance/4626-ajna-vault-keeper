import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('fs');
});

function configWith(opts: { oracleExtra?: string; intervalMs?: number } = {}): string {
  const intervalMs = opts.intervalMs ?? 60000;
  return `{
    "chainId": 1,
    "quoteTokenAddress": "0x0000000000000000000000000000000000000001",
    "keeper": {
      "intervalMs": ${intervalMs},
      "haltIfLupBelowHtp": true
    },
    "oracle": {
      "onchainPrimary": false,
      "fixedPrice": "1.00"${opts.oracleExtra ? `,\n      ${opts.oracleExtra}` : ''}
    },
    "arkGlobal": {
      "optimalBucketDiff": 1
    },
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
}

describe('config oracle.requestTimeoutMs', () => {
  it('defaults to 10000 when omitted', async () => {
    vi.doMock('fs', () => ({ readFileSync: () => configWith() }));
    const { config } = await import('../../src/utils/config.ts');
    expect(config.oracle.requestTimeoutMs).toBe(10000);
  });

  it('accepts a valid positive integer value', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => configWith({ oracleExtra: '"requestTimeoutMs": 5000' }),
    }));
    const { config } = await import('../../src/utils/config.ts');
    expect(config.oracle.requestTimeoutMs).toBe(5000);
  });

  it('rejects zero', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => configWith({ oracleExtra: '"requestTimeoutMs": 0' }),
    }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: oracle.requestTimeoutMs must be a positive integer',
    );
  });

  it('rejects values that exceed keeper.intervalMs', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () =>
        configWith({ oracleExtra: '"requestTimeoutMs": 90000', intervalMs: 60000 }),
    }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: oracle.requestTimeoutMs (90000) must not exceed keeper.intervalMs (60000)',
    );
  });
});
