import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { selectBuckets } from '../../../src/ark/utils/selectBuckets';
import { type createVault } from '../../../src/ark/vault';

type Vault = ReturnType<typeof createVault>;
type BucketFixture = {
  bucket: bigint;
  value: bigint;
  price: bigint;
  lps: bigint;
};

function makeVault(entries: BucketFixture[], dustThreshold: bigint): Vault {
  const byBucket = new Map(entries.map((entry) => [entry.bucket.toString(), entry]));

  return {
    getBuckets: vi.fn().mockResolvedValue(entries.map((entry) => entry.bucket)),
    lpToValue: vi
      .fn()
      .mockImplementation((bucket: bigint) =>
        Promise.resolve(byBucket.get(bucket.toString())?.value ?? 0n),
      ),
    getIndexToPrice: vi
      .fn()
      .mockImplementation((bucket: bigint) =>
        Promise.resolve(byBucket.get(bucket.toString())?.price ?? 0n),
      ),
    getVaultBucketLps: vi
      .fn()
      .mockImplementation((bucket: bigint) =>
        Promise.resolve(byBucket.get(bucket.toString())?.lps ?? 0n),
      ),
    getBucketQuoteDeposit: vi
      .fn()
      .mockImplementation((bucket: bigint) =>
        Promise.resolve(byBucket.get(bucket.toString())?.value ?? 0n),
      ),
    getAuctionDebtLockedIndex: vi.fn().mockResolvedValue(null),
    getDustThreshold: vi.fn().mockResolvedValue(dustThreshold),
  } as unknown as Vault;
}

const bucketEntriesArb = fc.uniqueArray(
  fc.record({
    bucket: fc.bigInt({ min: 1n, max: 10_000n }),
    value: fc.bigInt({ min: 0n, max: 500_000_000n }),
    price: fc.bigInt({ min: 1n, max: 1_000_000_000n }),
    lps: fc.bigInt({ min: 0n, max: 500_000_000n }),
  }),
  {
    minLength: 1,
    maxLength: 6,
    selector: (entry) => entry.bucket.toString(),
  },
);

describe('selectBuckets property tests', () => {
  it('always returns a valid withdrawal plan that respects coverage and dust rules', async () => {
    await fc.assert(
      fc.asyncProperty(
        bucketEntriesArb,
        fc.bigInt({ min: 1n, max: 500_000_000n }),
        fc.bigInt({ min: 1n, max: 5_000_000n }),
        async (entries, requestedAmount, dustThreshold) => {
          const vault = makeVault(entries, dustThreshold);
          const result = await selectBuckets(vault, requestedAmount);

          const nonEmpty = entries.filter((entry) => entry.value > 0n);
          const totalAvailable = nonEmpty.reduce((sum, entry) => sum + entry.value, 0n);
          const returned = new Set<string>();

          let selectedTotal = 0n;

          for (const move of result) {
            const entry = entries.find((candidate) => candidate.bucket === move.bucket);
            expect(entry).toBeDefined();
            expect(entry!.value).toBeGreaterThan(0n);
            expect(move.amount).toBeGreaterThan(0n);
            expect(move.amount).toBeLessThanOrEqual(entry!.value);
            expect(returned.has(move.bucket.toString())).toBe(false);

            returned.add(move.bucket.toString());
            selectedTotal += move.amount;

            if (move.amount < entry!.value && entry!.value > 0n) {
              // Mirrors the planner's ceiled LP-removal prediction, matching Ajna's
              // Math.Rounding.Up when redeeming LP for a removed quote amount.
              const lpsRemoved = (entry!.lps * move.amount + entry!.value - 1n) / entry!.value;
              const remainingLps = entry!.lps > lpsRemoved ? entry!.lps - lpsRemoved : 0n;
              expect(remainingLps === 0n || remainingLps >= dustThreshold).toBe(true);
            }
          }

          expect(selectedTotal).toBeLessThanOrEqual(totalAvailable);

          if (totalAvailable < requestedAmount) {
            expect(selectedTotal).toBe(totalAvailable);
          } else {
            expect(selectedTotal).toBeGreaterThanOrEqual(requestedAmount);
          }

          const sufficient = nonEmpty.filter((entry) => entry.value >= requestedAmount);

          if (sufficient.length > 0) {
            expect(result).toHaveLength(1);

            const chosen = sufficient.find((entry) => entry.bucket === result[0]!.bucket);
            expect(chosen).toBeDefined();
            expect(
              sufficient.every((entry) => chosen!.price <= entry.price),
              `chosen bucket ${result[0]!.bucket} is not the lowest-price sufficient bucket`,
            ).toBe(true);
          } else {
            for (let i = 1; i < result.length; i++) {
              const prev = entries.find((entry) => entry.bucket === result[i - 1]!.bucket)!;
              const next = entries.find((entry) => entry.bucket === result[i]!.bucket)!;
              expect(prev.value).toBeGreaterThanOrEqual(next.value);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
