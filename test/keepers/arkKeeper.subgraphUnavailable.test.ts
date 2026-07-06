import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const ARK = '0x00000000000000000000000000000000000000a1' as Address;
const POOL = '0x00000000000000000000000000000000000000c3' as Address;
const TX_HASH =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`;

class SubgraphUnavailableErrorStub extends Error {
  constructor(cause?: unknown) {
    super('subgraph query failed in fail-closed mode', { cause });
    this.name = 'SubgraphUnavailableError';
  }
}

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
    getBuckets: vi.fn().mockResolvedValue([]),
    getBufferTotal: vi.fn().mockResolvedValue(0n),
    getLup: vi.fn().mockResolvedValue(110n),
    getHtp: vi.fn().mockResolvedValue(90n),
    getPriceToIndex: vi.fn().mockResolvedValue(10n),
    getIndexToPrice: vi.fn().mockResolvedValue(100n),
    getBufferRatio: vi.fn().mockResolvedValue(0n),
    getTotalAssets: vi.fn().mockResolvedValue(0n),
    getAssetDecimals: vi.fn().mockResolvedValue(18),
    getMinBucketIndex: vi.fn().mockResolvedValue(0n),
    getBucketLps: vi.fn().mockResolvedValue(0n),
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
  vi.doUnmock('../../src/subgraph/poolHealth.ts');
  vi.doUnmock('../../src/utils/transaction.ts');
  vi.doUnmock('../../src/oracle/price.ts');
  vi.doUnmock('../../src/ajna/utils/poolBalanceCap.ts');
  vi.doUnmock('../../src/utils/decimalConversion.ts');
  vi.doUnmock('../../src/utils/logger.ts');
});

// DIFFERENTIAL_REVIEW_REPORT #11 regression. The arkKeeper already aborted when
// poolHasBadDebt returned true, but the underlying contract changed: a fail-closed
// subgraph failure now throws SubgraphUnavailableError instead of returning true.
// This test pins the abort path so a future refactor cannot silently let a thrown
// SubgraphUnavailableError escape arkRun (which would surface as an unhandled
// rejection at the scheduler and skip the run-abort logging).
describe('arkRun aborts cleanly when the subgraph is unavailable', () => {
  it('logs ark_run_aborted with reason "subgraph unavailable" and fires no transactions', async () => {
    const vault = buildVault(ARK);
    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const handleTransaction = vi.fn().mockResolvedValue({ status: true, assets: 0n });
    const cause = new Error('subgraph fetch failed');
    const poolHasBadDebt = vi.fn(async () => {
      throw new SubgraphUnavailableErrorStub(cause);
    });

    vi.doMock('../../src/ark/vault.ts', () => ({
      createVault: vi.fn(() => vault),
    }));
    vi.doMock('../../src/subgraph/poolHealth.ts', () => ({
      poolHasBadDebt,
      SubgraphUnavailableError: SubgraphUnavailableErrorStub,
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

    const { arkRun } = await import('../../src/keepers/arkKeeper.ts');

    const settings = {
      optimalBucketDiff: 1n,
      bufferPadding: 0n,
      minMoveAmount: 1n,
      minTimeSinceBankruptcy: 0n,
      maxAuctionAge: 0,
    };

    await expect(arkRun(ARK, ARK, settings)).resolves.toBeUndefined();

    expect(poolHasBadDebt).toHaveBeenCalledOnce();
    expect(vault.updateInterest).not.toHaveBeenCalled();
    expect(vault.drain).not.toHaveBeenCalled();
    expect(vault.move).not.toHaveBeenCalled();
    expect(vault.moveToBuffer).not.toHaveBeenCalled();
    expect(vault.moveFromBuffer).not.toHaveBeenCalled();
    expect(handleTransaction).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ark_run_aborted',
        ark: ARK,
        reason: 'subgraph unavailable',
        err: expect.any(SubgraphUnavailableErrorStub),
      }),
      expect.stringContaining('subgraph unavailable'),
    );
  });
});
