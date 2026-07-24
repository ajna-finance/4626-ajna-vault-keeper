import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const ark = '0x00000000000000000000000000000000000000a1' as Address;
const vaultAuth = '0x00000000000000000000000000000000000000b2' as Address;
const pool = '0x00000000000000000000000000000000000000c3' as Address;
const metavault = '0x00000000000000000000000000000000000000d4' as Address;
const txHash = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;

type VaultFixture = {
  assetDecimals?: number;
  bufferRatio?: bigint;
  bufferTotal: bigint;
  totalSupply?: bigint;
  metavaultShares?: bigint;
  externalAssets?: bigint;
};

function buildVaultFixture({
  assetDecimals = 18,
  bufferRatio = 0n,
  bufferTotal,
  totalSupply = 0n,
  metavaultShares = totalSupply,
  externalAssets = 0n,
}: VaultFixture) {
  return {
    getAddress: () => ark,
    isPaused: vi.fn().mockResolvedValue(false),
    getPoolAddress: vi.fn().mockResolvedValue(pool),
    updateInterest: vi.fn().mockResolvedValue(txHash),
    drain: vi.fn().mockResolvedValue(txHash),
    moveFromBuffer: vi.fn().mockResolvedValue(txHash),
    moveToBuffer: vi.fn().mockResolvedValue(txHash),
    move: vi.fn().mockResolvedValue(txHash),
    getBuckets: vi.fn().mockResolvedValue([]),
    getBufferTotal: vi.fn().mockResolvedValue(bufferTotal),
    getLup: vi.fn().mockResolvedValue(110n),
    getHtp: vi.fn().mockResolvedValue(90n),
    getPriceToIndex: vi.fn().mockImplementation(async (price: bigint) => {
      if (price === 110n) return 9n;
      if (price === 90n) return 11n;
      return 10n;
    }),
    getBufferRatio: vi.fn().mockResolvedValue(bufferRatio),
    getTotalAssets: vi.fn().mockResolvedValue(0n),
    getAssetDecimals: vi.fn().mockResolvedValue(assetDecimals),
    getIndexToPrice: vi.fn().mockImplementation(async (index: bigint) => {
      if (index === 9n) return 110n;
      if (index === 11n) return 90n;
      return 100n;
    }),
    getMinBucketIndex: vi.fn().mockResolvedValue(0n),
    getBucketLps: vi.fn().mockResolvedValue(0n),
    getTotalAuctionsInPool: vi.fn().mockResolvedValue(0n),
    getDustThreshold: vi.fn().mockResolvedValue(1n),
    getBankruptcyTime: vi.fn().mockResolvedValue(0n),
    isBucketDebtLocked: vi.fn().mockResolvedValue(false),
    getBucketInfo: vi.fn().mockResolvedValue([0n, 0n, 0n]),
    lpToValue: vi.fn().mockResolvedValue(0n),
    getTotalSupply: vi.fn().mockResolvedValue(totalSupply),
    getBalanceOf: vi.fn().mockImplementation(async (account: Address) => {
      return account === metavault ? metavaultShares : 0n;
    }),
    convertToAssets: vi.fn().mockResolvedValue(externalAssets),
  };
}

function resetArkKeeperModules() {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/ark/vault.ts');
  vi.doUnmock('../../src/ajna/poolHealth.ts');
  vi.doUnmock('../../src/utils/transaction.ts');
  vi.doUnmock('../../src/oracle/price.ts');
  vi.doUnmock('../../src/ajna/utils/poolBalanceCap.ts');
  vi.doUnmock('../../src/utils/logger.ts');
  vi.doUnmock('../../src/utils/chainTime.ts');
}

beforeEach(() => {
  resetArkKeeperModules();
});

afterEach(() => {
  resetArkKeeperModules();
});

describe('ark keeper reserved buffer handling', () => {
  async function runArk(vaultFixture: ReturnType<typeof buildVaultFixture>) {
    const handleTransaction = vi.fn().mockResolvedValue({ status: true, assets: 0n });

    vi.doMock('../../src/utils/config.ts', () => ({
      config: { metavaultAddress: metavault },
    }));
    vi.doMock('../../src/ark/vault.ts', () => ({
      createVault: vi.fn(() => vaultFixture),
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
    vi.doMock('../../src/utils/logger.ts', () => ({
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('../../src/utils/chainTime.ts', () => ({
      getChainTime: vi.fn().mockResolvedValue(0n),
      ChainTimeUnavailableError: class extends Error {},
    }));

    const { arkRun } = await import('../../src/keepers/arkKeeper.ts');

    await arkRun(ark, vaultAuth, {
      optimalBucketDiff: 1n,
      bufferPadding: 5n,
      minMoveAmount: 1n,
      minTimeSinceBankruptcy: 0n,
      maxAuctionAge: 0,
    });

    return { handleTransaction };
  }

  it('sweeps the full zero-ratio buffer when no external shares exist', async () => {
    const vaultFixture = buildVaultFixture({
      bufferTotal: 25n,
      totalSupply: 100n,
      metavaultShares: 100n,
    });

    await runArk(vaultFixture);

    expect(vaultFixture.convertToAssets).not.toHaveBeenCalled();
    expect(vaultFixture.moveFromBuffer).toHaveBeenCalledOnce();
    expect(vaultFixture.moveFromBuffer).toHaveBeenCalledWith(11n, 20n, 1n);
  });

  it('does not sweep when the buffer exactly matches the reserved external claim', async () => {
    const vaultFixture = buildVaultFixture({
      bufferTotal: 30n,
      totalSupply: 150n,
      metavaultShares: 100n,
      externalAssets: 30n,
    });

    await runArk(vaultFixture);

    expect(vaultFixture.getBalanceOf).toHaveBeenCalledWith(metavault);
    expect(vaultFixture.convertToAssets).toHaveBeenCalledWith(50n);
    expect(vaultFixture.moveFromBuffer).not.toHaveBeenCalled();
  });

  it('sweeps only the buffer excess above the reserved external claim', async () => {
    const vaultFixture = buildVaultFixture({
      bufferTotal: 60n,
      totalSupply: 160n,
      metavaultShares: 100n,
      externalAssets: 25n,
    });

    await runArk(vaultFixture);

    expect(vaultFixture.convertToAssets).toHaveBeenCalledWith(60n);
    expect(vaultFixture.moveFromBuffer).toHaveBeenCalledOnce();
    expect(vaultFixture.moveFromBuffer).toHaveBeenCalledWith(11n, 30n, 1n);
  });

  it('normalizes non-18-decimal external claims before computing sweepable buffer', async () => {
    const vaultFixture = buildVaultFixture({
      assetDecimals: 6,
      bufferTotal: 20_000_000_000_000_000_000n,
      totalSupply: 90n,
      metavaultShares: 50n,
      externalAssets: 7_500_000n,
    });

    await runArk(vaultFixture);

    expect(vaultFixture.convertToAssets).toHaveBeenCalledWith(40n);
    expect(vaultFixture.moveFromBuffer).toHaveBeenCalledOnce();
    expect(vaultFixture.moveFromBuffer).toHaveBeenCalledWith(11n, 12_499_999_999_999_999_995n, 1n);
  });
});
