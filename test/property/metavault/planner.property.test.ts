import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('../../../src/utils/config', () => ({
  config: {
    minRateDiff: 10,
    keeper: { logLevel: 'warn', haltIfLupBelowHtp: true },
    oracle: {
      onchainPrimary: false,
      onchainMaxStaleness: null,
      fixedPrice: null,
      futureSkewTolerance: 120,
    },
    arkGlobal: { optimalBucketDiff: 1, maxAuctionAge: 259200, minMoveAmount: '1000001' },
    transaction: { confirmations: 1 },
    defaultGas: 3_000_000n,
    gasBuffer: 50n,
    chainId: 1,
  },
  resolveArkSettings: () => ({
    optimalBucketDiff: 1n,
    bufferPadding: 100000000000000n,
    minMoveAmount: 1_000_001n,
    minTimeSinceBankruptcy: 259200n,
    maxAuctionAge: 259200,
  }),
}));

import {
  _buildFinalAllocations,
  _rebalanceBuffer,
  _reallocateForRates,
  type Ark,
  type ArkAllocation,
  type BufferAllocation,
} from '../../../src/metavault/planner';

import { evaluateRates } from '../../../src/metavault/utils/evaluateRates';
import { type Address, maxUint256 } from 'viem';
import { type createVault } from '../../../src/ark/vault';
import { accrualPad, effectiveWithdrawal, simulateEulerAccounting } from '../../helpers/eulerModel';

const S = 1_000_000n;
const ADDRESSES = [
  '0x0000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000002',
  '0x0000000000000000000000000000000000000003',
] as const satisfies Address[];
const BUFFER_ADDRESS = '0x00000000000000000000000000000000000000ff' as Address;

type Vault = ReturnType<typeof createVault>;

function makeVault(address: Address): Vault {
  return { getAddress: () => address } as unknown as Vault;
}

function percentagePartition(total: number, cuts: number[]): [number, number, number, number] {
  const sorted = [...cuts].sort((a, b) => a - b);
  return [sorted[0]!, sorted[1]! - sorted[0]!, sorted[2]! - sorted[1]!, total - sorted[2]!];
}

function assetPartition(totalUnits: number, cuts: number[]): [bigint, bigint, bigint, bigint] {
  const sorted = [...cuts].sort((a, b) => a - b);
  return [
    BigInt(sorted[0]!) * S,
    BigInt(sorted[1]! - sorted[0]!) * S,
    BigInt(sorted[2]! - sorted[1]!) * S,
    BigInt(totalUnits - sorted[2]!) * S,
  ];
}

const rebalanceScenarioArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 99 }), {
    minLength: 3,
    maxLength: 3,
  })
  .chain((cuts) => {
    const [bufferAllocation, maxA, maxB, maxC] = percentagePartition(100, cuts);

    return fc
      .record({
        totalUnits: fc.integer({ min: 200, max: 5_000 }),
        assetCuts: fc.tuple(
          fc.integer({ min: 0, max: 5_000 }),
          fc.integer({ min: 0, max: 5_000 }),
          fc.integer({ min: 0, max: 5_000 }),
        ),
        minSeeds: fc.tuple(
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
        ),
        rates: fc.tuple(
          fc.bigInt({ min: 0n, max: 10_000n }),
          fc.bigInt({ min: 0n, max: 10_000n }),
          fc.bigInt({ min: 0n, max: 10_000n }),
        ),
        badDebt: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()),
      })
      .map(({ totalUnits, assetCuts, minSeeds, rates, badDebt }) => {
        const [bufferAssets, assetsA, assetsB, assetsC] = assetPartition(
          totalUnits,
          assetCuts.map((cut) => cut % (totalUnits + 1)),
        );
        const mins = [
          minSeeds[0] % (maxA + 1),
          minSeeds[1] % (maxB + 1),
          minSeeds[2] % (maxC + 1),
        ] as const;

        const arks: ArkAllocation[] = [
          {
            id: ADDRESSES[0],
            assets: assetsA,
            initialAssets: assetsA,
            realInitialAssets: assetsA,
            vault: makeVault(ADDRESSES[0]),
            min: mins[0],
            max: maxA,
            rate: rates[0],
            minMoveAmount: 1_000_001n,
            hasBadDebt: badDebt[0],
            supplyCap: maxUint256,
          },
          {
            id: ADDRESSES[1],
            assets: assetsB,
            initialAssets: assetsB,
            realInitialAssets: assetsB,
            vault: makeVault(ADDRESSES[1]),
            min: mins[1],
            max: maxB,
            rate: rates[1],
            minMoveAmount: 1_000_001n,
            hasBadDebt: badDebt[1],
            supplyCap: maxUint256,
          },
          {
            id: ADDRESSES[2],
            assets: assetsC,
            initialAssets: assetsC,
            realInitialAssets: assetsC,
            vault: makeVault(ADDRESSES[2]),
            min: mins[2],
            max: maxC,
            rate: rates[2],
            minMoveAmount: 1_000_001n,
            hasBadDebt: badDebt[2],
            supplyCap: maxUint256,
          },
        ];

        const buffer: BufferAllocation = {
          id: BUFFER_ADDRESS,
          assets: bufferAssets,
          initialAssets: bufferAssets,
          realInitialAssets: bufferAssets,
          supplyCap: maxUint256,
          allocation: bufferAllocation,
        };

        return {
          totalAssets: BigInt(totalUnits) * S,
          arks,
          buffer,
        };
      });
  });

const rateScenarioArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 99 }), {
    minLength: 3,
    maxLength: 3,
  })
  .chain((cuts) => {
    const [, maxA, maxB, maxC] = percentagePartition(100, cuts);

    return fc
      .record({
        totalUnits: fc.integer({ min: 200, max: 5_000 }),
        minSeeds: fc.tuple(
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
        ),
        shareSeeds: fc.tuple(
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
        ),
        rates: fc.tuple(
          fc.bigInt({ min: 0n, max: 10_000n }),
          fc.bigInt({ min: 0n, max: 10_000n }),
          fc.bigInt({ min: 0n, max: 10_000n }),
        ),
        badDebt: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()),
      })
      .map(({ totalUnits, minSeeds, shareSeeds, rates, badDebt }) => {
        const mins = [
          minSeeds[0] % (maxA + 1),
          minSeeds[1] % (maxB + 1),
          minSeeds[2] % (maxC + 1),
        ] as const;
        const shares = [
          mins[0] + (shareSeeds[0] % (maxA - mins[0] + 1)),
          mins[1] + (shareSeeds[1] % (maxB - mins[1] + 1)),
          mins[2] + (shareSeeds[2] % (maxC - mins[2] + 1)),
        ] as const;
        const totalAssets = BigInt(totalUnits) * S;

        const arks: ArkAllocation[] = [
          {
            id: ADDRESSES[0],
            assets: (totalAssets * BigInt(shares[0])) / 100n,
            initialAssets: (totalAssets * BigInt(shares[0])) / 100n,
            realInitialAssets: (totalAssets * BigInt(shares[0])) / 100n,
            vault: makeVault(ADDRESSES[0]),
            min: mins[0],
            max: maxA,
            rate: rates[0],
            minMoveAmount: 1_000_001n,
            hasBadDebt: badDebt[0],
            supplyCap: maxUint256,
          },
          {
            id: ADDRESSES[1],
            assets: (totalAssets * BigInt(shares[1])) / 100n,
            initialAssets: (totalAssets * BigInt(shares[1])) / 100n,
            realInitialAssets: (totalAssets * BigInt(shares[1])) / 100n,
            vault: makeVault(ADDRESSES[1]),
            min: mins[1],
            max: maxB,
            rate: rates[1],
            minMoveAmount: 1_000_001n,
            hasBadDebt: badDebt[1],
            supplyCap: maxUint256,
          },
          {
            id: ADDRESSES[2],
            assets: (totalAssets * BigInt(shares[2])) / 100n,
            initialAssets: (totalAssets * BigInt(shares[2])) / 100n,
            realInitialAssets: (totalAssets * BigInt(shares[2])) / 100n,
            vault: makeVault(ADDRESSES[2]),
            min: mins[2],
            max: maxC,
            rate: rates[2],
            minMoveAmount: 1_000_001n,
            hasBadDebt: badDebt[2],
            supplyCap: maxUint256,
          },
        ];

        return { arks, totalAssets };
      });
  });

function cloneArks(arks: ArkAllocation[]): ArkAllocation[] {
  return arks.map((ark) => ({ ...ark }));
}

function sumArkAssets(arks: ArkAllocation[]): bigint {
  return arks.reduce((sum, ark) => sum + ark.assets, 0n);
}

function toArks(allocations: ArkAllocation[]): Ark[] {
  return allocations.map((allocation) => ({
    vault: allocation.vault,
    min: allocation.min,
    max: allocation.max,
    rate: allocation.rate,
  }));
}

describe('metavault planner property tests', () => {
  it('rebalanceBuffer conserves assets, respects max bounds, and never allocates excess buffer to bad-debt arks', () => {
    fc.assert(
      fc.property(rebalanceScenarioArb, ({ arks, buffer, totalAssets }) => {
        const before = cloneArks(arks);
        const beforeBuffer = { ...buffer };
        const bufferTarget = (totalAssets * BigInt(buffer.allocation)) / 100n;
        const startedWithBufferExcess = buffer.assets > bufferTarget;
        const totalBefore = sumArkAssets(arks) + buffer.assets;

        _rebalanceBuffer(arks, buffer, totalAssets);

        const totalAfter = sumArkAssets(arks) + buffer.assets;

        expect(totalAfter).toBe(totalBefore);

        for (let i = 0; i < arks.length; i++) {
          const ark = arks[i]!;
          const original = before[i]!;
          const maxAssets = (totalAssets * BigInt(ark.max)) / 100n;

          expect(ark.assets).toBeLessThanOrEqual(maxAssets);

          if (startedWithBufferExcess && original.hasBadDebt) {
            expect(ark.assets).toBeLessThanOrEqual(original.assets);
          }
        }

        expect(buffer.assets).toBeGreaterThanOrEqual(0n);
        expect(beforeBuffer.assets + sumArkAssets(before)).toBe(totalBefore);
      }),
      { numRuns: 200 },
    );
  });

  it('reallocateForRates conserves ark assets, preserves min bounds, and never routes funds into bad-debt arks', () => {
    fc.assert(
      fc.property(rateScenarioArb, ({ arks, totalAssets }) => {
        const before = cloneArks(arks);
        const evaluations = evaluateRates(toArks(arks));
        const validTargets = new Set(evaluations.flatMap((evaluation) => evaluation.targets));
        const totalBefore = sumArkAssets(arks);

        _reallocateForRates(arks, evaluations, totalAssets);

        const totalAfter = sumArkAssets(arks);
        expect(totalAfter).toBe(totalBefore);

        for (let i = 0; i < arks.length; i++) {
          const ark = arks[i]!;
          const original = before[i]!;
          const minAssets = (totalAssets * BigInt(ark.min)) / 100n;
          const maxAssets = (totalAssets * BigInt(ark.max)) / 100n;

          expect(ark.assets).toBeGreaterThanOrEqual(minAssets);
          expect(ark.assets).toBeLessThanOrEqual(maxAssets);

          if (original.hasBadDebt) {
            expect(ark.assets).toBeLessThanOrEqual(original.assets);
          }

          if (ark.assets > original.assets) {
            expect(validTargets.has(ark.id)).toBe(true);
            expect(ark.hasBadDebt).toBe(false);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('buildFinalAllocations always returns a correctly ordered, balanced reallocation plan after rebalanceBuffer', () => {
    fc.assert(
      fc.property(rebalanceScenarioArb, ({ arks, buffer, totalAssets }) => {
        _rebalanceBuffer(arks, buffer, totalAssets);

        const result = _buildFinalAllocations(arks, buffer);

        const all = [
          ...arks.map((ark) => ({
            id: ark.id,
            assets: ark.assets,
            initialAssets: ark.initialAssets,
            realInitialAssets: ark.realInitialAssets,
          })),
          {
            id: buffer.id,
            assets: buffer.assets,
            initialAssets: buffer.initialAssets,
            realInitialAssets: buffer.realInitialAssets,
          },
        ];
        const decreasing = all
          .filter((entry) => entry.assets < entry.initialAssets)
          .map((entry) => {
            const decrease = entry.initialAssets - entry.assets;
            return {
              ...entry,
              decrease,
              effectiveWithdrawn: effectiveWithdrawal(entry.realInitialAssets, decrease),
            };
          });
        const increasing = all.filter((entry) => entry.assets > entry.initialAssets);
        const effectiveDecreasing = decreasing.filter((entry) => entry.effectiveWithdrawn > 0n);
        const totalEffectiveWithdrawn = effectiveDecreasing.reduce(
          (sum, entry) => sum + entry.effectiveWithdrawn,
          0n,
        );

        if (decreasing.length === 0 && increasing.length === 0) {
          expect(result).toEqual([]);
          return;
        }

        if (totalEffectiveWithdrawn === 0n) {
          expect(typeof result).toBe('string');
          expect(String(result)).toContain('accrual pad absorbs planned withdrawals');
          return;
        }

        expect(Array.isArray(result)).toBe(true);
        const allocations = result as Array<{ id: Address; assets: bigint }>;
        expect(allocations).toHaveLength(effectiveDecreasing.length + increasing.length);

        for (let i = 0; i < effectiveDecreasing.length; i++) {
          const entry = effectiveDecreasing[i]!;
          const delta = entry.assets - entry.initialAssets;
          const target =
            entry.realInitialAssets + delta + accrualPad(entry.realInitialAssets, -delta);
          expect(allocations[i]).toEqual({ id: entry.id, assets: target });
          // Semantic invariant: the submitted target must remain ≤ realInitialAssets so Euler
          // takes the withdraw branch (target > real would supply, breaking the invariant).
          expect(allocations[i]!.assets).toBeLessThanOrEqual(entry.realInitialAssets);
        }

        if (increasing.length > 0) {
          expect(allocations[allocations.length - 1]).toEqual({
            id: increasing[increasing.length - 1]!.id,
            assets: maxUint256,
          });
        }

        const accounting = simulateEulerAccounting(allocations, all);
        expect(accounting.totalWithdrawn).toBe(totalEffectiveWithdrawn);
        expect(accounting.totalSupplied).toBe(totalEffectiveWithdrawn);

        for (const allocation of allocations.slice(effectiveDecreasing.length, -1)) {
          const entry = increasing.find((candidate) => candidate.id === allocation.id)!;
          const supplied = allocation.assets - entry.realInitialAssets;
          const requested = entry.assets - entry.initialAssets;
          expect(supplied).toBeGreaterThanOrEqual(0n);
          expect(supplied).toBeLessThanOrEqual(requested);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('buildFinalAllocations anchors padded decreasing targets to realInitialAssets when pool-capped', () => {
    fc.assert(
      fc.property(rebalanceScenarioArb, ({ arks, buffer, totalAssets }) => {
        // Simulate pool-capped ARKs: real Euler supply is several multiples of the planner's
        // capped initialAssets. The padded target on every decreasing entry must anchor to
        // realInitialAssets (not the planner's working assets), or Euler would attempt to
        // withdraw the entire illiquid portion at reallocate time.
        for (const ark of arks) {
          ark.realInitialAssets = ark.initialAssets * 3n;
        }
        buffer.realInitialAssets = buffer.initialAssets * 3n;

        _rebalanceBuffer(arks, buffer, totalAssets);

        const result = _buildFinalAllocations(arks, buffer);

        const all = [
          ...arks.map((ark) => ({
            id: ark.id,
            assets: ark.assets,
            initialAssets: ark.initialAssets,
            realInitialAssets: ark.realInitialAssets,
          })),
          {
            id: buffer.id,
            assets: buffer.assets,
            initialAssets: buffer.initialAssets,
            realInitialAssets: buffer.realInitialAssets,
          },
        ];
        const decreasing = all
          .filter((entry) => entry.assets < entry.initialAssets)
          .map((entry) => {
            const decrease = entry.initialAssets - entry.assets;
            return {
              ...entry,
              decrease,
              effectiveWithdrawn: effectiveWithdrawal(entry.realInitialAssets, decrease),
            };
          });
        const increasing = all.filter((entry) => entry.assets > entry.initialAssets);
        const effectiveDecreasing = decreasing.filter((entry) => entry.effectiveWithdrawn > 0n);
        const totalEffectiveWithdrawn = effectiveDecreasing.reduce(
          (sum, entry) => sum + entry.effectiveWithdrawn,
          0n,
        );

        if (decreasing.length === 0 && increasing.length === 0) {
          expect(result).toEqual([]);
          return;
        }

        if (totalEffectiveWithdrawn === 0n) {
          expect(typeof result).toBe('string');
          expect(String(result)).toContain('accrual pad absorbs planned withdrawals');
          return;
        }

        expect(Array.isArray(result)).toBe(true);
        const allocations = result as Array<{ id: Address; assets: bigint }>;
        for (let i = 0; i < effectiveDecreasing.length; i++) {
          const entry = effectiveDecreasing[i]!;
          const delta = entry.assets - entry.initialAssets;
          const expectedTarget =
            entry.realInitialAssets + delta + accrualPad(entry.realInitialAssets, -delta);
          expect(allocations[i]).toEqual({ id: entry.id, assets: expectedTarget });
          // Same invariant: the padded decreasing target must never exceed realInitialAssets,
          // even when realInitialAssets is much larger than the planner's capped initialAssets.
          expect(allocations[i]!.assets).toBeLessThanOrEqual(entry.realInitialAssets);
        }

        if (increasing.length > 0) {
          expect(allocations[allocations.length - 1]).toEqual({
            id: increasing[increasing.length - 1]!.id,
            assets: maxUint256,
          });
        }

        const accounting = simulateEulerAccounting(allocations, all);
        expect(accounting.totalWithdrawn).toBe(totalEffectiveWithdrawn);
        expect(accounting.totalSupplied).toBe(totalEffectiveWithdrawn);
      }),
      { numRuns: 200 },
    );
  });

  it('buildFinalAllocations rejects imbalanced plans', () => {
    fc.assert(
      fc.property(rebalanceScenarioArb, ({ arks, buffer, totalAssets }) => {
        _rebalanceBuffer(arks, buffer, totalAssets);
        buffer.assets += 1n;

        const result = _buildFinalAllocations(arks, buffer);
        expect(typeof result).toBe('string');
        expect(String(result)).toContain('inconsistent reallocation');
      }),
      { numRuns: 100 },
    );
  });
});
