import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const firstArk = '0x00000000000000000000000000000000000000a1' as Address;
const secondArk = '0x00000000000000000000000000000000000000b2' as Address;
const poolAddress = '0x00000000000000000000000000000000000000c3' as Address;

function buildVault(address: Address) {
  return {
    getAddress: () => address,
    isPaused: vi.fn().mockResolvedValue(false),
    getPoolAddress: vi.fn().mockResolvedValue(poolAddress),
    updateInterest: vi
      .fn()
      .mockResolvedValue(`0x${address.slice(2).padStart(64, '0')}` as `0x${string}`),
    drain: vi.fn().mockResolvedValue(`0x${address.slice(2).padStart(64, '1')}` as `0x${string}`),
    getBuckets: vi.fn().mockResolvedValue([]),
    getBufferTotal: vi.fn().mockResolvedValue(0n),
    getLup: vi.fn().mockResolvedValue(110n),
    getHtp: vi.fn().mockResolvedValue(90n),
    getPriceToIndex: vi.fn().mockImplementation(async (price: bigint) => {
      if (price === 110n) return 11n;
      if (price === 90n) return 9n;
      return 10n;
    }),
    getBufferRatio: vi.fn().mockResolvedValue(0n),
    getTotalAssets: vi.fn().mockResolvedValue(0n),
    getAssetDecimals: vi.fn().mockResolvedValue(18),
    getIndexToPrice: vi.fn().mockImplementation(async (index: bigint) => {
      if (index === 11n) return 110n;
      if (index === 9n) return 90n;
      return 100n;
    }),
    getMinBucketIndex: vi.fn().mockResolvedValue(0n),
    getBucketLps: vi.fn().mockResolvedValue(0n),
    getTotalAuctionsInPool: vi.fn().mockResolvedValue(0n),
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

describe('ark halt scoping', () => {
  it('halts only the affected ark and still runs unrelated arks', async () => {
    const firstVault = buildVault(firstArk);
    const secondVault = buildVault(secondArk);
    const handleTransaction = vi.fn().mockResolvedValue({ status: true, assets: 0n });
    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

    vi.doMock('../../src/ark/vault.ts', () => ({
      createVault: vi.fn((address: Address) => (address === firstArk ? firstVault : secondVault)),
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

    const { arkRun, haltKeeper, isArkHalted } = await import('../../src/keepers/arkKeeper.ts');

    haltKeeper(firstArk);

    const settings = {
      optimalBucketDiff: 1n,
      bufferPadding: 0n,
      minMoveAmount: 1n,
      minTimeSinceBankruptcy: 0n,
      maxAuctionAge: 0,
    };

    await arkRun(firstArk, firstArk, settings);
    await arkRun(secondArk, secondArk, settings);

    expect(isArkHalted(firstArk)).toBe(true);
    expect(isArkHalted(secondArk)).toBe(false);
    expect(firstVault.updateInterest).not.toHaveBeenCalled();
    expect(secondVault.updateInterest).toHaveBeenCalledOnce();
    expect(handleTransaction).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ark_run_aborted', ark: firstArk, reason: 'keeper halted' }),
      expect.stringContaining(firstArk),
    );
  });

  // The metavault config validator accepts ark.address and ark.vaultAddress that lowercase to
  // the same string (e.g., one EIP-55 checksummed, the other lowercase). Halts may be fired
  // with one casing and looked up with another; the registry must canonicalize both sides so
  // the metavault's halt short-circuit cannot silently miss a halt that the ARK keeper fired.
  it('matches halts regardless of address casing', async () => {
    vi.doMock('../../src/ark/vault.ts', () => ({ createVault: vi.fn() }));
    vi.doMock('../../src/ajna/poolHealth.ts', () => ({
      poolHasBadDebt: vi.fn(),
    }));
    vi.doMock('../../src/utils/transaction.ts', () => ({
      getGasWithBuffer: vi.fn(),
      handleTransaction: vi.fn(),
    }));
    vi.doMock('../../src/oracle/price.ts', () => ({ getPrice: vi.fn() }));
    vi.doMock('../../src/ajna/utils/poolBalanceCap.ts', () => ({ poolBalanceCapWad: vi.fn() }));
    vi.doMock('../../src/utils/decimalConversion.ts', () => ({
      toWad: vi.fn(),
      toWadTokenUnit: vi.fn(() => 1n),
    }));
    vi.doMock('../../src/utils/logger.ts', () => ({
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('../../src/utils/chainTime.ts', () => ({
      getChainTime: vi.fn().mockResolvedValue(0n),
      ChainTimeUnavailableError: class extends Error {},
    }));

    const { haltKeeper, isArkHalted } = await import('../../src/keepers/arkKeeper.ts');

    const lower = '0x00000000000000000000000000000000000000aa' as Address;
    const upper = '0x00000000000000000000000000000000000000AA' as Address;

    haltKeeper(upper);

    expect(isArkHalted(lower)).toBe(true);
    expect(isArkHalted(upper)).toBe(true);
  });
});
