import { describe, it, expect } from 'vitest';
import { createVault } from '../../src/ark/vault';
import { config } from '../../src/utils/config';
import { getGasWithBuffer } from '../../src/utils/transaction';

const vault = createVault(config.arks[0]!.vaultAddress, config.arks[0]!.vaultAuthAddress);

describe('Pool interface', () => {
  it('can query bucket info', async () => {
    const info = await vault.getBucketInfo(4156n);
    expect((info as any[]).length).toBe(5);
  });

  it('can query bankruptcy time', async () => {
    const timestamp = await vault.getBankruptcyTime(4156n);
    expect(timestamp).toBe(0n);
  });

  it('can query bucket lps', async () => {
    const lps = await vault.getBucketLps(4156n);
    expect(lps).toBe(0n);
  });

  it('can update interest', async () => {
    // testing that it doesn't revert
    const gas = await getGasWithBuffer('pool', 'updateInterest', [], await vault.getPoolAddress());
    await vault.updateInterest(gas);
  });

  it('can query totalT0DebtInAuction', async () => {
    const debt = await vault.getTotalT0DebtInAuction();
    expect(typeof debt).toBe('bigint');
  });

  it('can query inflatorInfo', async () => {
    const inflatorInfo = await vault.getInflatorInfo();
    expect((inflatorInfo as any[]).length).toBe(2);
    expect(typeof (inflatorInfo as any[])[0]).toBe('bigint');
    expect(typeof (inflatorInfo as any[])[1]).toBe('bigint');
  });

  it('can query depositIndex', async () => {
    const t0Debt = (await vault.getTotalT0DebtInAuction()) as bigint;
    const inflatorInfo = (await vault.getInflatorInfo()) as any[];
    const wad = 10n ** 18n;
    const debt = (t0Debt * inflatorInfo[0] + wad / 2n) / wad;
    const realisticIndex = await vault.getDepositIndex(debt);
    const arbitraryIndex = (await vault.getDepositIndex(100n * wad)) as bigint;

    expect(typeof realisticIndex).toBe('bigint');
    expect(arbitraryIndex).toBeGreaterThan(4000n);
  });
});
