import { afterEach, describe, expect, it, vi } from 'vitest';

const A1 = '0x0000000000000000000000000000000000000001';
const A2 = '0x0000000000000000000000000000000000000002';
const A3 = '0x0000000000000000000000000000000000000003';
const A4 = '0x0000000000000000000000000000000000000004';
const A5 = '0x0000000000000000000000000000000000000005';
const A6 = '0x0000000000000000000000000000000000000006';
const A7 = '0x0000000000000000000000000000000000000007';

type ConfigOverrides = {
  chainId?: unknown;
  quoteTokenAddress?: unknown;
  metavaultAddress?: unknown;
  keeper?: unknown;
  oracle?: unknown;
  arkGlobal?: unknown;
  transaction?: unknown;
  remoteSigner?: unknown;
  arks?: unknown;
  buffer?: unknown;
  minRateDiff?: unknown;
};

function makeConfig(overrides: ConfigOverrides = {}): unknown {
  const base = {
    chainId: 1,
    quoteTokenAddress: A1,
    keeper: { intervalMs: 60000, haltIfLupBelowHtp: true },
    oracle: { onchainPrimary: true, onchainAddress: A2, fixedPrice: null },
    arkGlobal: { optimalBucketDiff: 1 },
    transaction: { confirmations: 1 },
    arks: [],
    buffer: { address: A3, allocation: 0 },
    minRateDiff: 10,
  };
  return { ...base, ...overrides };
}

function mockConfigFs(value: unknown): void {
  vi.doMock('fs', () => ({
    readFileSync: () => (typeof value === 'string' ? value : JSON.stringify(value)),
  }));
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('fs');
});

describe('config: chainId', () => {
  it('rejects non-integer chainId', async () => {
    mockConfigFs(makeConfig({ chainId: 'mainnet' }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: chainId must be an integer',
    );
  });

  it('rejects zero chainId', async () => {
    mockConfigFs(makeConfig({ chainId: 0 }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: chainId must be >= 1',
    );
  });

  it('rejects negative chainId', async () => {
    mockConfigFs(makeConfig({ chainId: -1 }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: chainId must be >= 1',
    );
  });

  it('rejects non-finite chainId', async () => {
    mockConfigFs('{"chainId": 9.5, "quoteTokenAddress": "' + A1 + '"}');
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: chainId must be an integer',
    );
  });
});

describe('config: address validation', () => {
  it('rejects malformed quoteTokenAddress', async () => {
    mockConfigFs(makeConfig({ quoteTokenAddress: '0x1' }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: quoteTokenAddress must be a valid 0x-prefixed 20-byte address',
    );
  });

  it('rejects missing quoteTokenAddress', async () => {
    const cfg = makeConfig();
    delete (cfg as Record<string, unknown>).quoteTokenAddress;
    mockConfigFs(cfg);
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: quoteTokenAddress must be a valid 0x-prefixed 20-byte address',
    );
  });

  it('rejects malformed metavaultAddress when provided', async () => {
    mockConfigFs(makeConfig({ metavaultAddress: '0xnothex' }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: metavaultAddress must be a valid 0x-prefixed 20-byte address',
    );
  });

  it('treats empty metavaultAddress as not in metavault mode', async () => {
    mockConfigFs(makeConfig({ metavaultAddress: '' }));
    const { config } = await import('../../src/utils/config.ts');
    expect(config.metavaultAddress).toBeUndefined();
  });

  it('rejects malformed buffer.address', async () => {
    mockConfigFs(makeConfig({ buffer: { address: '0xinvalid', allocation: 0 } }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: buffer.address must be a valid 0x-prefixed 20-byte address',
    );
  });

  it('rejects malformed oracle.onchainAddress when provided', async () => {
    mockConfigFs(
      makeConfig({
        oracle: { onchainPrimary: false, onchainAddress: 'notanaddress', fixedPrice: '1.00' },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: oracle.onchainAddress must be a valid 0x-prefixed 20-byte address',
    );
  });
});

describe('config: keeper section', () => {
  it('rejects non-positive intervalMs', async () => {
    mockConfigFs(makeConfig({ keeper: { intervalMs: 0, haltIfLupBelowHtp: true } }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: keeper.intervalMs must be >= 1',
    );
  });

  it('rejects non-boolean haltIfLupBelowHtp', async () => {
    mockConfigFs(makeConfig({ keeper: { intervalMs: 1, haltIfLupBelowHtp: 'yes' } }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: keeper.haltIfLupBelowHtp must be a boolean',
    );
  });

  it('rejects unknown logLevel', async () => {
    mockConfigFs(
      makeConfig({ keeper: { intervalMs: 1, haltIfLupBelowHtp: true, logLevel: 'loud' } }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: keeper.logLevel must be one of',
    );
  });

  it('accepts every supported pino logLevel', async () => {
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']) {
      vi.resetModules();
      vi.doUnmock('fs');
      mockConfigFs(
        makeConfig({ keeper: { intervalMs: 1, haltIfLupBelowHtp: true, logLevel: level } }),
      );
      const { config } = await import('../../src/utils/config.ts');
      expect(config.keeper.logLevel).toBe(level);
    }
  });
});

describe('config: oracle section', () => {
  it('rejects non-boolean onchainPrimary', async () => {
    mockConfigFs(
      makeConfig({
        oracle: { onchainPrimary: 'true', onchainAddress: A2, fixedPrice: null },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: oracle.onchainPrimary must be a boolean',
    );
  });

  it('rejects negative futureSkewTolerance', async () => {
    mockConfigFs(
      makeConfig({
        oracle: {
          onchainPrimary: true,
          onchainAddress: A2,
          fixedPrice: null,
          futureSkewTolerance: -5,
        },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: oracle.futureSkewTolerance must be >= 0',
    );
  });

  it('accepts zero futureSkewTolerance without overriding it', async () => {
    mockConfigFs(
      makeConfig({
        oracle: {
          onchainPrimary: true,
          onchainAddress: A2,
          fixedPrice: null,
          futureSkewTolerance: 0,
        },
      }),
    );
    const { config } = await import('../../src/utils/config.ts');
    expect(config.oracle.futureSkewTolerance).toBe(0);
  });

  it('defaults offchainMaxStaleness', async () => {
    mockConfigFs(makeConfig());
    const { config } = await import('../../src/utils/config.ts');
    expect(config.oracle.offchainMaxStaleness).toBe(86400);
  });

  it('rejects non-positive offchainMaxStaleness values', async () => {
    mockConfigFs(
      makeConfig({
        oracle: {
          onchainPrimary: true,
          onchainAddress: A2,
          fixedPrice: null,
          offchainMaxStaleness: 0,
        },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: oracle.offchainMaxStaleness must be a positive integer',
    );
  });
});

describe('config: transaction section', () => {
  it('rejects negative confirmations', async () => {
    mockConfigFs(makeConfig({ transaction: { confirmations: -1 } }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: transaction.confirmations must be >= 0',
    );
  });

  it('rejects negative gasBuffer', async () => {
    mockConfigFs(makeConfig({ transaction: { confirmations: 1, gasBuffer: -1 } }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: transaction.gasBuffer must be >= 0',
    );
  });

  it('accepts gasBuffer of zero (nullish default applies only when omitted)', async () => {
    mockConfigFs(makeConfig({ transaction: { confirmations: 1, gasBuffer: 0 } }));
    const { config } = await import('../../src/utils/config.ts');
    expect(config.gasBuffer).toBe(0n);
  });

  it('rejects non-positive defaultGas', async () => {
    mockConfigFs(makeConfig({ transaction: { confirmations: 1, defaultGas: 0 } }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: transaction.defaultGas must be >= 1',
    );
  });

  it('rejects string typed numeric values', async () => {
    mockConfigFs(makeConfig({ transaction: { confirmations: 1, gasBuffer: '50' } }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: transaction.gasBuffer must be an integer',
    );
  });
});

describe('config: arkGlobal numeric typing', () => {
  it('rejects non-numeric optimalBucketDiff', async () => {
    mockConfigFs(makeConfig({ arkGlobal: { optimalBucketDiff: '1' } }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arkGlobal.optimalBucketDiff must be an integer',
    );
  });

  it('rejects negative arkGlobal numeric settings', async () => {
    mockConfigFs(
      makeConfig({
        arkGlobal: { optimalBucketDiff: 1, minTimeSinceBankruptcy: -10 },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arkGlobal.minTimeSinceBankruptcy must be >= 0',
    );
  });

  it('rejects non-bigint-parseable arkGlobal bufferPadding strings', async () => {
    mockConfigFs(
      makeConfig({
        arkGlobal: { optimalBucketDiff: 1, bufferPadding: 'twelve' },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arkGlobal.bufferPadding must parse as a bigint',
    );
  });

  it('rejects negative arkGlobal bufferPadding strings', async () => {
    mockConfigFs(
      makeConfig({
        arkGlobal: { optimalBucketDiff: 1, bufferPadding: '-1' },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arkGlobal.bufferPadding must be non-negative',
    );
  });
});

describe('config: remoteSigner section', () => {
  it('rejects non-object remoteSigner', async () => {
    mockConfigFs(makeConfig({ remoteSigner: 'fast' }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: remoteSigner must be an object',
    );
  });
});

describe('config: ark validation', () => {
  it('rejects arks that is not an array', async () => {
    mockConfigFs(makeConfig({ arks: { foo: 'bar' } }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arks must be an array',
    );
  });

  it('rejects allocation.max above 100', async () => {
    mockConfigFs(
      makeConfig({
        arks: [
          {
            address: A4,
            vaultAddress: A5,
            vaultAuthAddress: A6,
            allocation: { min: 0, max: 200 },
          },
        ],
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arks[0].allocation.max must be an integer in [0, 100]',
    );
  });

  it('rejects negative allocation.min', async () => {
    mockConfigFs(
      makeConfig({
        arks: [
          {
            address: A4,
            vaultAddress: A5,
            vaultAuthAddress: A6,
            allocation: { min: -5, max: 50 },
          },
        ],
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arks[0].allocation.min must be an integer in [0, 100]',
    );
  });

  it('rejects ark.allocation.max of zero', async () => {
    mockConfigFs(
      makeConfig({
        arks: [
          {
            address: A4,
            vaultAddress: A5,
            vaultAuthAddress: A6,
            allocation: { min: 0, max: 0 },
          },
        ],
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arks[0].allocation.max must not be 0',
    );
  });

  it('rejects ark.allocation.min above max', async () => {
    mockConfigFs(
      makeConfig({
        arks: [
          {
            address: A4,
            vaultAddress: A5,
            vaultAuthAddress: A6,
            allocation: { min: 80, max: 50 },
          },
        ],
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arks[0].allocation.min (80) must not exceed max (50)',
    );
  });

  it('rejects ark without optimalBucketDiff when arkGlobal omits it', async () => {
    mockConfigFs(
      makeConfig({
        arkGlobal: {},
        arks: [
          {
            address: A4,
            vaultAddress: A5,
            vaultAuthAddress: A6,
            allocation: { min: 0, max: 50 },
          },
        ],
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: optimalBucketDiff must be set globally in arkGlobal or individually for every ark',
    );
  });

  it('rejects ark with malformed vaultAddress', async () => {
    mockConfigFs(
      makeConfig({
        arks: [
          {
            address: A4,
            vaultAddress: '0xbad',
            vaultAuthAddress: A6,
            allocation: { min: 0, max: 50 },
          },
        ],
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arks[0].vaultAddress must be a valid 0x-prefixed 20-byte address',
    );
  });
});

describe('config: ark.address must equal vaultAddress in metavault mode', () => {
  it('rejects metavault config where ark.address differs from vaultAddress', async () => {
    mockConfigFs(
      makeConfig({
        metavaultAddress: A7,
        arks: [
          {
            address: A4,
            vaultAddress: A5,
            vaultAuthAddress: A6,
            allocation: { min: 0, max: 60 },
          },
        ],
        buffer: { address: A3, allocation: 40 },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      `config.json: arks[0].address (${A4}) must equal arks[0].vaultAddress (${A5}) in metavault mode`,
    );
  });

  it('accepts metavault config where ark.address equals vaultAddress', async () => {
    mockConfigFs(
      makeConfig({
        metavaultAddress: A7,
        arks: [
          {
            address: A4,
            vaultAddress: A4,
            vaultAuthAddress: A6,
            allocation: { min: 0, max: 60 },
          },
        ],
        buffer: { address: A3, allocation: 40 },
      }),
    );
    const { config } = await import('../../src/utils/config.ts');
    expect(config.arks[0]!.address.toLowerCase()).toBe(config.arks[0]!.vaultAddress.toLowerCase());
  });

  it('accepts metavault config where ark.address and vaultAddress differ only by checksum casing', async () => {
    const lower = '0x000000000000000000000000000000000000000a';
    const upper = '0x000000000000000000000000000000000000000A';
    mockConfigFs(
      makeConfig({
        metavaultAddress: A7,
        arks: [
          {
            address: lower,
            vaultAddress: upper,
            vaultAuthAddress: A6,
            allocation: { min: 0, max: 60 },
          },
        ],
        buffer: { address: A3, allocation: 40 },
      }),
    );
    const { config } = await import('../../src/utils/config.ts');
    expect(config.arks[0]!.address.toLowerCase()).toBe(config.arks[0]!.vaultAddress.toLowerCase());
  });

  it('does not enforce the equality check outside metavault mode', async () => {
    mockConfigFs(
      makeConfig({
        arks: [
          {
            address: A4,
            vaultAddress: A5,
            vaultAuthAddress: A6,
            allocation: { min: 0, max: 30 },
          },
        ],
        buffer: { address: A3, allocation: 0 },
      }),
    );
    const { config } = await import('../../src/utils/config.ts');
    expect(config.metavaultAddress).toBeUndefined();
    expect(config.arks[0]!.address).toBe(A4);
    expect(config.arks[0]!.vaultAddress).toBe(A5);
  });
});

describe('config: allocation sum in metavault mode', () => {
  it('rejects metavault config when ark.max sum + buffer != 100, even when buffer.allocation is zero', async () => {
    mockConfigFs(
      makeConfig({
        metavaultAddress: A7,
        arks: [
          {
            address: A4,
            vaultAddress: A4,
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 50 },
          },
        ],
        buffer: { address: A6, allocation: 0 },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: sum of ark max allocations (50) + buffer allocation (0) must equal 100',
    );
  });

  it('rejects metavault config with sum above 100', async () => {
    mockConfigFs(
      makeConfig({
        metavaultAddress: A7,
        arks: [
          {
            address: A4,
            vaultAddress: A4,
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 60 },
          },
        ],
        buffer: { address: A6, allocation: 50 },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: sum of ark max allocations (60) + buffer allocation (50) must equal 100',
    );
  });

  it('accepts metavault config when ark.max sum + buffer equals 100', async () => {
    mockConfigFs(
      makeConfig({
        metavaultAddress: A7,
        arks: [
          {
            address: A4,
            vaultAddress: A4,
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 60 },
          },
        ],
        buffer: { address: A6, allocation: 40 },
      }),
    );
    const { config } = await import('../../src/utils/config.ts');
    expect(config.metavaultAddress).toBe(A7);
  });

  it('skips the allocation sum check when no metavaultAddress is set', async () => {
    mockConfigFs(
      makeConfig({
        arks: [
          {
            address: A4,
            vaultAddress: A4,
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 30 },
          },
        ],
        buffer: { address: A6, allocation: 0 },
      }),
    );
    const { config } = await import('../../src/utils/config.ts');
    expect(config.metavaultAddress).toBeUndefined();
  });
});

describe('config: duplicate address detection in metavault mode', () => {
  it('rejects when an ark.address duplicates another ark.address', async () => {
    mockConfigFs(
      makeConfig({
        metavaultAddress: A7,
        arks: [
          {
            address: A4,
            vaultAddress: A4,
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 30 },
          },
          {
            address: A4,
            vaultAddress: A4,
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 30 },
          },
        ],
        buffer: { address: A6, allocation: 40 },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arks[1].address',
    );
  });

  it('rejects when ark.address duplicates the buffer address', async () => {
    mockConfigFs(
      makeConfig({
        metavaultAddress: A7,
        arks: [
          {
            address: A6,
            vaultAddress: A6,
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 60 },
          },
        ],
        buffer: { address: A6, allocation: 40 },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arks[0].address',
    );
  });

  it('rejects when ark.address duplicates the metavaultAddress', async () => {
    mockConfigFs(
      makeConfig({
        metavaultAddress: A7,
        arks: [
          {
            address: A7,
            vaultAddress: A7,
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 60 },
          },
        ],
        buffer: { address: A6, allocation: 40 },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arks[0].address',
    );
  });

  it('treats addresses case-insensitively', async () => {
    mockConfigFs(
      makeConfig({
        metavaultAddress: A7,
        arks: [
          {
            address: '0x000000000000000000000000000000000000000A',
            vaultAddress: '0x000000000000000000000000000000000000000A',
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 60 },
          },
          {
            address: '0x000000000000000000000000000000000000000a',
            vaultAddress: '0x000000000000000000000000000000000000000a',
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 0 },
          },
        ],
        buffer: { address: A6, allocation: 40 },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow();
  });

  it('does not enforce duplicates outside metavault mode', async () => {
    mockConfigFs(
      makeConfig({
        arks: [
          {
            address: '',
            vaultAddress: A4,
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 30 },
          },
          {
            address: '',
            vaultAddress: A4,
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 30 },
          },
        ],
        buffer: { address: A6, allocation: 0 },
      }),
    );
    const { config } = await import('../../src/utils/config.ts');
    expect(config.arks).toHaveLength(2);
  });
});

describe('config: minRateDiff', () => {
  it('preserves an explicit zero minRateDiff', async () => {
    mockConfigFs(makeConfig({ minRateDiff: 0 }));
    const { config } = await import('../../src/utils/config.ts');
    expect(config.minRateDiff).toBe(0);
  });

  it('defaults minRateDiff when omitted', async () => {
    const cfg = makeConfig();
    delete (cfg as Record<string, unknown>).minRateDiff;
    mockConfigFs(cfg);
    const { config } = await import('../../src/utils/config.ts');
    expect(config.minRateDiff).toBe(10);
  });

  it('rejects negative minRateDiff', async () => {
    mockConfigFs(makeConfig({ minRateDiff: -1 }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: minRateDiff must be >= 0',
    );
  });

  it('rejects string minRateDiff', async () => {
    mockConfigFs(makeConfig({ minRateDiff: '10' }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: minRateDiff must be an integer',
    );
  });

  it('rejects fractional minRateDiff because evaluateRates passes it to BigInt()', async () => {
    mockConfigFs(makeConfig({ minRateDiff: 1.5 }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: minRateDiff must be an integer',
    );
  });
});

describe('config: numeric edge cases', () => {
  it('rejects null where a safe integer is required (NaN/undefined surrogate via JSON)', async () => {
    mockConfigFs(makeConfig({ transaction: { confirmations: null } }));
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: transaction.confirmations must be an integer',
    );
  });

  it('rejects oversized integers beyond Number.MAX_SAFE_INTEGER', async () => {
    mockConfigFs(`{
      "chainId": 9007199254740993,
      "quoteTokenAddress": "${A1}",
      "keeper": { "intervalMs": 1, "haltIfLupBelowHtp": true },
      "oracle": { "onchainPrimary": true, "onchainAddress": "${A2}", "fixedPrice": null },
      "arkGlobal": { "optimalBucketDiff": 1 },
      "transaction": { "confirmations": 1 },
      "arks": [],
      "buffer": { "address": "${A3}", "allocation": 0 },
      "minRateDiff": 10
    }`);
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: chainId must be an integer',
    );
  });
});

describe('config: buffer.address optionality outside metavault mode', () => {
  it('accepts an empty buffer.address when no metavaultAddress is configured', async () => {
    mockConfigFs(makeConfig({ buffer: { address: '', allocation: 0 } }));
    const { config } = await import('../../src/utils/config.ts');
    expect(config.buffer.allocation).toBe(0);
  });

  it('rejects an empty buffer.address in metavault mode', async () => {
    mockConfigFs(
      makeConfig({
        metavaultAddress: A7,
        arks: [
          {
            address: A4,
            vaultAddress: A4,
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 60 },
          },
        ],
        buffer: { address: '', allocation: 40 },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: buffer.address must be a valid 0x-prefixed 20-byte address',
    );
  });
});

describe('config: ark.address optionality outside metavault mode', () => {
  it('rejects a non-empty but malformed ark.address even in ARK-only mode', async () => {
    mockConfigFs(
      makeConfig({
        arks: [
          {
            address: '0xnope',
            vaultAddress: A4,
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 30 },
          },
        ],
        buffer: { address: A6, allocation: 0 },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arks[0].address must be a valid 0x-prefixed 20-byte address',
    );
  });

  it('accepts an undefined ark.address in ARK-only mode', async () => {
    mockConfigFs(
      makeConfig({
        arks: [
          {
            vaultAddress: A4,
            vaultAuthAddress: A5,
            allocation: { min: 0, max: 30 },
          },
        ],
        buffer: { address: A6, allocation: 0 },
      }),
    );
    const { config } = await import('../../src/utils/config.ts');
    expect(config.arks).toHaveLength(1);
  });
});

describe('config: requireNonNegativeBigIntString edge cases', () => {
  it('rejects fractional numeric strings for bigint fields', async () => {
    mockConfigFs(
      makeConfig({
        arkGlobal: { optimalBucketDiff: 1, bufferPadding: '12.5' },
      }),
    );
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: arkGlobal.bufferPadding must parse as a bigint',
    );
  });

  it('accepts very large bigint strings beyond Number.MAX_SAFE_INTEGER', async () => {
    mockConfigFs(
      makeConfig({
        arkGlobal: {
          optimalBucketDiff: 1,
          bufferPadding: '99999999999999999999999999999999',
        },
      }),
    );
    const { config } = await import('../../src/utils/config.ts');
    expect(config.arkGlobal.bufferPadding).toBe('99999999999999999999999999999999');
  });
});

describe('config: invalid JSON and root type', () => {
  it('surfaces a clear error when config.json is not valid JSON', async () => {
    mockConfigFs('not json');
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      /config\.json at .* is not valid JSON/,
    );
  });

  it('rejects an array as the root config value', async () => {
    mockConfigFs([]);
    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: root must be an object',
    );
  });
});
