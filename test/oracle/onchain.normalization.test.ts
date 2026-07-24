import { afterEach, describe, expect, it, vi } from 'vitest';

const COLLATERAL_FEED = '0x00000000000000000000000000000000000000c0';
const QUOTE_FEED = '0x00000000000000000000000000000000000000d0';
const WAD = 10n ** 18n;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/utils/client.ts');
  vi.doUnmock('../../src/utils/address.ts');
  vi.doUnmock('../../src/utils/abi.ts');
  vi.doUnmock('../../src/utils/chainTime.ts');
  vi.doUnmock('../../src/utils/logger.ts');
});

function mockOnchain(prices: Record<string, bigint>, chainTime = 1000n): void {
  vi.doMock('../../src/utils/config.ts', () => ({
    config: {
      oracle: {
        onchainCollateralAddress: COLLATERAL_FEED,
        onchainQuoteAddress: QUOTE_FEED,
        futureSkewTolerance: 120,
        onchainMaxStaleness: null,
      },
    },
  }));
  vi.doMock('../../src/utils/address.ts', () => ({
    getAddress: async (name: string) =>
      name === 'chronicleCollateral' ? COLLATERAL_FEED : QUOTE_FEED,
  }));
  vi.doMock('../../src/utils/abi.ts', () => ({ getAbi: () => [] }));
  vi.doMock('../../src/utils/chainTime.ts', () => ({
    getChainTime: vi.fn().mockResolvedValue(chainTime),
  }));
  vi.doMock('../../src/utils/logger.ts', () => ({ log: { info: vi.fn() } }));
  const readContract = vi.fn(async ({ address }: { address: string }) => [
    prices[address.toLowerCase()] ?? 0n,
    chainTime,
  ]);
  vi.doMock('../../src/utils/client.ts', () => ({
    client: { readContract },
    readOnlyClient: { readContract },
  }));
}

describe('onchain oracle quote-per-collateral', () => {
  it('divides the collateral feed by the quote feed into a WAD price', async () => {
    mockOnchain({ [COLLATERAL_FEED]: 3n * WAD, [QUOTE_FEED]: 2n * WAD });
    const { getOnchainPrice } = await import('../../src/oracle/onchain.ts');

    await expect(getOnchainPrice()).resolves.toBe(1_500_000_000_000_000_000n);
  });

  it('cancels feed decimals so an 8-decimal pair still yields a WAD ratio', async () => {
    mockOnchain({ [COLLATERAL_FEED]: 300_000_000n, [QUOTE_FEED]: 200_000_000n });
    const { getOnchainPrice } = await import('../../src/oracle/onchain.ts');

    await expect(getOnchainPrice()).resolves.toBe(1_500_000_000_000_000_000n);
  });

  it('fails closed when the quote feed price is zero', async () => {
    mockOnchain({ [COLLATERAL_FEED]: 3n * WAD, [QUOTE_FEED]: 0n });
    const { getOnchainPrice } = await import('../../src/oracle/onchain.ts');

    await expect(getOnchainPrice()).rejects.toThrow('quote token price must be positive');
  });
});
