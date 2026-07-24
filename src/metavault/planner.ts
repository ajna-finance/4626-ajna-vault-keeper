import { maxUint256, type Address } from 'viem';

export const ACCRUAL_PAD_BPS = 5n;

export type MarketAllocation = {
  id: Address;
  assets: bigint;
};

export type AddressedVault = {
  getAddress: () => Address | undefined;
};

export type Ark<Vault extends AddressedVault = AddressedVault> = {
  vault: Vault;
  min: number | undefined;
  max: number | undefined;
  rate: bigint;
};

export type ArkAllocation<Vault extends AddressedVault = AddressedVault> = {
  id: Address;
  assets: bigint;
  initialAssets: bigint;
  realInitialAssets: bigint;
  supplyCap: bigint;
  vault: Vault;
  min: number;
  max: number;
  rate: bigint;
  minMoveAmount: bigint;
  hasBadDebt: boolean;
};

export type BufferAllocation = {
  id: Address;
  assets: bigint;
  initialAssets: bigint;
  realInitialAssets: bigint;
  supplyCap: bigint;
  allocation: number;
};

type SupplyCappedAllocation = {
  assets: bigint;
  initialAssets: bigint;
  realInitialAssets: bigint;
  supplyCap: bigint;
};

type ArkEvaluation = {
  address: Address;
  targets: Address[];
};

export function _rebalanceBuffer(
  arks: ArkAllocation[],
  buffer: BufferAllocation,
  totalAssets: bigint,
  bufferMinMoveAmount = minimumMoveAmount(arks),
): void {
  for (const ark of arks) {
    const maxAssets = (totalAssets * BigInt(ark.max)) / 100n;
    if (ark.assets > maxAssets) {
      const excess = ark.assets - maxAssets;
      const addition = min(excess, remainingSupplyCapacity(buffer));
      ark.assets -= addition;
      buffer.assets += addition;
    }
  }

  const bufferTarget = (totalAssets * BigInt(buffer.allocation)) / 100n;

  if (buffer.assets < bufferTarget) {
    if (bufferTarget - buffer.assets >= bufferMinMoveAmount) {
      _fillBuffer(arks, buffer, bufferTarget, totalAssets);
    }
  } else if (buffer.assets > bufferTarget) {
    if (buffer.assets - bufferTarget >= bufferMinMoveAmount) {
      _drainBuffer(arks, buffer, bufferTarget, totalAssets);
    }
  }
}

function _fillBuffer(
  arks: ArkAllocation[],
  buffer: BufferAllocation,
  bufferTarget: bigint,
  totalAssets: bigint,
): void {
  let deficit = receivableCapacity(buffer, bufferTarget);

  const sorted = [...arks].sort((a, b) => (a.rate < b.rate ? -1 : a.rate > b.rate ? 1 : 0));

  for (const ark of sorted) {
    if (deficit <= 0n) break;

    const minAssets = (totalAssets * BigInt(ark.min)) / 100n;
    const available = ark.assets - minAssets;
    if (available <= 0n) continue;

    const deduction = available < deficit ? available : deficit;
    if (deduction < ark.minMoveAmount) continue;
    ark.assets -= deduction;
    buffer.assets += deduction;
    deficit -= deduction;
  }

  if (deficit > 0n) {
    for (const ark of sorted) {
      if (deficit <= 0n) break;
      if (ark.assets <= 0n) continue;

      const deduction = ark.assets < deficit ? ark.assets : deficit;
      if (deduction < ark.minMoveAmount) continue;
      ark.assets -= deduction;
      buffer.assets += deduction;
      deficit -= deduction;
    }
  }
}

function _drainBuffer(
  arks: ArkAllocation[],
  buffer: BufferAllocation,
  bufferTarget: bigint,
  totalAssets: bigint,
): void {
  let excess = buffer.assets - bufferTarget;

  const sorted = [...arks].sort((a, b) => (a.rate > b.rate ? -1 : a.rate < b.rate ? 1 : 0));

  for (const ark of sorted) {
    if (excess <= 0n) break;
    if (ark.hasBadDebt) continue;

    const maxAssets = (totalAssets * BigInt(ark.max)) / 100n;
    const capacity = receivableCapacity(ark, maxAssets);
    if (capacity <= 0n) continue;

    const addition = min(capacity, excess);
    if (addition < ark.minMoveAmount) continue;
    ark.assets += addition;
    buffer.assets -= addition;
    excess -= addition;
  }
}

export function _isRateReallocationRequired(evaluations: ArkEvaluation[]): boolean {
  return evaluations.some((e) => e.targets.length > 0);
}

export function _reallocateForRates(
  arks: ArkAllocation[],
  evaluations: ArkEvaluation[],
  totalAssets: bigint,
): void {
  const sorted = [...arks].sort((a, b) => (a.rate < b.rate ? -1 : a.rate > b.rate ? 1 : 0));

  for (const ark of sorted) {
    const evaluation = evaluations.find((e) => e.address === ark.id);
    if (!evaluation || evaluation.targets.length === 0) continue;

    const minAssets = (totalAssets * BigInt(ark.min)) / 100n;
    let available = ark.assets - minAssets;
    if (available <= 0n) continue;

    for (const targetAddress of evaluation.targets) {
      if (available <= 0n) break;

      const target = arks.find((a) => a.id === targetAddress);
      if (!target || target.hasBadDebt) continue;

      const maxAssets = (totalAssets * BigInt(target.max)) / 100n;
      const capacity = receivableCapacity(target, maxAssets);
      if (capacity <= 0n) continue;

      const moveAmount = min(available, capacity);
      if (moveAmount < ark.minMoveAmount) continue;
      ark.assets -= moveAmount;
      target.assets += moveAmount;
      available -= moveAmount;
    }
  }
}

export function _validateAllocations(
  arks: ArkAllocation[],
  buffer: BufferAllocation,
  totalAssets: bigint,
): string | null {
  const tolerance = totalAssets / 1_000_000n || 1n;
  const bufferTarget = (totalAssets * BigInt(buffer.allocation)) / 100n;
  const bufferAtTarget = buffer.assets >= bufferTarget || bufferTarget - buffer.assets <= tolerance;

  for (const ark of arks) {
    const minAssets = (totalAssets * BigInt(ark.min)) / 100n;
    const maxAssets = (totalAssets * BigInt(ark.max)) / 100n;

    if (ark.assets + tolerance < minAssets && !bufferAtTarget) {
      return `Ark ${ark.id} allocation ${ark.assets} is below min ${minAssets}`;
    }
    const projectedAssets = projectedRealAssets(ark);
    if (plannedSupply(ark) > 0n && projectedAssets > maxAssets + tolerance) {
      return `Ark ${ark.id} allocation ${projectedAssets} is above max ${maxAssets}`;
    }
    const supplyCapError = supplyCapErrorMessage('Ark', ark.id, ark);
    if (supplyCapError) return supplyCapError;
  }

  const allArksAtMax = arks.every(
    (ark) => ark.assets + tolerance >= (totalAssets * BigInt(ark.max)) / 100n,
  );

  if (allArksAtMax) {
    if (buffer.assets + tolerance < bufferTarget) {
      return `Buffer allocation ${buffer.assets} is below target ${bufferTarget} despite all arks at max`;
    }
  } else if (!bufferAtTarget) {
    const diff =
      buffer.assets > bufferTarget ? buffer.assets - bufferTarget : bufferTarget - buffer.assets;
    if (diff > tolerance) {
      return `Buffer allocation ${buffer.assets} does not equal target ${bufferTarget}`;
    }
  }

  const bufferSupplyCapError = supplyCapErrorMessage('Buffer', buffer.id, buffer);
  if (bufferSupplyCapError) return bufferSupplyCapError;

  return null;
}

export function _buildFinalAllocations(
  arks: ArkAllocation[],
  buffer: BufferAllocation,
): MarketAllocation[] | string {
  const all = [
    ...arks.map((a) => ({
      id: a.id,
      delta: a.assets - a.initialAssets,
      realInitialAssets: a.realInitialAssets,
      supplyCap: a.supplyCap,
    })),
    {
      id: buffer.id,
      delta: buffer.assets - buffer.initialAssets,
      realInitialAssets: buffer.realInitialAssets,
      supplyCap: buffer.supplyCap,
    },
  ];

  for (const a of all) {
    if (a.delta < 0n && a.realInitialAssets < -a.delta) {
      return `refreshed real balance for ${a.id} (${a.realInitialAssets}) is below planned decrease (${-a.delta})`;
    }
  }

  const withTargets = all.map((a) => {
    const effectiveWithdrawn =
      a.delta < 0n ? _effectiveWithdrawal(a.realInitialAssets, -a.delta) : 0n;
    const finalTarget =
      a.delta < 0n ? a.realInitialAssets - effectiveWithdrawn : a.realInitialAssets + a.delta;
    return {
      id: a.id,
      delta: a.delta,
      realInitialAssets: a.realInitialAssets,
      finalTarget,
      effectiveWithdrawn,
    };
  });

  const decreasing = withTargets.filter((a) => a.delta < 0n && a.effectiveWithdrawn > 0n);
  const increasing = withTargets.filter((a) => a.delta > 0n);

  if (decreasing.length === 0 && increasing.length === 0) return [];

  const totalWithdrawn = withTargets.reduce((sum, a) => (a.delta < 0n ? sum + -a.delta : sum), 0n);
  const totalSupplied = increasing.reduce((sum, a) => sum + a.delta, 0n);
  if (totalWithdrawn !== totalSupplied) {
    return `inconsistent reallocation: totalWithdrawn (${totalWithdrawn}) != totalSupplied (${totalSupplied})`;
  }

  const effectiveWithdrawn = decreasing.reduce((sum, a) => sum + a.effectiveWithdrawn, 0n);
  if (effectiveWithdrawn === 0n) {
    return `accrual pad absorbs planned withdrawals (${totalWithdrawn})`;
  }

  let remainingSupply = effectiveWithdrawn;
  const ordered: MarketAllocation[] = decreasing.map((a) => ({ id: a.id, assets: a.finalTarget }));

  for (const a of increasing.slice(0, -1)) {
    if (remainingSupply === 0n) break;
    const supply = a.delta < remainingSupply ? a.delta : remainingSupply;
    ordered.push({ id: a.id, assets: a.realInitialAssets + supply });
    remainingSupply -= supply;
  }

  if (increasing.length > 0) {
    ordered.push({ id: increasing[increasing.length - 1]!.id, assets: maxUint256 });
  }

  const simulated = _simulateEulerReallocationAccounting(ordered, all);
  if (simulated.capExceeded) {
    return `supply cap exceeded for ${simulated.capExceeded.id}: final assets ${simulated.capExceeded.finalAssets} > cap ${simulated.capExceeded.supplyCap}`;
  }
  if (simulated.totalWithdrawn !== simulated.totalSupplied) {
    return `simulated reallocation is unbalanced: totalWithdrawn (${simulated.totalWithdrawn}) != totalSupplied (${simulated.totalSupplied})`;
  }

  return ordered;
}

function _simulateEulerReallocationAccounting(
  allocations: MarketAllocation[],
  balances: Array<{ id: Address; realInitialAssets: bigint; supplyCap: bigint }>,
): {
  totalWithdrawn: bigint;
  totalSupplied: bigint;
  capExceeded?: { id: Address; finalAssets: bigint; supplyCap: bigint };
} {
  let totalWithdrawn = 0n;
  let totalSupplied = 0n;
  const balanceById = new Map(balances.map((a) => [a.id, a]));

  for (const allocation of allocations) {
    const balance = balanceById.get(allocation.id);
    const supplyAssets = balance?.realInitialAssets ?? 0n;
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
    const finalAssets = supplyAssets + supplied;
    if (balance && supplied > 0n && finalAssets > balance.supplyCap) {
      return {
        totalWithdrawn,
        totalSupplied,
        capExceeded: { id: allocation.id, finalAssets, supplyCap: balance.supplyCap },
      };
    }
    totalSupplied += supplied;
  }

  return { totalWithdrawn, totalSupplied };
}

function capHeadroom(allocation: SupplyCappedAllocation): bigint {
  return allocation.supplyCap > allocation.realInitialAssets
    ? allocation.supplyCap - allocation.realInitialAssets
    : 0n;
}

function plannedSupply(allocation: SupplyCappedAllocation): bigint {
  return allocation.assets > allocation.initialAssets
    ? allocation.assets - allocation.initialAssets
    : 0n;
}

function remainingSupplyCapacity(allocation: SupplyCappedAllocation): bigint {
  const ceiling = allocation.initialAssets + capHeadroom(allocation);
  return ceiling > allocation.assets ? ceiling - allocation.assets : 0n;
}

function projectedRealAssets(allocation: SupplyCappedAllocation): bigint {
  return allocation.assets + allocation.realInitialAssets - allocation.initialAssets;
}

function receivableCapacity(allocation: SupplyCappedAllocation, maxAssets: bigint): bigint {
  const projected = projectedRealAssets(allocation);
  const room = maxAssets > projected ? maxAssets - projected : 0n;
  return min(room, remainingSupplyCapacity(allocation));
}

function supplyCapErrorMessage(
  label: 'Ark' | 'Buffer',
  id: Address,
  allocation: SupplyCappedAllocation,
): string | null {
  const supply = plannedSupply(allocation);
  const cap = capHeadroom(allocation);
  return supply > cap
    ? `${label} ${id} planned supply ${supply} exceeds supply cap capacity ${cap}`
    : null;
}

function minimumMoveAmount(arks: ArkAllocation[]): bigint {
  return arks.reduce(
    (current, ark) => (ark.minMoveAmount < current ? ark.minMoveAmount : current),
    arks[0]?.minMoveAmount ?? 0n,
  );
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function _accrualPad(realInitialAssets: bigint, decrease: bigint): bigint {
  const bpsPad = (realInitialAssets * ACCRUAL_PAD_BPS) / 10000n;
  return bpsPad < decrease ? bpsPad : decrease;
}

export function _effectiveWithdrawal(realInitialAssets: bigint, decrease: bigint): bigint {
  return decrease - _accrualPad(realInitialAssets, decrease);
}

export function _findUnpreparedArkWithdrawal(
  allocations: MarketAllocation[],
  arks: ArkAllocation[],
  preparedArks: Set<Address>,
): Address | null {
  const arkById = new Map(arks.map((ark) => [ark.id, ark]));

  for (const allocation of allocations) {
    const ark = arkById.get(allocation.id);
    if (!ark) continue;
    if (allocation.assets !== maxUint256 && ark.realInitialAssets > allocation.assets) {
      if (!preparedArks.has(ark.id)) return ark.id;
    }
  }

  return null;
}
