import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const ARK = '0x00000000000000000000000000000000000000a1' as Address;
const POOL = '0x00000000000000000000000000000000000000c3' as Address;
const QUOTE = '0x00000000000000000000000000000000000000d4' as Address;
const TX_HASH =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`;
const WAD = 10n ** 18n;
const SIX_DECIMAL_TOKEN = 10n ** 6n;

function buildVault() {
  return {
    getAddress: () => ARK,
    isPaused: vi.fn().mockResolvedValue(false),
    getPoolAddress: vi.fn().mockResolvedValue(POOL),
    updateInterest: vi.fn().mockResolvedValue(TX_HASH),
    drain: vi.fn().mockResolvedValue(TX_HASH),
    move: vi.fn().mockResolvedValue(TX_HASH),
    moveToBuffer: vi.fn().mockResolvedValue(TX_HASH),
    moveFromBuffer: vi.fn().mockResolvedValue(TX_HASH),
    getBuckets: vi.fn().mockResolvedValue([5n, 6n]),
    getBufferTotal: vi.fn().mockResolvedValue(0n),
    getLup: vi.fn().mockResolvedValue(110n),
    getHtp: vi.fn().mockResolvedValue(90n),
    getPriceToIndex: vi.fn().mockImplementation(async (price: bigint) => {
      if (price === 110n) return 11n;
      if (price === 90n) return 9n;
      return 10n;
    }),
    getIndexToPrice: vi.fn().mockImplementation(async (index: bigint) => {
      if (index === 10n) return 100n;
      return 80n;
    }),
    getBufferRatio: vi.fn().mockResolvedValue(0n),
    getTotalAssets: vi.fn().mockResolvedValue(0n),
    getAssetDecimals: vi.fn().mockResolvedValue(6),
    getMinBucketIndex: vi.fn().mockResolvedValue(0n),
    getBucketLps: vi.fn().mockResolvedValue(0n),
    getTotalAuctionsInPool: vi.fn().mockResolvedValue(0n),
    getPoolEscrowedQuote: vi.fn().mockResolvedValue(0n),
    getDustThreshold: vi.fn().mockResolvedValue(1n),
    getBankruptcyTime: vi.fn().mockResolvedValue(0n),
    isBucketDebtLocked: vi.fn().mockResolvedValue(false),
    getBucketInfo: vi.fn().mockResolvedValue([0n, 0n, 0n]),
    lpToValue: vi.fn().mockResolvedValue(100n * WAD),
  };
}

function mockArkRunModules(vault: ReturnType<typeof buildVault>, poolBalance: bigint) {
  const readContract = vi.fn().mockResolvedValue(poolBalance);
  const handleTransaction = vi.fn(async (_tx: unknown, ctx?: { action?: string }) => {
    if (ctx?.action === 'move') return { status: true, assets: 100n * WAD };
    return { status: true, assets: 0n };
  });

  vi.doMock('../../src/utils/config.ts', () => ({
    config: { quoteTokenAddress: QUOTE, metavaultAddress: undefined },
  }));
  vi.doMock('../../src/utils/client.ts', () => ({ client: { readContract } }));
  vi.doMock('../../src/ark/vault.ts', () => ({
    createVault: vi.fn(() => vault),
  }));
  vi.doMock('../../src/ajna/poolHealth.ts', () => ({
    poolHasBadDebt: vi.fn().mockResolvedValue(false),
  }));
  vi.doMock('../../src/utils/transaction.ts', () => ({
    getGasWithBuffer: vi.fn().mockResolvedValue(1n),
    handleTransaction,
  }));
  vi.doMock('../../src/oracle/price.ts', () => ({
    getPrice: vi.fn().mockResolvedValue(100n),
  }));
  vi.doMock('../../src/utils/logger.ts', () => ({
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  }));
  vi.doMock('../../src/utils/chainTime.ts', () => ({
    getChainTime: vi.fn().mockResolvedValue(0n),
    ChainTimeUnavailableError: class extends Error {},
  }));

  return { readContract, handleTransaction };
}

async function runArk() {
  const previousIntegrationTest = process.env.INTEGRATION_TEST;
  delete process.env.INTEGRATION_TEST;
  try {
    const { arkRun } = await import('../../src/keepers/arkKeeper.ts');

    await arkRun(ARK, ARK, {
      optimalBucketDiff: 0n,
      bufferPadding: 0n,
      minMoveAmount: 1_000_001n,
      minTimeSinceBankruptcy: 0n,
      maxAuctionAge: 0,
    });
  } finally {
    if (previousIntegrationTest === undefined) {
      delete process.env.INTEGRATION_TEST;
    } else {
      process.env.INTEGRATION_TEST = previousIntegrationTest;
    }
  }
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/utils/client.ts');
  vi.doUnmock('../../src/ark/vault.ts');
  vi.doUnmock('../../src/ajna/poolHealth.ts');
  vi.doUnmock('../../src/utils/transaction.ts');
  vi.doUnmock('../../src/oracle/price.ts');
  vi.doUnmock('../../src/utils/logger.ts');
  vi.doUnmock('../../src/utils/chainTime.ts');
});

describe('arkRun pool balance cap units', () => {
  it('scales pool native token balance to WAD before capping ARK bucket moves', async () => {
    const vault = buildVault();
    const { readContract } = mockArkRunModules(vault, 1_000n * SIX_DECIMAL_TOKEN);

    await runArk();

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: QUOTE,
        functionName: 'balanceOf',
        args: [POOL],
      }),
    );
    expect(vault.move).toHaveBeenCalledWith(5n, 10n, 100n * WAD, 1n);
    expect(vault.move).toHaveBeenCalledWith(6n, 10n, 100n * WAD, 1n);
  });

  // Regression (PR19-D07): Ajna moveQuoteToken relocates deposit accounting without moving
  // ERC-20 cash, so the pool balance cap must only limit Buffer withdrawals. A fully utilized
  // pool with zero cash must still consolidate out-of-range buckets internally.
  it('still consolidates buckets internally when the pool has no spare cash', async () => {
    const vault = buildVault();
    mockArkRunModules(vault, 0n);

    await runArk();

    expect(vault.move).toHaveBeenCalledWith(5n, 10n, 100n * WAD, 1n);
    expect(vault.move).toHaveBeenCalledWith(6n, 10n, 100n * WAD, 1n);
    expect(vault.moveToBuffer).not.toHaveBeenCalled();
  });
});
