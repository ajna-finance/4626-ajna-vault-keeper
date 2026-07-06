import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/oracle/offchain.ts');
  vi.doUnmock('../../src/oracle/onchain.ts');
});

describe('oracle price normalization', () => {
  it('normalizes offchain human-readable prices into Ajna WAD prices', async () => {
    const getOffchainPrice = vi.fn().mockResolvedValue('1.25');
    const getOnchainPrice = vi.fn().mockRejectedValue(new Error('onchain unavailable'));

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        keeper: {
          logLevel: 'error',
        },
        oracle: {
          fixedPrice: null,
          onchainPrimary: false,
        },
      },
    }));
    vi.doMock('../../src/oracle/offchain.ts', () => ({ getOffchainPrice }));
    vi.doMock('../../src/oracle/onchain.ts', () => ({ getOnchainPrice }));

    const { getPrice } = await import('../../src/oracle/price.ts');

    await expect(getPrice()).resolves.toBe(1_250_000_000_000_000_000n);
  });

  it('rejects live oracle prices outside the Ajna price range', async () => {
    const getOffchainPrice = vi.fn().mockResolvedValue('0.000000001');
    const getOnchainPrice = vi.fn().mockRejectedValue(new Error('onchain unavailable'));

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        keeper: {
          logLevel: 'error',
        },
        oracle: {
          fixedPrice: null,
          onchainPrimary: false,
        },
      },
    }));
    vi.doMock('../../src/oracle/offchain.ts', () => ({ getOffchainPrice }));
    vi.doMock('../../src/oracle/onchain.ts', () => ({ getOnchainPrice }));

    const { getPrice } = await import('../../src/oracle/price.ts');

    await expect(getPrice()).rejects.toThrow('unable to fetch price from either source');
    expect(getOnchainPrice).toHaveBeenCalled();
  });
});
