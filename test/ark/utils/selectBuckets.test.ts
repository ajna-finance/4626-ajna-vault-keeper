import { describe, it, expect, vi } from 'vitest';
import { _wouldLeaveDust, selectBuckets } from '../../../src/ark/utils/selectBuckets';
import { type createVault } from '../../../src/ark/vault';

type Vault = ReturnType<typeof createVault>;

function makeVault(
  buckets: bigint[],
  values: Record<string, bigint>,
  prices: Record<string, bigint>,
  lps?: Record<string, bigint>,
  dustThreshold: bigint = 1_000_001n,
  opts: { quoteDeposits?: Record<string, bigint>; lockedIndex?: bigint } = {},
): Vault {
  return {
    getBuckets: vi.fn().mockResolvedValue(buckets),
    lpToValue: vi
      .fn()
      .mockImplementation((bucket: bigint) => Promise.resolve(values[bucket.toString()] ?? 0n)),
    getIndexToPrice: vi
      .fn()
      .mockImplementation((index: bigint) => Promise.resolve(prices[index.toString()] ?? 0n)),
    getVaultBucketLps: vi
      .fn()
      .mockImplementation((bucket: bigint) =>
        Promise.resolve(lps ? (lps[bucket.toString()] ?? 0n) : (values[bucket.toString()] ?? 0n)),
      ),
    getBucketQuoteDeposit: vi
      .fn()
      .mockImplementation((bucket: bigint) =>
        Promise.resolve(
          opts.quoteDeposits
            ? (opts.quoteDeposits[bucket.toString()] ?? 0n)
            : (values[bucket.toString()] ?? 0n),
        ),
      ),
    getAuctionDebtLockedIndex: vi.fn().mockResolvedValue(opts.lockedIndex ?? null),
    getDustThreshold: vi.fn().mockResolvedValue(dustThreshold),
  } as unknown as Vault;
}

// Scale factor so bucket values are well above the dust threshold (1_000_001)
const S = 1_000_000n;

describe('selectBuckets', () => {
  it('returns single bucket when exactly one has enough funds', async () => {
    const vault = makeVault(
      [100n, 200n, 300n],
      { '100': 50n * S, '200': 500n * S, '300': 10n * S },
      { '100': 1000n, '200': 900n, '300': 800n },
    );

    const result = await selectBuckets(vault, 200n * S);
    expect(result).toEqual([{ bucket: 200n, amount: 200n * S }]);
  });

  it('returns lowest-price bucket when multiple have enough funds', async () => {
    const vault = makeVault(
      [100n, 200n, 300n],
      { '100': 500n * S, '200': 500n * S, '300': 500n * S },
      { '100': 1000n, '200': 800n, '300': 900n },
    );

    const result = await selectBuckets(vault, 200n * S);
    expect(result).toEqual([{ bucket: 200n, amount: 200n * S }]);
  });

  it('returns multiple buckets ordered by value desc when none have enough', async () => {
    const vault = makeVault(
      [100n, 200n, 300n],
      { '100': 30n * S, '200': 80n * S, '300': 50n * S },
      { '100': 1000n, '200': 900n, '300': 800n },
    );

    const result = await selectBuckets(vault, 120n * S);
    expect(result).toEqual([
      { bucket: 200n, amount: 80n * S },
      { bucket: 300n, amount: 40n * S },
    ]);
  });

  it('uses all buckets when total value just barely covers amount', async () => {
    const vault = makeVault(
      [100n, 200n],
      { '100': 40n * S, '200': 60n * S },
      { '100': 1000n, '200': 900n },
    );

    const result = await selectBuckets(vault, 100n * S);
    expect(result).toEqual([
      { bucket: 200n, amount: 60n * S },
      { bucket: 100n, amount: 40n * S },
    ]);
  });

  it('returns empty array when all buckets have zero value', async () => {
    const vault = makeVault([100n, 200n], { '100': 0n, '200': 0n }, { '100': 1000n, '200': 900n });

    const result = await selectBuckets(vault, 100n * S);
    expect(result).toEqual([]);
  });

  it('returns empty array when no buckets exist', async () => {
    const vault = makeVault([], {}, {});
    const result = await selectBuckets(vault, 100n * S);
    expect(result).toEqual([]);
  });

  it('skips zero-value buckets in multi-bucket scenario', async () => {
    const vault = makeVault(
      [100n, 200n, 300n],
      { '100': 0n, '200': 40n * S, '300': 30n * S },
      { '100': 1000n, '200': 900n, '300': 800n },
    );

    const result = await selectBuckets(vault, 60n * S);
    expect(result).toEqual([
      { bucket: 200n, amount: 40n * S },
      { bucket: 300n, amount: 20n * S },
    ]);
  });

  it('picks the single sufficient bucket regardless of price when only one qualifies', async () => {
    const vault = makeVault(
      [100n, 200n, 300n],
      { '100': 10n * S, '200': 10n * S, '300': 500n * S },
      { '100': 100n, '200': 200n, '300': 9999n },
    );

    const result = await selectBuckets(vault, 100n * S);
    expect(result).toEqual([{ bucket: 300n, amount: 100n * S }]);
  });

  it('handles single bucket vault', async () => {
    const vault = makeVault([100n], { '100': 500n * S }, { '100': 1000n });

    const result = await selectBuckets(vault, 200n * S);
    expect(result).toEqual([{ bucket: 100n, amount: 200n * S }]);
  });

  // Regression (PR19-D07): the Vault's lpToValue prices quote plus collateral, but moveToBuffer
  // can only remove quote. A bucket holding collateral must be planned at its quote deposit,
  // not its full claim value.
  it('caps each bucket at its quote deposit when the claim value includes collateral', async () => {
    const vault = makeVault(
      [100n, 200n],
      { '100': 500n * S, '200': 300n * S },
      { '100': 1000n, '200': 900n },
      undefined,
      1_000_001n,
      { quoteDeposits: { '100': 50n * S, '200': 300n * S } },
    );

    const result = await selectBuckets(vault, 200n * S);
    expect(result).toEqual([{ bucket: 200n, amount: 200n * S }]);
  });

  // Regression (PR19-D07): Ajna reverts RemoveDepositLockedByAuctionDebt for buckets at or
  // below the auction-debt boundary index, so those buckets must not be selected as sources
  // while an unlocked alternative can serve the withdrawal.
  it('skips buckets locked by auction debt', async () => {
    const vault = makeVault(
      [100n, 200n],
      { '100': 500n * S, '200': 300n * S },
      { '100': 1000n, '200': 900n },
      undefined,
      1_000_001n,
      { lockedIndex: 100n },
    );

    const result = await selectBuckets(vault, 200n * S);
    expect(result).toEqual([{ bucket: 200n, amount: 200n * S }]);
  });

  it('treats a lock boundary at index zero as locking only bucket zero', async () => {
    const vault = makeVault(
      [0n, 200n],
      { '0': 500n * S, '200': 300n * S },
      { '0': 1000n, '200': 900n },
      undefined,
      1_000_001n,
      { lockedIndex: 0n },
    );

    const result = await selectBuckets(vault, 200n * S);
    expect(result).toEqual([{ bucket: 200n, amount: 200n * S }]);
  });

  describe('dust prevention', () => {
    const DUST = 1_000_001n;

    it('takes full bucket when partial withdrawal would leave dusty LPs (single sufficient)', async () => {
      // Bucket has 200*S value and 200*S LPs (1:1 ratio).
      // We want 199*S. Remaining LPs ≈ 200*S - 199*S = 1*S = 1_000_000 < DUST.
      const vault = makeVault([100n], { '100': 200n * S }, { '100': 1000n }, { '100': 200n * S });

      const result = await selectBuckets(vault, 199n * S);
      expect(result).toEqual([{ bucket: 100n, amount: 200n * S }]);
    });

    it('takes full bucket when partial withdrawal would leave dusty LPs (multiple sufficient)', async () => {
      const vault = makeVault(
        [100n, 200n],
        { '100': 200n * S, '200': 300n * S },
        { '100': 800n, '200': 900n },
        { '100': 200n * S, '200': 300n * S },
      );

      // Lowest price is bucket 100. We want 199*S from a 200*S bucket.
      // Remaining LPs = 200*S - (200*S * 199*S / 200*S) = 1*S = 1_000_000 < DUST. Take full.
      const result = await selectBuckets(vault, 199n * S);
      expect(result).toEqual([{ bucket: 100n, amount: 200n * S }]);
    });

    it('takes full bucket when partial withdrawal would leave dusty LPs (multi-bucket fallback)', async () => {
      // No single bucket has enough. We need 120*S.
      // Sorted by value desc: 200(80*S), 300(41*S), 100(30*S).
      // 200: 80*S < 120*S, take all 80*S. Remaining = 40*S.
      // 300: value 41*S >= 40*S. LPs = 41*S. Remaining LPs = 41*S - (41*S * 40*S / 41*S) = 1*S < DUST.
      const vault = makeVault(
        [100n, 200n, 300n],
        { '100': 30n * S, '200': 80n * S, '300': 41n * S },
        { '100': 1000n, '200': 900n, '300': 800n },
        { '100': 30n * S, '200': 80n * S, '300': 41n * S },
      );

      const result = await selectBuckets(vault, 120n * S);
      expect(result).toEqual([
        { bucket: 200n, amount: 80n * S },
        { bucket: 300n, amount: 41n * S },
      ]);
    });

    it('takes the full final fallback bucket when a partial move would leave dust', async () => {
      // No single bucket can satisfy 100*S on its own.
      // Greedy fallback takes bucket 100 first (70*S), leaving 30*S.
      // Taking only 30*S from bucket 200 would leave 909_091 LPs behind, so the full 55*S
      // bucket should be selected instead of a partial final withdrawal.
      const vault = makeVault(
        [100n, 200n, 300n],
        { '100': 70n * S, '200': 55n * S, '300': 20n * S },
        { '100': 1000n, '200': 900n, '300': 800n },
        { '100': 70n * S, '200': 2n * S, '300': 20n * S },
      );

      const result = await selectBuckets(vault, 100n * S);
      expect(result).toEqual([
        { bucket: 100n, amount: 70n * S },
        { bucket: 200n, amount: 55n * S },
      ]);
    });

    it('does not adjust when remaining LPs are at dust threshold', async () => {
      // Bucket has value and LPs such that remaining LPs = exactly DUST.
      // value = (DUST + 199*S), lps = (DUST + 199*S). We want 199*S.
      // Remaining LPs = (DUST + 199*S) - ((DUST + 199*S) * 199*S / (DUST + 199*S)) = DUST.
      // DUST is not < DUST, so no adjustment.
      const bucketTotal = DUST + 199n * S;
      const vault = makeVault(
        [100n],
        { '100': bucketTotal },
        { '100': 1000n },
        { '100': bucketTotal },
      );

      const result = await selectBuckets(vault, 199n * S);
      expect(result).toEqual([{ bucket: 100n, amount: 199n * S }]);
    });

    it('does not adjust when remaining LPs are well above dust threshold', async () => {
      const vault = makeVault([100n], { '100': 500n * S }, { '100': 1000n }, { '100': 500n * S });

      const result = await selectBuckets(vault, 200n * S);
      expect(result).toEqual([{ bucket: 100n, amount: 200n * S }]);
    });

    it('handles non-1:1 LP-to-value ratio correctly', async () => {
      // Bucket has 100*S value but 2*S LPs (each LP worth 50 value units).
      // We want 99*S value. LPs removed = 2*S * 99*S / 100*S = 1_980_000.
      // Remaining LPs = 2*S - 1_980_000 = 2_000_000 - 1_980_000 = 20_000 < DUST. Take full.
      const vault = makeVault([100n], { '100': 100n * S }, { '100': 1000n }, { '100': 2n * S });

      const result = await selectBuckets(vault, 99n * S);
      expect(result).toEqual([{ bucket: 100n, amount: 100n * S }]);
    });
  });
});

describe('_wouldLeaveDust', () => {
  it('returns false when the requested amount is equal to or greater than the bucket value', () => {
    expect(_wouldLeaveDust(100n, 100n, 100n, 10n)).toBe(false);
    expect(_wouldLeaveDust(101n, 100n, 100n, 10n)).toBe(false);
  });

  it('returns true when a partial withdrawal would leave LPs below the dust threshold', () => {
    expect(_wouldLeaveDust(99n, 100n, 100n, 2n)).toBe(true);
  });

  // Regression (PR19-D05): Ajna redeems LP for a removed quote amount with Math.Rounding.Up,
  // so a floored prediction can overestimate the LP remainder by one unit and let a move
  // through that reverts DustyBucket onchain. The prediction must ceil the LP removal.
  it('ceils the LP removal so a one-unit boundary remainder counts as dust', () => {
    // floor: 1001*900/1000 = 900 leaves 101 (not dust at threshold 101)
    // ceil: 901 leaves 100 (dust at threshold 101)
    expect(_wouldLeaveDust(900n, 1000n, 1001n, 101n)).toBe(true);
  });

  it('treats a ceiled removal of the full LP balance as leaving no dust', () => {
    expect(_wouldLeaveDust(1n, 2n, 1n, 10n)).toBe(false);
  });
});
