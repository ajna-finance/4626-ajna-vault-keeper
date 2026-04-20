import type { createVault } from './vault';

export type RecoverableBucket = {
  index: bigint;
  vaultLps: bigint;
  estimatedCollateralWad: bigint;
  estimatedQuoteValueWad?: bigint;
};

type Vault = ReturnType<typeof createVault>;

export async function detectRecoverable(
  vault: Vault,
  opts?: { includeQuoteEstimate?: boolean },
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

  return candidates.length > 0 ? candidates : null;
}
