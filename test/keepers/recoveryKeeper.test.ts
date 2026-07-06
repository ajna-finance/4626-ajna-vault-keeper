import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/utils/config', () => ({
  config: {
    chainId: 1,
    quoteTokenAddress: '0x6b175474e89094c44da98b954eedeac495271d0f',
    keeper: { intervalMs: 60_000, logLevel: 'warn', haltIfLupBelowHtp: true },
    oracle: {
      onchainPrimary: false,
      onchainAddress: '0x74661a9ea74fD04975c6eBc6B155Abf8f885636c',
      onchainMaxStaleness: null,
      fixedPrice: null,
      futureSkewTolerance: 120,
    },
    recovery: {
      dedupWindowMs: 3_600_000,
      maxSlippageBps: 50,
      maxValueLossBps: 100,
      minLpMintedBps: 9900,
      swapDeadlineSec: 300,
      minRecoveryValueWad: '0',
    },
    arks: [],
    arkGlobal: { minTimeSinceBankruptcy: 259200 },
    transaction: { confirmations: 1, gasBuffer: 50, defaultGas: 5_000_000 },
    defaultGas: 5_000_000n,
    gasBuffer: 50n,
  },
  resolveRecoverySettings: () => ({
    enabled: true,
    maxSlippageBps: 50,
    maxValueLossBps: 100,
    minLpMintedBps: 9900,
    minTimeSinceBankruptcy: 259200n,
    minRecoveryValueWad: 0n,
    dedupWindowMs: 3_600_000,
    swapDeadlineSec: 300,
  }),
}));

vi.mock('../../src/utils/client', () => ({
  client: {
    account: { address: '0x0000000000000000000000000000000000000001' },
    readContract: vi.fn(),
    writeContract: vi.fn(),
  },
  readOnlyClient: {},
}));

import {
  deriveRecoveryStage,
  dedupKey,
  shouldEmitAlert,
  _resetDedupStoreForTests,
  type RecoveryRequiredEvent,
} from '../../src/keepers/recoveryKeeper';

describe('deriveRecoveryStage', () => {
  it('returns IDLE when not paused and rcv=0', () => {
    expect(
      deriveRecoveryStage({
        authPaused: false,
        removedCollateralValue: 0n,
        walletCollateralBal: 0n,
        walletQuoteBal: 0n,
      }),
    ).toBe('IDLE');
  });

  it('returns RECOVERED when rcv>0 and wallet has collateral only', () => {
    expect(
      deriveRecoveryStage({
        authPaused: false,
        removedCollateralValue: 100n,
        walletCollateralBal: 50n,
        walletQuoteBal: 0n,
      }),
    ).toBe('RECOVERED');
  });

  it('returns SWAPPED when rcv>0 and wallet has quote only', () => {
    expect(
      deriveRecoveryStage({
        authPaused: false,
        removedCollateralValue: 100n,
        walletCollateralBal: 0n,
        walletQuoteBal: 200n,
      }),
    ).toBe('SWAPPED');
  });

  it('returns PARTIAL_SWAP_AMBIGUOUS when both balances are non-zero', () => {
    expect(
      deriveRecoveryStage({
        authPaused: false,
        removedCollateralValue: 100n,
        walletCollateralBal: 10n,
        walletQuoteBal: 20n,
      }),
    ).toBe('PARTIAL_SWAP_AMBIGUOUS');
  });

  it('returns NO_BALANCE when rcv>0 but wallet is empty', () => {
    expect(
      deriveRecoveryStage({
        authPaused: false,
        removedCollateralValue: 100n,
        walletCollateralBal: 0n,
        walletQuoteBal: 0n,
      }),
    ).toBe('NO_BALANCE');
  });

  it('returns BLOCKED_ADMIN_PAUSE when admin paused and rcv=0', () => {
    expect(
      deriveRecoveryStage({
        authPaused: true,
        removedCollateralValue: 0n,
        walletCollateralBal: 0n,
        walletQuoteBal: 0n,
      }),
    ).toBe('BLOCKED_ADMIN_PAUSE');
  });

  it('returns ADMIN_PAUSED_DURING_RECOVERY when admin paused and rcv>0', () => {
    expect(
      deriveRecoveryStage({
        authPaused: true,
        removedCollateralValue: 100n,
        walletCollateralBal: 10n,
        walletQuoteBal: 0n,
      }),
    ).toBe('ADMIN_PAUSED_DURING_RECOVERY');
  });
});

describe('dedupKey', () => {
  it('sorts bucket indexes to produce stable key', () => {
    const evt1 = {
      chainId: 1,
      arkAddress: '0xabc' as `0x${string}`,
      buckets: [{ index: 200n }, { index: 100n }] as any,
    };
    const evt2 = {
      chainId: 1,
      arkAddress: '0xabc' as `0x${string}`,
      buckets: [{ index: 100n }, { index: 200n }] as any,
    };
    expect(dedupKey(evt1)).toBe(dedupKey(evt2));
  });

  it('different bucket sets produce different keys', () => {
    const evtA = {
      chainId: 1,
      arkAddress: '0xabc' as `0x${string}`,
      buckets: [{ index: 100n }] as any,
    };
    const evtB = {
      chainId: 1,
      arkAddress: '0xabc' as `0x${string}`,
      buckets: [{ index: 100n }, { index: 101n }] as any,
    };
    expect(dedupKey(evtA)).not.toBe(dedupKey(evtB));
  });

  it('different chainIds or arks produce different keys', () => {
    const base = {
      chainId: 1,
      arkAddress: '0xabc' as `0x${string}`,
      buckets: [{ index: 100n }] as any,
    };
    expect(dedupKey(base)).not.toBe(dedupKey({ ...base, chainId: 10 }));
    expect(dedupKey(base)).not.toBe(
      dedupKey({ ...base, arkAddress: '0xdef' as `0x${string}` }),
    );
  });
});

describe('shouldEmitAlert', () => {
  const baseEvt: RecoveryRequiredEvent = {
    chainId: 1,
    arkAddress: '0xabc' as `0x${string}`,
    vaultAddress: '0xabc' as `0x${string}`,
    vaultAuthAddress: '0xdef' as `0x${string}`,
    poolAddress: '0x123' as `0x${string}`,
    detectedAt: '2026-04-19T00:00:00Z',
    reason: 'vault_bucket_collateral_detected',
    buckets: [{ index: 100n, vaultLps: 1000n, estimatedCollateralWad: 50n }],
    vaultEffectivePaused: false,
    authPaused: false,
    removedCollateralValue: 0n,
  };

  beforeEach(() => {
    _resetDedupStoreForTests();
  });

  it('emits when key not yet seen', () => {
    expect(shouldEmitAlert(baseEvt, 1000, 1_000_000)).toBe(true);
  });

  it('suppresses repeat within window', () => {
    shouldEmitAlert(baseEvt, 1000, 1_000_000);
    expect(shouldEmitAlert(baseEvt, 1000, 1_000_500)).toBe(false);
  });

  it('re-emits after window expires', () => {
    shouldEmitAlert(baseEvt, 1000, 1_000_000);
    expect(shouldEmitAlert(baseEvt, 1000, 1_002_000)).toBe(true);
  });

  it('different bucket sets are independent', () => {
    shouldEmitAlert(baseEvt, 1000, 1_000_000);
    const otherEvt: RecoveryRequiredEvent = {
      ...baseEvt,
      buckets: [{ index: 200n, vaultLps: 500n, estimatedCollateralWad: 25n }],
    };
    expect(shouldEmitAlert(otherEvt, 1000, 1_000_100)).toBe(true);
  });

  it('resets cleanly via test helper', () => {
    shouldEmitAlert(baseEvt, 1_000_000, 1_000_000);
    _resetDedupStoreForTests();
    expect(shouldEmitAlert(baseEvt, 1_000_000, 1_000_001)).toBe(true);
  });
});
