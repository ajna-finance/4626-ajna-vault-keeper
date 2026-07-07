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

vi.mock('../../src/utils/transaction', () => ({
  wait: vi.fn(async () => ({ status: 'success' })),
  getGasWithBuffer: vi.fn(),
  parseRecoverCollateralLogs: vi.fn(() => []),
  parseReturnQuoteTokenLog: vi.fn(() => null),
  abridgedViemError: (err: unknown) => err,
}));

import {
  deriveRecoveryStage,
  dedupKey,
  shouldEmitAlert,
  _resetDedupStoreForTests,
  _handleRecoveryTxForTests,
  collateralDustFloor,
  refillPrecheck,
  type RecoveryRequiredEvent,
} from '../../src/keepers/recoveryKeeper';
import { wait } from '../../src/utils/transaction';

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

describe('handleRecoveryTx', () => {
  it('forwards the tx context to wait() so the LUPBelowHTP halt wiring can engage', async () => {
    const context = {
      action: 'recoverCollateral',
      ark: '0x00000000000000000000000000000000000000a1',
    };
    await _handleRecoveryTxForTests(Promise.resolve('0xabc' as `0x${string}`), context);

    expect(vi.mocked(wait)).toHaveBeenCalledWith('0xabc', context);
  });

  it('returns null instead of throwing when the tx rejects', async () => {
    const result = await _handleRecoveryTxForTests(Promise.reject(new Error('boom')), {
      action: 'returnQuoteToken',
      ark: '0x00000000000000000000000000000000000000a1',
    });

    expect(result).toBeNull();
  });
});

describe('collateralDustFloor', () => {
  it('caps high-decimal tokens at the historical 1000 raw-unit floor', () => {
    expect(collateralDustFloor(18)).toBe(1000n);
    expect(collateralDustFloor(12)).toBe(1000n);
    expect(collateralDustFloor(9)).toBe(1000n);
  });

  it('uses a micro-token for mid-decimal tokens', () => {
    expect(collateralDustFloor(7)).toBe(10n);
    expect(collateralDustFloor(6)).toBe(1n);
  });

  it('floors low-decimal tokens at one raw unit so real value is never dust', () => {
    // Finding scenario: 900 raw units of a 2-decimal token is 9 whole tokens.
    // The floor must sit at 1 raw unit so that balance counts as material.
    expect(collateralDustFloor(2)).toBe(1n);
    expect(collateralDustFloor(0)).toBe(1n);
    expect(900n >= collateralDustFloor(2)).toBe(true);
  });
});

describe('refillPrecheck', () => {
  const base = {
    amountWad: 10n ** 18n,
    vaultRefillLps: 0n,
    bucketLps: 0n,
    bucketCollateral: 0n,
    bankruptcyTime: 0n,
    nowSec: 1_000_000n,
    minTimeSinceBankruptcy: 259200n,
    lpDust: 1_000_001n,
    minLpMintedBps: 9900,
  };

  it('passes a healthy empty-bucket refill', () => {
    expect(refillPrecheck(base)).toEqual({ ok: true });
  });

  it('rejects a recently bankrupt bucket', () => {
    const r = refillPrecheck({ ...base, bankruptcyTime: base.nowSec - 100n });
    expect(r).toMatchObject({ ok: false, reason: 'recently_bankrupt' });
  });

  it('passes once the bankruptcy cooldown has elapsed', () => {
    const r = refillPrecheck({ ...base, bankruptcyTime: base.nowSec - 259200n });
    expect(r).toEqual({ ok: true });
  });

  it('rejects pool-total LP in the BucketLPDangerous range', () => {
    const r = refillPrecheck({ ...base, bucketLps: 1_000_000n });
    expect(r).toMatchObject({ ok: false, reason: 'bucket_lp_dangerous' });
  });

  it('rejects a zero deposit as no_quote_to_refill, not below_dust', () => {
    const r = refillPrecheck({ ...base, amountWad: 0n });
    expect(r).toMatchObject({ ok: false, reason: 'no_quote_to_refill' });
  });

  it('checks dust against the VAULT LP after mint, not pool-total LP', () => {
    // The confirmed divergence: other lenders hold plenty of LP (pool-total clears
    // the dangerous range), the vault holds none, and the deposit mints under
    // LP_DUST. The old pool-total check waved this through to an on-chain
    // DustyBucket revert.
    const r = refillPrecheck({
      ...base,
      bucketLps: 2_000_000n,
      vaultRefillLps: 0n,
      amountWad: 500_000n,
    });
    expect(r).toMatchObject({ ok: false, reason: 'below_dust' });
  });

  it('passes when existing vault LP already clears LP_DUST', () => {
    const r = refillPrecheck({
      ...base,
      bucketLps: 2_000_000n,
      vaultRefillLps: 2_000_000n,
      amountWad: 1n,
    });
    expect(r).toEqual({ ok: true });
  });

  it('discounts the minted estimate by minLpMintedBps for pure-quote buckets', () => {
    // amount exactly lpDust: minted estimate = lpDust * 0.99 < lpDust → reject.
    const r = refillPrecheck({ ...base, amountWad: base.lpDust });
    expect(r).toMatchObject({ ok: false, reason: 'below_dust' });
    // Grossing the amount up past the discount passes.
    const ok = refillPrecheck({ ...base, amountWad: (base.lpDust * 10001n) / 9900n });
    expect(ok).toEqual({ ok: true });
  });

  it('uses the undiscounted amount for mixed buckets', () => {
    const r = refillPrecheck({
      ...base,
      bucketCollateral: 5n,
      bucketLps: 2_000_000n,
      amountWad: base.lpDust,
    });
    expect(r).toEqual({ ok: true });
  });
});

describe('getRecoveryTargets', () => {
  it('maps configured arks to targets with resolved recovery settings', async () => {
    const { config } = await import('../../src/utils/config');
    const { getRecoveryTargets } = await import('../../src/keepers/recoveryKeeper');
    const ark = {
      vaultAddress: '0x00000000000000000000000000000000000000a1',
      vaultAuthAddress: '0x00000000000000000000000000000000000000b1',
    };
    (config.arks as unknown[]).push(ark);
    try {
      const targets = getRecoveryTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        vaultAddress: ark.vaultAddress,
        vaultAuthAddress: ark.vaultAuthAddress,
        settings: expect.objectContaining({ enabled: true }),
      });
    } finally {
      (config.arks as unknown[]).length = 0;
    }
  });
});
