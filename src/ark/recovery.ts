import type { createVault } from './vault';

export type RecoverableBucket = {
  index: bigint;
  vaultLps: bigint;
  estimatedCollateralWad: bigint;
  estimatedQuoteValueWad?: bigint;
};

type Vault = ReturnType<typeof createVault>;

const WAD = 10n ** 18n;

export async function detectRecoverable(
  vault: Vault,
  opts?: { includeQuoteEstimate?: boolean; minValueWad?: bigint | undefined },
): Promise<RecoverableBucket[] | null> {
  const buckets = (await vault.getBuckets()) as readonly bigint[];
  if (buckets.length === 0) return null;

  const lpResults = await Promise.all(buckets.map((b) => vault.getVaultLps(b)));

  const bucketsWithLp: { index: bigint; lps: bigint }[] = [];
  for (let i = 0; i < buckets.length; i++) {
    if (lpResults[i]! > 0n) bucketsWithLp.push({ index: buckets[i]!, lps: lpResults[i]! });
  }
  if (bucketsWithLp.length === 0) return null;

  const collateralResults = await Promise.all(
    bucketsWithLp.map(({ index, lps }) => vault.lpToCollateral(index, lps)),
  );

  const quoteEstimates = opts?.includeQuoteEstimate
    ? await Promise.all(
        bucketsWithLp.map(({ index, lps }) => vault.lpToQuoteTokens(index, lps)),
      )
    : undefined;

  const candidates: RecoverableBucket[] = [];
  for (let i = 0; i < bucketsWithLp.length; i++) {
    const col = collateralResults[i]!;
    if (col > 0n) {
      const entry: RecoverableBucket = {
        index: bucketsWithLp[i]!.index,
        vaultLps: bucketsWithLp[i]!.lps,
        estimatedCollateralWad: col,
      };
      if (quoteEstimates) entry.estimatedQuoteValueWad = quoteEstimates[i]!;
      candidates.push(entry);
    }
  }
  if (candidates.length === 0) return null;

  // Materiality floor: anyone can permissionlessly addCollateral 1 wei into a bucket
  // where the vault holds LP, which would otherwise halt arkKeeper every tick and walk
  // recovery-auto into a paused-vault dead end (sub-dust collateral recovers, the swap
  // is skipped, and rcv>0 strands the vault). Value candidates at their bucket price
  // (the same price recoverCollateral itself uses for rcv) and ignore ones below the
  // configured quote-WAD floor.
  const minValueWad = opts?.minValueWad ?? 0n;
  if (minValueWad === 0n) return candidates;

  const prices = await Promise.all(candidates.map((c) => vault.getIndexToPrice(c.index)));
  const material = candidates.filter((c, i) => {
    const valueWad = (c.estimatedCollateralWad * (prices[i]! as bigint)) / WAD;
    return valueWad >= minValueWad;
  });

  return material.length > 0 ? material : null;
}
