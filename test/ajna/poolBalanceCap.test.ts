import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const POOL = '0x00000000000000000000000000000000000000c3' as Address;
const QUOTE = '0x00000000000000000000000000000000000000d4' as Address;

function buildVault(escrowedQuoteWad = 0n) {
  return {
    getPoolAddress: vi.fn().mockResolvedValue(POOL),
    getAssetDecimals: vi.fn().mockResolvedValue(6),
    getPoolEscrowedQuote: vi.fn().mockResolvedValue(escrowedQuoteWad),
  };
}

async function importWithIntegrationTest(
  env: string | undefined,
  readContract: ReturnType<typeof vi.fn>,
) {
  vi.doMock('../../src/utils/config.ts', () => ({
    config: { quoteTokenAddress: QUOTE },
  }));
  vi.doMock('../../src/utils/client.ts', () => ({ client: { readContract } }));

  if (env === undefined) {
    delete process.env.INTEGRATION_TEST;
  } else {
    process.env.INTEGRATION_TEST = env;
  }

  return import('../../src/ajna/utils/poolBalanceCap.ts');
}

const previousIntegrationTest = process.env.INTEGRATION_TEST;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/utils/client.ts');
  if (previousIntegrationTest === undefined) {
    delete process.env.INTEGRATION_TEST;
  } else {
    process.env.INTEGRATION_TEST = previousIntegrationTest;
  }
});

describe('poolBalanceCap integration test gate', () => {
  // Regression (PR19-H10): the gate previously tested INTEGRATION_TEST by string truthiness,
  // so any non-empty value, including "false", silently disabled the pool balance cap.
  it('applies the cap when INTEGRATION_TEST is set to false', async () => {
    const readContract = vi.fn().mockResolvedValue(100n * 10n ** 6n);
    const { poolBalanceCapAsset, poolBalanceCapWad } = await importWithIntegrationTest(
      'false',
      readContract,
    );

    await expect(poolBalanceCapAsset(500n * 10n ** 6n, buildVault())).resolves.toBe(
      100n * 10n ** 6n,
    );
    await expect(poolBalanceCapWad(500n * 10n ** 18n, buildVault())).resolves.toBe(
      100n * 10n ** 18n,
    );
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: QUOTE, functionName: 'balanceOf', args: [POOL] }),
    );
  });

  it('bypasses the cap without reading the pool only when INTEGRATION_TEST is exactly true', async () => {
    const readContract = vi.fn();
    const { poolBalanceCapAsset, poolBalanceCapWad } = await importWithIntegrationTest(
      'true',
      readContract,
    );

    await expect(poolBalanceCapAsset(500n * 10n ** 6n, buildVault())).resolves.toBe(
      500n * 10n ** 6n,
    );
    await expect(poolBalanceCapWad(500n * 10n ** 18n, buildVault())).resolves.toBe(
      500n * 10n ** 18n,
    );
    expect(readContract).not.toHaveBeenCalled();
  });

  it('applies the cap when INTEGRATION_TEST is unset', async () => {
    const readContract = vi.fn().mockResolvedValue(100n * 10n ** 6n);
    const { poolBalanceCapAsset } = await importWithIntegrationTest(undefined, readContract);

    await expect(poolBalanceCapAsset(500n * 10n ** 6n, buildVault())).resolves.toBe(
      100n * 10n ** 6n,
    );
  });
});

describe('poolBalanceCap escrowed quote subtraction', () => {
  // Regression (PR19-D07): the raw pool token balance includes auction bond escrow and
  // unclaimed reserves that Ajna subtracts from the quote available for removal, so the cap
  // must subtract the escrowed amounts before comparing.
  it('subtracts bond escrow and unclaimed reserves from the available balance', async () => {
    const readContract = vi.fn().mockResolvedValue(100n * 10n ** 6n);
    const { poolBalanceCapAsset, poolBalanceCapWad } = await importWithIntegrationTest(
      undefined,
      readContract,
    );
    const escrowed = 30n * 10n ** 18n;

    await expect(poolBalanceCapAsset(500n * 10n ** 6n, buildVault(escrowed))).resolves.toBe(
      70n * 10n ** 6n,
    );
    await expect(poolBalanceCapWad(500n * 10n ** 18n, buildVault(escrowed))).resolves.toBe(
      70n * 10n ** 18n,
    );
  });

  it('floors the available balance at zero when escrow exceeds the pool balance', async () => {
    const readContract = vi.fn().mockResolvedValue(10n * 10n ** 6n);
    const { poolBalanceCapWad } = await importWithIntegrationTest(undefined, readContract);

    await expect(poolBalanceCapWad(500n * 10n ** 18n, buildVault(30n * 10n ** 18n))).resolves.toBe(
      0n,
    );
  });
});
