import { maxUint256, type Address } from 'viem';
import { ACCRUAL_PAD_BPS } from '../../src/metavault/planner';

// Mirrors the clamped pad in metavaultKeeper._buildFinalAllocations: never exceeds the planned
// decrease, otherwise the submitted target would invert into a supply branch at Euler.
//
// ACCRUAL_PAD_BPS (5 bps) was chosen to cover interest accrual between the keeper's pre-reallocate
// refresh read and the reallocate transaction mining. In the unclamped regime (|delta| ≥
// realInitialAssets * 5/10000), the pad gives >10x headroom against accrual at 50% APR over 2
// blocks (12s each). In the clamped regime (|delta| < that threshold), the pad collapses to
// |delta| and any remaining accrual headroom is sacrificed to keep the target ≤ realInitialAssets
// — accepted as the safer trade-off than risking a supply-branch inversion at Euler.
export const accrualPad = (realInitialAssets: bigint, decrease: bigint): bigint => {
  const bps = (realInitialAssets * ACCRUAL_PAD_BPS) / 10000n;
  return bps < decrease ? bps : decrease;
};

export const effectiveWithdrawal = (realInitialAssets: bigint, decrease: bigint): bigint =>
  decrease - accrualPad(realInitialAssets, decrease);

// Mirrors Euler Earn's reallocate accounting: decreasing markets accrue to totalWithdrawn,
// increasing markets draw from it, and the maxUint256 sink absorbs the net remainder. Used to
// assert a submitted plan satisfies Euler's totalWithdrawn == totalSupplied invariant.
export const simulateEulerAccounting = (
  allocations: Array<{ id: Address; assets: bigint }>,
  balances: Array<{ id: Address; realInitialAssets: bigint }>,
): { totalWithdrawn: bigint; totalSupplied: bigint } => {
  let totalWithdrawn = 0n;
  let totalSupplied = 0n;
  const balanceById = new Map(balances.map((entry) => [entry.id, entry.realInitialAssets]));

  for (const allocation of allocations) {
    const supplyAssets = balanceById.get(allocation.id) ?? 0n;
    const withdrawn = supplyAssets > allocation.assets ? supplyAssets - allocation.assets : 0n;
    if (withdrawn > 0n) {
      totalWithdrawn += withdrawn;
      continue;
    }

    const supplied =
      allocation.assets === maxUint256
        ? totalWithdrawn > totalSupplied
          ? totalWithdrawn - totalSupplied
          : 0n
        : allocation.assets > supplyAssets
          ? allocation.assets - supplyAssets
          : 0n;
    totalSupplied += supplied;
  }

  return { totalWithdrawn, totalSupplied };
};
