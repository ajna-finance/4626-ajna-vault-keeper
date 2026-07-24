import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const ARK = '0x00000000000000000000000000000000000000a1' as Address;
const POOL = '0x00000000000000000000000000000000000000c3' as Address;
const TX_HASH =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`;

const BANKRUPTCY_TIMESTAMP = 1_700_000_000n;
const MIN_TIME_SINCE_BANKRUPTCY = 1000n;

class ChainTimeUnavailableErrorStub extends Error {
  constructor(cause?: unknown) {
    super('failed to read latest block timestamp from RPC', { cause });
    this.name = 'ChainTimeUnavailableError';
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
    getBankruptcyTime: vi.fn().mockResolvedValue(BANKRUPTCY_TIMESTAMP),
    isBucketDebtLocked: vi.fn().mockResolvedValue(false),
    getBucketInfo: vi.fn().mockResolvedValue([0n, 0n, 0n]),
    lpToValue: vi.fn().mockResolvedValue(0n),
  };
}

const STANDARD_SETTINGS = {
  optimalBucketDiff: 0n,
  bufferPadding: 0n,
  minMoveAmount: 1n,
  minTimeSinceBankruptcy: MIN_TIME_SINCE_BANKRUPTCY,
  maxAuctionAge: 0,
};

type SetupOptions = {
  chainTimeResult: bigint | Error;
};

async function setupArkRun(opts: SetupOptions) {
  const vault = buildVault(ARK);
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const getChainTime =
    opts.chainTimeResult instanceof Error
      ? vi.fn().mockRejectedValue(opts.chainTimeResult)
      : vi.fn().mockResolvedValue(opts.chainTimeResult);
  const handleTransaction = vi.fn().mockResolvedValue({ status: true, assets: 0n });

  vi.doMock('../../src/ark/vault.ts', () => ({ createVault: vi.fn(() => vault) }));
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
    getChainTime,
    ChainTimeUnavailableError: ChainTimeUnavailableErrorStub,
  }));

  const { arkRun } = await import('../../src/keepers/arkKeeper.ts');

  return { vault, log, getChainTime, arkRun };
}

afterEach(() => {
  vi.resetModules();
  vi.useRealTimers();
  vi.doUnmock('../../src/ark/vault.ts');
  vi.doUnmock('../../src/ajna/poolHealth.ts');
  vi.doUnmock('../../src/utils/transaction.ts');
  vi.doUnmock('../../src/oracle/price.ts');
  vi.doUnmock('../../src/ajna/utils/poolBalanceCap.ts');
  vi.doUnmock('../../src/utils/decimalConversion.ts');
  vi.doUnmock('../../src/utils/logger.ts');
  vi.doUnmock('../../src/utils/chainTime.ts');
});

// These tests pin the chain-time semantics of isOptimalBucketRecentlyBankrupt.
// Operators sometimes run keepers on machines with drifted clocks; before this
// fix, the bankruptcy-recency check used Date.now() and could either falsely
// allow deposits into a recently-bankrupt bucket (host clock skewed ahead) or
// pointlessly hold off on healthy buckets (host clock skewed behind).
describe('isOptimalBucketRecentlyBankrupt sources "now" from chain time', () => {
  it('aborts when chain time puts the bankruptcy inside the cutoff even if Date.now would not', async () => {
    const chainTimeSec = BANKRUPTCY_TIMESTAMP + MIN_TIME_SINCE_BANKRUPTCY - 1n;
    const dateNowSec = BANKRUPTCY_TIMESTAMP + MIN_TIME_SINCE_BANKRUPTCY + 100n;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Number(dateNowSec) * 1000));

    const { vault, log, getChainTime, arkRun } = await setupArkRun({
      chainTimeResult: chainTimeSec,
    });

    await arkRun(ARK, ARK, STANDARD_SETTINGS);

    expect(getChainTime).toHaveBeenCalledOnce();
    expect(vault.getBankruptcyTime).toHaveBeenCalledWith(10n);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ark_run_aborted',
        ark: ARK,
        reason: 'optimal bucket was recently bankrupt',
      }),
      expect.stringContaining(ARK),
    );
    expect(vault.isBucketDebtLocked).not.toHaveBeenCalled();
  });

  it('proceeds when chain time puts the bankruptcy past the cutoff even if Date.now would not', async () => {
    const chainTimeSec = BANKRUPTCY_TIMESTAMP + MIN_TIME_SINCE_BANKRUPTCY + 1n;
    const dateNowSec = BANKRUPTCY_TIMESTAMP + MIN_TIME_SINCE_BANKRUPTCY - 100n;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Number(dateNowSec) * 1000));

    const { vault, log, getChainTime, arkRun } = await setupArkRun({
      chainTimeResult: chainTimeSec,
    });

    await arkRun(ARK, ARK, STANDARD_SETTINGS);

    expect(getChainTime).toHaveBeenCalledOnce();
    expect(vault.getBankruptcyTime).toHaveBeenCalledWith(10n);
    expect(vault.isBucketDebtLocked).toHaveBeenCalledWith(10n);
    expect(log.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'optimal bucket was recently bankrupt' }),
      expect.anything(),
    );
  });

  it('treats the bankruptcy-age boundary as not-recently-bankrupt (cutoff is strictly less than)', async () => {
    const chainTimeSec = BANKRUPTCY_TIMESTAMP + MIN_TIME_SINCE_BANKRUPTCY;

    const { vault, log, getChainTime, arkRun } = await setupArkRun({
      chainTimeResult: chainTimeSec,
    });

    await arkRun(ARK, ARK, STANDARD_SETTINGS);

    expect(getChainTime).toHaveBeenCalledOnce();
    expect(vault.isBucketDebtLocked).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'optimal bucket was recently bankrupt' }),
      expect.anything(),
    );
  });

  it('treats nowSec === bankruptcyTimestamp (zero seconds since bankruptcy) as recently bankrupt', async () => {
    const chainTimeSec = BANKRUPTCY_TIMESTAMP;

    const { vault, log, arkRun } = await setupArkRun({ chainTimeResult: chainTimeSec });

    await arkRun(ARK, ARK, STANDARD_SETTINGS);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'optimal bucket was recently bankrupt' }),
      expect.anything(),
    );
    expect(vault.isBucketDebtLocked).not.toHaveBeenCalled();
  });

  it('treats zero bankruptcyTimestamp as not-recently-bankrupt regardless of chain time', async () => {
    const { vault, log, arkRun } = await setupArkRun({ chainTimeResult: 0n });
    vault.getBankruptcyTime.mockResolvedValueOnce(0n);

    await arkRun(ARK, ARK, STANDARD_SETTINGS);

    expect(vault.isBucketDebtLocked).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'optimal bucket was recently bankrupt' }),
      expect.anything(),
    );
  });
});

// When minTimeSinceBankruptcy is 0, the keeper treats *any* historical bankruptcy
// as disqualifying — the chain-time read is irrelevant in this branch. These
// tests pin both arms of the short-circuit so a refactor cannot accidentally
// fall through to the chain-time comparison.
describe('isOptimalBucketRecentlyBankrupt with minTimeSinceBankruptcy === 0n', () => {
  const ZERO_MIN_SETTINGS = { ...STANDARD_SETTINGS, minTimeSinceBankruptcy: 0n };

  it('treats any non-zero bankruptcyTimestamp as recently bankrupt', async () => {
    const { vault, log, arkRun } = await setupArkRun({ chainTimeResult: BANKRUPTCY_TIMESTAMP });
    vault.getBankruptcyTime.mockResolvedValueOnce(1n);

    await arkRun(ARK, ARK, ZERO_MIN_SETTINGS);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'optimal bucket was recently bankrupt' }),
      expect.anything(),
    );
    expect(vault.isBucketDebtLocked).not.toHaveBeenCalled();
  });

  it('treats zero bankruptcyTimestamp as not recently bankrupt', async () => {
    const { vault, log, arkRun } = await setupArkRun({ chainTimeResult: BANKRUPTCY_TIMESTAMP });
    vault.getBankruptcyTime.mockResolvedValueOnce(0n);

    await arkRun(ARK, ARK, ZERO_MIN_SETTINGS);

    expect(vault.isBucketDebtLocked).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'optimal bucket was recently bankrupt' }),
      expect.anything(),
    );
  });
});

// arkRun must convert chain-time RPC failures into a clean ark_run_aborted log
// rather than letting the exception escape uncaught. An uncaught throw would
// not only skip the current ARK but also any later ARKs in the scheduler's
// per-interval loop (see src/utils/scheduler.ts:14-17).
describe('arkRun handles ChainTimeUnavailableError cleanly', () => {
  it('logs ark_run_aborted with reason "chain time unavailable" and fires no further state changes', async () => {
    const cause = new Error('rpc unreachable');
    const { vault, log, arkRun } = await setupArkRun({
      chainTimeResult: new ChainTimeUnavailableErrorStub(cause),
    });

    await expect(arkRun(ARK, ARK, STANDARD_SETTINGS)).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ark_run_aborted',
        ark: ARK,
        reason: 'chain time unavailable',
        err: expect.any(ChainTimeUnavailableErrorStub),
      }),
      expect.stringContaining('chain time unavailable'),
    );
    expect(vault.isBucketDebtLocked).not.toHaveBeenCalled();
    expect(vault.move).not.toHaveBeenCalled();
    expect(vault.moveToBuffer).not.toHaveBeenCalled();
    expect(vault.moveFromBuffer).not.toHaveBeenCalled();
  });
});
