import { describe, it, expect } from 'vitest';
import { detectRecoverable } from '../../src/ark/recovery';

type StubVault = {
  getBuckets: () => Promise<readonly bigint[]>;
  getVaultLps: (bucket: bigint) => Promise<bigint>;
  lpToCollateral: (bucket: bigint, lps: bigint) => Promise<bigint>;
  lpToQuoteTokens: (bucket: bigint, lps: bigint) => Promise<bigint>;
  getIndexToPrice?: (bucket: bigint) => Promise<bigint>;
};

function makeStub(
  buckets: bigint[],
  lpMap: Record<string, bigint>,
  collateralMap: Record<string, bigint>,
  quoteMap: Record<string, bigint> = {},
  priceMap?: Record<string, bigint>,
): any {
  const stub: StubVault = {
    getBuckets: async () => buckets,
    getVaultLps: async (b) => lpMap[String(b)] ?? 0n,
    lpToCollateral: async (b) => collateralMap[String(b)] ?? 0n,
    lpToQuoteTokens: async (b) => quoteMap[String(b)] ?? 0n,
  };
  if (priceMap) {
    stub.getIndexToPrice = async (b) => priceMap[String(b)] ?? 0n;
  }
  return stub;
}

const WAD = 10n ** 18n;

describe('detectRecoverable', () => {
  it('returns null when vault has no buckets', async () => {
    const vault = makeStub([], {}, {});
    expect(await detectRecoverable(vault)).toBeNull();
  });

  it('returns null when buckets exist but no vault LP', async () => {
    const vault = makeStub([100n, 200n], {}, {});
    expect(await detectRecoverable(vault)).toBeNull();
  });

  it('returns null when vault has LP but no collateral anywhere', async () => {
    const vault = makeStub([100n, 200n], { '100': 1000n, '200': 500n }, {});
    expect(await detectRecoverable(vault)).toBeNull();
  });

  it('includes only buckets where vault has LP AND collateral > 0', async () => {
    const vault = makeStub(
      [100n, 200n, 300n],
      { '100': 1000n, '200': 500n, '300': 750n },
      { '100': 50n, '200': 0n, '300': 25n },
    );
    const result = await detectRecoverable(vault);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result!.map((r) => r.index).sort()).toEqual([100n, 300n]);
    expect(result!.find((r) => r.index === 100n)!.estimatedCollateralWad).toBe(50n);
    expect(result!.find((r) => r.index === 300n)!.estimatedCollateralWad).toBe(25n);
  });

  it('excludes buckets with zero lpToCollateral (simulates bankruptcy or pure quote)', async () => {
    const vault = makeStub(
      [100n, 200n],
      { '100': 1000n, '200': 1000n },
      { '100': 100n, '200': 0n },
    );
    const result = await detectRecoverable(vault);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0]!.index).toBe(100n);
  });

  it('populates quote estimate when requested', async () => {
    const vault = makeStub(
      [100n],
      { '100': 1000n },
      { '100': 50n },
      { '100': 5000n },
    );
    const result = await detectRecoverable(vault, { includeQuoteEstimate: true });
    expect(result).not.toBeNull();
    expect(result![0]!.estimatedQuoteValueWad).toBe(5000n);
  });

  it('omits quote estimate when not requested', async () => {
    const vault = makeStub([100n], { '100': 1000n }, { '100': 50n }, { '100': 5000n });
    const result = await detectRecoverable(vault);
    expect(result).not.toBeNull();
    expect(result![0]!.estimatedQuoteValueWad).toBeUndefined();
  });

  it('preserves vault LP in candidate record', async () => {
    const vault = makeStub([100n], { '100': 12345n }, { '100': 50n });
    const result = await detectRecoverable(vault);
    expect(result![0]!.vaultLps).toBe(12345n);
  });
});

describe('detectRecoverable materiality floor (minValueWad)', () => {
  it('drops candidates whose quote value is below the floor, keeps the rest', async () => {
    // bucket 100: 1 wei collateral at price 2.0 → value 2 wei quote (griefing dust)
    // bucket 200: 1 collateral WAD at price 2.0 → value 2e18 quote
    const vault = makeStub(
      [100n, 200n],
      { '100': 1000n, '200': 1000n },
      { '100': 1n, '200': WAD },
      {},
      { '100': 2n * WAD, '200': 2n * WAD },
    );
    const result = await detectRecoverable(vault, { minValueWad: WAD });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0]!.index).toBe(200n);
  });

  it('returns null when every candidate is below the floor', async () => {
    const vault = makeStub(
      [100n],
      { '100': 1000n },
      { '100': 1n },
      {},
      { '100': 2n * WAD },
    );
    expect(await detectRecoverable(vault, { minValueWad: WAD })).toBeNull();
  });

  it('keeps a candidate whose value is exactly at the floor', async () => {
    // 0.5 WAD collateral at price 2.0 → value exactly 1 WAD
    const vault = makeStub(
      [100n],
      { '100': 1000n },
      { '100': WAD / 2n },
      {},
      { '100': 2n * WAD },
    );
    const result = await detectRecoverable(vault, { minValueWad: WAD });
    expect(result).not.toBeNull();
    expect(result![0]!.index).toBe(100n);
  });

  it('skips price lookups entirely when the floor is zero', async () => {
    // No priceMap: a getIndexToPrice call would throw TypeError. Floor 0 must
    // never consult prices — this is also the legacy-fixture compatibility path.
    const vault = makeStub([100n], { '100': 1000n }, { '100': 1n });
    const result = await detectRecoverable(vault, { minValueWad: 0n });
    expect(result).not.toBeNull();
    expect(result![0]!.index).toBe(100n);
  });
});
