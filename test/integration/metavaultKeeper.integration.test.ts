/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { metavaultRun } from '../../src/keepers/metavaultKeeper';
import { ACCRUAL_PAD_BPS } from '../../src/metavault/planner';
import { arkRun } from '../../src/keepers/arkKeeper';
import {
  getExpectedSupplyAssets,
  getTotalExpectedSupplyAssets,
} from '../../src/metavault/metavault';
import { config, resolveArkSettings } from '../../src/utils/config';
import { client } from '../../src/utils/client';
import { contract } from '../../src/utils/contract';
import { type Address } from 'viem';
import { waitForWrite } from '../helpers/transactions';

// Tolerance large enough to absorb the accrual pad's slack across all configured strategies
// (decreasing targets ask Euler to withdraw slightly less than what was prepared, so the buffer
// ends up below its nominal target by up to pad * num_strategies).
const padAwareTolerance = (totalAssets: bigint): bigint => {
  const strategies = BigInt(config.arks.length + 1);
  return (totalAssets * ACCRUAL_PAD_BPS * strategies * 3n) / 10000n + 1n;
};

vi.mock('../../src/ajna/poolHealth.ts', () => ({
  poolHasBadDebt: vi.fn().mockResolvedValue(false),
}));

describe('metavault keeper run', () => {
  let snapshot: string;

  const getStrategyAddresses = (): Address[] => [
    config.buffer.address,
    ...config.arks.map((ark) => ark.address),
  ];

  const getBalances = async () => {
    const bufferBalance = await getExpectedSupplyAssets(config.buffer.address);
    const arkBalances = await Promise.all(
      config.arks.map((ark) => getExpectedSupplyAssets(ark.address)),
    );
    const totalAssets = await getTotalExpectedSupplyAssets(getStrategyAddresses());
    return { bufferBalance, arkBalances, totalAssets };
  };

  beforeAll(async () => {
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
  });

  afterAll(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
  });

  beforeEach(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
  });

  it('reallocates from buffer to arks when buffer holds all funds', async () => {
    const before = await getBalances();

    // Verify initial state: all funds in buffer, arks empty
    expect(Number(before.bufferBalance) / 1e18).toBeCloseTo(500, 0);
    for (const balance of before.arkBalances) {
      expect(balance).toBe(0n);
    }

    await metavaultRun();

    const after = await getBalances();

    const tolerance = after.totalAssets / 1_000_000n || 1n;

    // Buffer should be at its target allocation (40%)
    const bufferTarget = (after.totalAssets * BigInt(config.buffer.allocation)) / 100n;
    expect(Number(after.bufferBalance) / 1e18).toBeCloseTo(Number(bufferTarget) / 1e18, 0);

    // Each ark should have received funds and be within its min/max bounds
    for (let i = 0; i < config.arks.length; i++) {
      const arkConfig = config.arks[i]!;
      const minAssets = (after.totalAssets * BigInt(arkConfig.allocation.min)) / 100n;
      const maxAssets = (after.totalAssets * BigInt(arkConfig.allocation.max)) / 100n;

      expect(after.arkBalances[i]!).toBeGreaterThanOrEqual(minAssets - tolerance);
      expect(after.arkBalances[i]!).toBeLessThanOrEqual(maxAssets + tolerance);
    }

    // Total assets should be preserved
    expect(Number(after.totalAssets) / 1e18).toBeCloseTo(Number(before.totalAssets) / 1e18, 0);
  });

  it('is a no-op when allocations are already at target', async () => {
    // First run: move funds from buffer to arks
    await metavaultRun();
    const afterFirstRun = await getBalances();

    // Second run: should be a no-op since allocations are at target
    await metavaultRun();
    const afterSecondRun = await getBalances();

    const tolerance = padAwareTolerance(afterFirstRun.totalAssets);

    const bufferDiff =
      afterSecondRun.bufferBalance > afterFirstRun.bufferBalance
        ? afterSecondRun.bufferBalance - afterFirstRun.bufferBalance
        : afterFirstRun.bufferBalance - afterSecondRun.bufferBalance;
    expect(bufferDiff).toBeLessThanOrEqual(tolerance);

    for (let i = 0; i < config.arks.length; i++) {
      const diff =
        afterSecondRun.arkBalances[i]! > afterFirstRun.arkBalances[i]!
          ? afterSecondRun.arkBalances[i]! - afterFirstRun.arkBalances[i]!
          : afterFirstRun.arkBalances[i]! - afterSecondRun.arkBalances[i]!;
      expect(diff).toBeLessThanOrEqual(tolerance);
    }
  });

  it('respects ark max allocation bounds', async () => {
    await metavaultRun();
    const after = await getBalances();
    const tolerance = after.totalAssets / 1_000_000n || 1n;

    for (let i = 0; i < config.arks.length; i++) {
      const arkConfig = config.arks[i]!;
      const maxAssets = (after.totalAssets * BigInt(arkConfig.allocation.max)) / 100n;
      expect(after.arkBalances[i]!).toBeLessThanOrEqual(maxAssets + tolerance);
    }
  });

  it('preserves total assets across reallocation', async () => {
    const before = await getBalances();
    await metavaultRun();
    const after = await getBalances();

    // Total should be the same (within rounding tolerance)
    expect(Number(after.totalAssets) / 1e18).toBeCloseTo(Number(before.totalAssets) / 1e18, 0);
  });

  it('skips entire run when any ark is paused', async () => {
    // First run to distribute funds normally
    await metavaultRun();
    const afterFirstRun = await getBalances();

    // Pause the first ark
    const arkAuthAddress = process.env.ARK_AUTH_1_ADDRESS as Address;
    const arkAuth = contract('vaultAuth', arkAuthAddress);
    await waitForWrite(arkAuth().write.pause());

    // Second run should be a no-op (early return due to paused ark)
    await metavaultRun();

    // Unpause and verify nothing changed
    await waitForWrite(arkAuth().write.unpause());
    const afterSecondRun = await getBalances();

    const tolerance = afterFirstRun.totalAssets / 1_000_000n || 1n;
    for (let i = 0; i < config.arks.length; i++) {
      const diff =
        afterSecondRun.arkBalances[i]! > afterFirstRun.arkBalances[i]!
          ? afterSecondRun.arkBalances[i]! - afterFirstRun.arkBalances[i]!
          : afterFirstRun.arkBalances[i]! - afterSecondRun.arkBalances[i]!;
      expect(diff).toBeLessThanOrEqual(tolerance);
    }
  });

  it('rebalances correctly after additional deposit into metavault', async () => {
    // First run to establish initial allocations
    await metavaultRun();
    const afterFirstRun = await getBalances();

    // Deposit additional funds into the metavault (goes to buffer via supply queue)
    const metavault = contract('metavault');
    const quoteTokenAddress = (await metavault().read.asset()) as Address;
    const depositAmount = 100n * 10n ** 18n;
    const erc20ApproveAbi = [
      {
        name: 'approve',
        type: 'function' as const,
        stateMutability: 'nonpayable' as const,
        inputs: [
          { name: 'spender', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bool' }],
      },
    ];
    await waitForWrite(
      client.writeContract({
        address: quoteTokenAddress,
        abi: erc20ApproveAbi,
        functionName: 'approve',
        args: [config.metavaultAddress as Address, depositAmount],
      }),
    );
    await waitForWrite(metavault().write.deposit([depositAmount, client.account.address]));

    const afterDeposit = await getBalances();
    expect(afterDeposit.totalAssets).toBeGreaterThan(afterFirstRun.totalAssets);

    // Second run should redistribute the excess
    await metavaultRun();
    const afterSecondRun = await getBalances();

    const tolerance = padAwareTolerance(afterSecondRun.totalAssets);

    // Buffer should be back near its target
    const bufferTarget = (afterSecondRun.totalAssets * BigInt(config.buffer.allocation)) / 100n;
    const bufferDiff =
      afterSecondRun.bufferBalance > bufferTarget
        ? afterSecondRun.bufferBalance - bufferTarget
        : bufferTarget - afterSecondRun.bufferBalance;
    expect(bufferDiff).toBeLessThanOrEqual(tolerance);

    // All arks should be within bounds
    for (let i = 0; i < config.arks.length; i++) {
      const arkConfig = config.arks[i]!;
      const minAssets = (afterSecondRun.totalAssets * BigInt(arkConfig.allocation.min)) / 100n;
      const maxAssets = (afterSecondRun.totalAssets * BigInt(arkConfig.allocation.max)) / 100n;
      expect(afterSecondRun.arkBalances[i]!).toBeGreaterThanOrEqual(minAssets - tolerance);
      expect(afterSecondRun.arkBalances[i]!).toBeLessThanOrEqual(maxAssets + tolerance);
    }
  });

  it('sum of all strategy balances equals totalAssets after reallocation', async () => {
    await metavaultRun();
    const after = await getBalances();

    const sumOfBalances = after.bufferBalance + after.arkBalances.reduce((sum, b) => sum + b, 0n);
    const tolerance = after.totalAssets / 1_000_000n || 1n;

    const diff =
      sumOfBalances > after.totalAssets
        ? sumOfBalances - after.totalAssets
        : after.totalAssets - sumOfBalances;
    expect(diff).toBeLessThanOrEqual(tolerance);
  });

  it('rebalances after a withdrawal reduces total assets', async () => {
    // First run distributes funds to arks
    await metavaultRun();
    // Mirror scheduler.ts: ark keepers move freshly-deposited buffer funds into buckets, so the
    // next metavault run sees per-ark bucket liquidity (the operational invariant the strict
    // bucket-coverage check relies on).
    for (const ark of config.arks) {
      await arkRun(ark.vaultAddress, ark.vaultAuthAddress, resolveArkSettings(ark));
    }
    const afterFirstRun = await getBalances();

    // Withdraw from the metavault to reduce total assets, making arks overweight
    const metavault = contract('metavault');
    const withdrawAmount = 100n * 10n ** 18n;
    await waitForWrite(
      metavault().write.withdraw([withdrawAmount, client.account.address, client.account.address]),
    );

    const afterWithdraw = await getBalances();
    expect(afterWithdraw.totalAssets).toBeLessThan(afterFirstRun.totalAssets);

    // Run again — should move funds from arks back to buffer to rebalance
    await metavaultRun();
    const afterSecondRun = await getBalances();

    const tolerance = padAwareTolerance(afterSecondRun.totalAssets);

    // Buffer should be near target for the new total
    const bufferTarget = (afterSecondRun.totalAssets * BigInt(config.buffer.allocation)) / 100n;
    const bufferDiff =
      afterSecondRun.bufferBalance > bufferTarget
        ? afterSecondRun.bufferBalance - bufferTarget
        : bufferTarget - afterSecondRun.bufferBalance;
    expect(bufferDiff).toBeLessThanOrEqual(tolerance);

    // All arks should be within bounds relative to new total
    for (let i = 0; i < config.arks.length; i++) {
      const arkConfig = config.arks[i]!;
      const minAssets = (afterSecondRun.totalAssets * BigInt(arkConfig.allocation.min)) / 100n;
      const maxAssets = (afterSecondRun.totalAssets * BigInt(arkConfig.allocation.max)) / 100n;
      expect(afterSecondRun.arkBalances[i]!).toBeGreaterThanOrEqual(minAssets - tolerance);
      expect(afterSecondRun.arkBalances[i]!).toBeLessThanOrEqual(maxAssets + tolerance);
    }

    // Total assets preserved post-rebalance
    expect(Number(afterSecondRun.totalAssets) / 1e18).toBeCloseTo(
      Number(afterWithdraw.totalAssets) / 1e18,
      0,
    );
  });

  it('rebalances to include previously paused ark after unpause', async () => {
    // Pause ark 1 before the first run
    const arkAuthAddress = process.env.ARK_AUTH_1_ADDRESS as Address;
    const arkAuth = contract('vaultAuth', arkAuthAddress);
    await waitForWrite(arkAuth().write.pause());

    // Run with ark 1 paused — it should be excluded
    await metavaultRun();
    const whilePaused = await getBalances();

    // Ark 1 should have received nothing (it started empty and was paused)
    expect(whilePaused.arkBalances[0]!).toBe(0n);

    // Unpause ark 1
    await waitForWrite(arkAuth().write.unpause());

    // Run again — should now include ark 1 in rebalancing
    await metavaultRun();
    const afterUnpause = await getBalances();

    // Ark 1 should now have funds
    expect(afterUnpause.arkBalances[0]!).toBeGreaterThan(0n);

    // All arks should be within bounds
    const tolerance = afterUnpause.totalAssets / 1_000_000n || 1n;
    for (let i = 0; i < config.arks.length; i++) {
      const arkConfig = config.arks[i]!;
      const minAssets = (afterUnpause.totalAssets * BigInt(arkConfig.allocation.min)) / 100n;
      const maxAssets = (afterUnpause.totalAssets * BigInt(arkConfig.allocation.max)) / 100n;
      expect(afterUnpause.arkBalances[i]!).toBeGreaterThanOrEqual(minAssets - tolerance);
      expect(afterUnpause.arkBalances[i]!).toBeLessThanOrEqual(maxAssets + tolerance);
    }
  });
});
