import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const ARK = '0x00000000000000000000000000000000000000a1' as Address;
const POOL = '0x00000000000000000000000000000000000000c3' as Address;
const TX_HASH =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`;

function buildVault(address: Address) {
  return {
    getAddress: () => address,
    isPaused: vi.fn().mockResolvedValue(false),
    getPoolAddress: vi.fn().mockResolvedValue(POOL),
    updateInterest: vi.fn().mockResolvedValue(TX_HASH),
    drain: vi.fn().mockResolvedValue(TX_HASH),
    move: vi.fn().mockResolvedValue(TX_HASH),
    moveToBuffer: vi.fn().mockResolvedValue(TX_HASH),
    moveFromBuffer: vi.fn().mockResolvedValue(TX_HASH),
    getBuckets: vi.fn().mockResolvedValue([5n]),
    getBufferTotal: vi.fn().mockResolvedValue(0n),
    getLup: vi.fn().mockResolvedValue(110n),
    getHtp: vi.fn().mockResolvedValue(90n),
    getPriceToIndex: vi.fn().mockImplementation(async (price: bigint) => {
      if (price === 110n) return 11n;
      if (price === 90n) return 9n;
      return 10n;
    }),
    getIndexToPrice: vi.fn().mockImplementation(async (index: bigint) => {
      if (index === 11n) return 110n;
      if (index === 9n) return 90n;
      return 100n;
    }),
    getBufferRatio: vi.fn().mockResolvedValue(0n),
    getTotalAssets: vi.fn().mockResolvedValue(0n),
    getAssetDecimals: vi.fn().mockResolvedValue(18),
    getMinBucketIndex: vi.fn().mockResolvedValue(0n),
    getBucketLps: vi.fn().mockResolvedValue(0n),
    getTotalAuctionsInPool: vi.fn().mockResolvedValue(0n),
    getDustThreshold: vi.fn().mockResolvedValue(0n),
    getBankruptcyTime: vi.fn().mockResolvedValue(0n),
    isBucketDebtLocked: vi.fn().mockResolvedValue(false),
    getBucketInfo: vi.fn().mockResolvedValue([0n, 0n, 0n]),
    lpToValue: vi.fn().mockResolvedValue(0n),
  };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/ark/vault.ts');
  vi.doUnmock('../../src/ajna/poolHealth.ts');
  vi.doUnmock('../../src/utils/transaction.ts');
  vi.doUnmock('../../src/oracle/price.ts');
  vi.doUnmock('../../src/ajna/utils/poolBalanceCap.ts');
  vi.doUnmock('../../src/utils/decimalConversion.ts');
  vi.doUnmock('../../src/utils/logger.ts');
  vi.doUnmock('../../src/utils/chainTime.ts');
});

describe('arkRun aborts on nested transaction failure', () => {
  it('aborts the run when a drain inside rebalanceBuckets fails', async () => {
    const vault = buildVault(ARK);
    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

    let drainCount = 0;
    const handleTransaction = vi.fn(async (_tx: unknown, ctx?: { action?: string }) => {
      if (ctx?.action === 'drain') {
        drainCount += 1;
        // Drain sequence with one bucket configured: 1) _getKeeperData drains the
        // initial bucket, 2) arkRun drains the optimal bucket, 3) rebalanceBuckets
        // drains again. Failing #3 forces the abort to come from a nested helper.
        if (drainCount === 3) return { status: false, assets: 0n };
      }
      return { status: true, assets: 0n };
    });

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
    vi.doMock('../../src/ajna/utils/poolBalanceCap.ts', () => ({
      poolBalanceCapWad: vi.fn(async (amount: bigint) => amount),
    }));
    vi.doMock('../../src/utils/decimalConversion.ts', () => ({
      toWad: vi.fn((amount: bigint) => amount),
      toWadTokenUnit: vi.fn(() => 1n),
    }));
    vi.doMock('../../src/utils/logger.ts', () => ({ log }));
    vi.doMock('../../src/utils/chainTime.ts', () => ({
      getChainTime: vi.fn().mockResolvedValue(0n),
      ChainTimeUnavailableError: class extends Error {},
    }));

    const { arkRun } = await import('../../src/keepers/arkKeeper.ts');

    const settings = {
      optimalBucketDiff: 0n,
      bufferPadding: 0n,
      minMoveAmount: 1n,
      minTimeSinceBankruptcy: 0n,
      maxAuctionAge: 0,
    };

    await arkRun(ARK, ARK, settings);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ark_run_aborted',
        ark: ARK,
        reason: expect.stringContaining('drain failed'),
      }),
      expect.stringContaining(ARK),
    );
    expect(vault.move).not.toHaveBeenCalled();
    expect(vault.moveToBuffer).not.toHaveBeenCalled();
    expect(vault.moveFromBuffer).not.toHaveBeenCalled();
  });

  it('does not index zero HTP for a no-debt pool', async () => {
    const vault = buildVault(ARK);
    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const handleTransaction = vi.fn().mockResolvedValue({ status: true, assets: 0n });

    vault.getBuckets.mockResolvedValue([]);
    vault.getHtp.mockResolvedValue(0n);
    vault.getBankruptcyTime.mockResolvedValue(0n);
    vault.getPriceToIndex.mockImplementation(async (price: bigint) => {
      if (price === 0n) throw new Error('BucketPriceOutOfBounds');
      if (price === 110n) return 11n;
      return 10n;
    });

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
    vi.doMock('../../src/ajna/utils/poolBalanceCap.ts', () => ({
      poolBalanceCapWad: vi.fn(async (amount: bigint) => amount),
    }));
    vi.doMock('../../src/utils/decimalConversion.ts', () => ({
      toWad: vi.fn((amount: bigint) => amount),
      toWadTokenUnit: vi.fn(() => 1n),
    }));
    vi.doMock('../../src/utils/logger.ts', () => ({ log }));
    vi.doMock('../../src/utils/chainTime.ts', () => ({
      getChainTime: vi.fn().mockResolvedValue(0n),
      ChainTimeUnavailableError: class extends Error {},
    }));

    const { arkRun } = await import('../../src/keepers/arkKeeper.ts');

    const settings = {
      optimalBucketDiff: 0n,
      bufferPadding: 0n,
      minMoveAmount: 1n,
      minTimeSinceBankruptcy: 0n,
      maxAuctionAge: 0,
    };

    await expect(arkRun(ARK, ARK, settings)).resolves.toBeUndefined();

    expect(vault.getPriceToIndex).not.toHaveBeenCalledWith(0n);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ark_run_complete',
        ark: ARK,
        quoteTokenPrice: 100n,
        optimalBucket: 10n,
      }),
      expect.stringContaining(ARK),
    );
  });

  it('aborts cleanly when optimalBucketDiff pushes the bucket outside Ajna bounds', async () => {
    const vault = buildVault(ARK);
    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const handleTransaction = vi.fn().mockResolvedValue({ status: true, assets: 0n });

    vault.getBuckets.mockResolvedValue([]);
    vault.getPriceToIndex.mockResolvedValue(7388n);

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
    vi.doMock('../../src/ajna/utils/poolBalanceCap.ts', () => ({
      poolBalanceCapWad: vi.fn(async (amount: bigint) => amount),
    }));
    vi.doMock('../../src/utils/decimalConversion.ts', () => ({
      toWad: vi.fn((amount: bigint) => amount),
      toWadTokenUnit: vi.fn(() => 1n),
    }));
    vi.doMock('../../src/utils/logger.ts', () => ({ log }));
    vi.doMock('../../src/utils/chainTime.ts', () => ({
      getChainTime: vi.fn().mockResolvedValue(0n),
      ChainTimeUnavailableError: class extends Error {},
    }));

    const { arkRun } = await import('../../src/keepers/arkKeeper.ts');

    await arkRun(ARK, ARK, {
      optimalBucketDiff: 1n,
      bufferPadding: 0n,
      minMoveAmount: 1n,
      minTimeSinceBankruptcy: 0n,
      maxAuctionAge: 0,
    });

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ark_run_aborted',
        ark: ARK,
        reason: 'optimal bucket is outside Ajna bucket range',
      }),
      expect.stringContaining(ARK),
    );
    expect(vault.drain).not.toHaveBeenCalled();
  });
});
