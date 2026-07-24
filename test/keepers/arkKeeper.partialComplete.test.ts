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
      if (index === 11n) return 110n;
      if (index === 9n) return 90n;
      if (index === 10n) return 100n;
      return 80n;
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
    lpToValue: vi.fn().mockResolvedValue(1000n),
  };
}

const SETTINGS = {
  optimalBucketDiff: 0n,
  bufferPadding: 0n,
  minMoveAmount: 1n,
  minTimeSinceBankruptcy: 0n,
  maxAuctionAge: 0,
};

function setupKeeperMocks(
  vault: ReturnType<typeof buildVault>,
  handleTransaction: ReturnType<typeof vi.fn>,
) {
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

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

  return { log };
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

describe('arkRun partial-completion log', () => {
  it('emits ark_run_partially_complete when a move fails', async () => {
    const vault = buildVault(ARK);

    let moveCalls = 0;
    const handleTransaction = vi.fn(async (_tx: unknown, ctx?: { action?: string }) => {
      if (ctx?.action === 'move') {
        moveCalls += 1;
        return { status: moveCalls === 1 ? false : true, assets: moveCalls === 1 ? 0n : 1000n };
      }
      return { status: true, assets: 0n };
    });

    const { log } = setupKeeperMocks(vault, handleTransaction);

    const { arkRun } = await import('../../src/keepers/arkKeeper.ts');

    await arkRun(ARK, ARK, SETTINGS);

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ark_run_partially_complete',
        ark: ARK,
        movesAttempted: 2,
        movesSucceeded: 1,
      }),
      expect.stringContaining('1/2 moves succeeded'),
    );
  });

  it('emits ark_run_complete with full success counts when all moves succeed', async () => {
    const vault = buildVault(ARK);

    const handleTransaction = vi.fn(async (_tx: unknown, ctx?: { action?: string }) => {
      if (ctx?.action === 'move') return { status: true, assets: 1000n };
      return { status: true, assets: 0n };
    });

    const { log } = setupKeeperMocks(vault, handleTransaction);

    const { arkRun } = await import('../../src/keepers/arkKeeper.ts');

    await arkRun(ARK, ARK, SETTINGS);

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ark_run_complete',
        ark: ARK,
        movesAttempted: 2,
        movesSucceeded: 2,
      }),
      expect.stringContaining('ark run complete'),
    );
  });

  it('does not count drain or updateInterest transactions in move stats', async () => {
    const vault = buildVault(ARK);
    vault.getBuckets = vi.fn().mockResolvedValue([]);

    const handleTransaction = vi.fn(async () => ({ status: true, assets: 0n }));

    const { log } = setupKeeperMocks(vault, handleTransaction);

    const { arkRun } = await import('../../src/keepers/arkKeeper.ts');

    await arkRun(ARK, ARK, SETTINGS);

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ark_run_complete',
        movesAttempted: 0,
        movesSucceeded: 0,
      }),
      expect.any(String),
    );
  });

  it('resets move stats between runs', async () => {
    const vault = buildVault(ARK);

    let firstRun = true;
    const handleTransaction = vi.fn(async (_tx: unknown, ctx?: { action?: string }) => {
      if (ctx?.action === 'move') {
        return { status: firstRun ? false : true, assets: firstRun ? 0n : 1000n };
      }
      return { status: true, assets: 0n };
    });

    const { log } = setupKeeperMocks(vault, handleTransaction);

    const { arkRun } = await import('../../src/keepers/arkKeeper.ts');

    await arkRun(ARK, ARK, SETTINGS);
    firstRun = false;
    await arkRun(ARK, ARK, SETTINGS);

    const partialCall = log.info.mock.calls.find(
      (call) => (call[0] as { event?: string })?.event === 'ark_run_partially_complete',
    );
    const completeCall = log.info.mock.calls.find(
      (call) => (call[0] as { event?: string })?.event === 'ark_run_complete',
    );

    expect(partialCall?.[0]).toMatchObject({ movesAttempted: 2, movesSucceeded: 0 });
    expect(completeCall?.[0]).toMatchObject({ movesAttempted: 2, movesSucceeded: 2 });
  });
});
