import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const ARK = '0x00000000000000000000000000000000000000a1' as Address;
const POOL = '0x00000000000000000000000000000000000000c3' as Address;
const TX_HASH =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`;
const WAD = 10n ** 18n;

function buildVault({
  buckets = [5n],
  bufferTotal = 0n,
  bufferRatio = 0n,
  totalAssets = 0n,
  bucketValue = 100n * WAD,
  assetDecimals = 6,
}: {
  buckets?: bigint[];
  bufferTotal?: bigint;
  bufferRatio?: bigint;
  totalAssets?: bigint;
  bucketValue?: bigint;
  assetDecimals?: number;
} = {}) {
  return {
    getAddress: () => ARK,
    isPaused: vi.fn().mockResolvedValue(false),
    getPoolAddress: vi.fn().mockResolvedValue(POOL),
    updateInterest: vi.fn().mockResolvedValue(TX_HASH),
    drain: vi.fn().mockResolvedValue(TX_HASH),
    move: vi.fn().mockResolvedValue(TX_HASH),
    moveToBuffer: vi.fn().mockResolvedValue(TX_HASH),
    moveFromBuffer: vi.fn().mockResolvedValue(TX_HASH),
    getBuckets: vi.fn().mockResolvedValue(buckets),
    getBufferTotal: vi.fn().mockResolvedValue(bufferTotal),
    getLup: vi.fn().mockResolvedValue(110n),
    getHtp: vi.fn().mockResolvedValue(90n),
    getPriceToIndex: vi.fn().mockResolvedValue(10n),
    getIndexToPrice: vi.fn().mockImplementation(async (index: bigint) => {
      if (index === 10n) return 100n;
      return 80n;
    }),
    getBufferRatio: vi.fn().mockResolvedValue(bufferRatio),
    getTotalAssets: vi.fn().mockResolvedValue(totalAssets),
    getAssetDecimals: vi.fn().mockResolvedValue(assetDecimals),
    getMinBucketIndex: vi.fn().mockResolvedValue(0n),
    getBucketLps: vi.fn().mockResolvedValue(0n),
    getTotalAuctionsInPool: vi.fn().mockResolvedValue(0n),
    getDustThreshold: vi.fn().mockResolvedValue(1n),
    getBankruptcyTime: vi.fn().mockResolvedValue(0n),
    isBucketDebtLocked: vi.fn().mockResolvedValue(false),
    getBucketInfo: vi.fn().mockResolvedValue([0n, 0n, 0n]),
    lpToValue: vi.fn().mockResolvedValue(bucketValue),
  };
}

async function runArk(vault: ReturnType<typeof buildVault>) {
  const handleTransaction = vi.fn().mockResolvedValue({ status: true, assets: 0n });
  const getGasWithBuffer = vi.fn().mockResolvedValue(1n);

  vi.doMock('../../src/utils/config.ts', () => ({
    config: { metavaultAddress: undefined },
  }));
  vi.doMock('../../src/ark/vault.ts', () => ({
    createVault: vi.fn(() => vault),
  }));
  vi.doMock('../../src/ajna/poolHealth.ts', () => ({
    poolHasBadDebt: vi.fn().mockResolvedValue(false),
  }));
  vi.doMock('../../src/utils/transaction.ts', () => ({
    getGasWithBuffer,
    handleTransaction,
  }));
  vi.doMock('../../src/oracle/price.ts', () => ({
    getPrice: vi.fn().mockResolvedValue(100n),
  }));
  vi.doMock('../../src/ajna/utils/poolBalanceCap.ts', () => ({
    poolBalanceCapWad: vi.fn(async (amount: bigint) => amount),
  }));
  vi.doMock('../../src/utils/logger.ts', () => ({
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  }));
  vi.doMock('../../src/utils/chainTime.ts', () => ({
    getChainTime: vi.fn().mockResolvedValue(0n),
    ChainTimeUnavailableError: class extends Error {},
  }));

  const { arkRun } = await import('../../src/keepers/arkKeeper.ts');

  await arkRun(ARK, ARK, {
    optimalBucketDiff: 0n,
    bufferPadding: 0n,
    minMoveAmount: 1_000_001n,
    minTimeSinceBankruptcy: 0n,
    maxAuctionAge: 0,
  });

  return { getGasWithBuffer, handleTransaction };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/ark/vault.ts');
  vi.doUnmock('../../src/ajna/poolHealth.ts');
  vi.doUnmock('../../src/utils/transaction.ts');
  vi.doUnmock('../../src/oracle/price.ts');
  vi.doUnmock('../../src/ajna/utils/poolBalanceCap.ts');
  vi.doUnmock('../../src/utils/logger.ts');
  vi.doUnmock('../../src/utils/chainTime.ts');
});

describe('arkRun Buffer transfer unit guard', () => {
  it('does not send moveToBuffer for a WAD amount below one token base unit', async () => {
    const vault = buildVault({ bufferRatio: 1n, totalAssets: 1n });

    const { getGasWithBuffer } = await runArk(vault);

    expect(vault.moveToBuffer).not.toHaveBeenCalled();
    expect(getGasWithBuffer).not.toHaveBeenCalledWith(
      'vault',
      'moveToBuffer',
      expect.anything(),
      ARK,
    );
    expect(vault.move).toHaveBeenCalledWith(5n, 10n, 100n * WAD, 1n);
  });

  it('moves a sub-token bucket amount to the optimal bucket when the Buffer deficit is larger', async () => {
    const bucketValue = 100_000_000n;
    const vault = buildVault({ bufferRatio: 10_000n, totalAssets: 1n, bucketValue });

    const { getGasWithBuffer } = await runArk(vault);

    expect(vault.moveToBuffer).not.toHaveBeenCalled();
    expect(getGasWithBuffer).not.toHaveBeenCalledWith(
      'vault',
      'moveToBuffer',
      expect.anything(),
      ARK,
    );
    expect(vault.move).toHaveBeenCalledWith(5n, 10n, bucketValue, 1n);
  });

  it('keeps minMoveAmount semantics separate from the Buffer transfer unit', async () => {
    const bucketValue = 1_000_001n;
    const vault = buildVault({
      bufferRatio: 10_000n,
      totalAssets: 1_000_002n,
      bucketValue,
      assetDecimals: 18,
    });

    await runArk(vault);

    expect(vault.moveToBuffer).toHaveBeenCalledWith(5n, bucketValue, 1n);
    expect(vault.move).not.toHaveBeenCalled();
  });

  it('does not send moveFromBuffer for a WAD amount below one token base unit', async () => {
    const vault = buildVault({ buckets: [], bufferTotal: 100_000_000n });

    const { getGasWithBuffer } = await runArk(vault);

    expect(vault.moveFromBuffer).not.toHaveBeenCalled();
    expect(getGasWithBuffer).not.toHaveBeenCalledWith(
      'vault',
      'moveFromBuffer',
      expect.anything(),
      ARK,
    );
  });
});
