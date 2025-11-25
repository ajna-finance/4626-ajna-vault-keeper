import { describe, it, expect } from 'vitest';
import {
  getBankruptcyTime,
  getBucketInfo,
  getBucketLps,
  getDepositIndex,
  getInflatorInfo,
  getTotalT0DebtInAuction,
  updateInterest,
} from '../../src/ajna/pool';

describe('Pool interface', () => {
  it('can query bucket info', async () => {
    const info = await getBucketInfo(4156n);
    expect(info.length).toBe(5);
  });

  it('can query bankruptcy time', async () => {
    const timestamp = await getBankruptcyTime(4156n);
    expect(timestamp).toBe(0n);
  });

  it('can query bucket lps', async () => {
    const lps = await getBucketLps(4156n);
    expect(lps).toBe(0n);
  });

  it('can update interest', async () => {
    // testing that it doesn't revert
    await updateInterest();
  });

  it('can query totalT0DebtInAuction', async () => {
    const debt = await getTotalT0DebtInAuction();
    expect(typeof debt).toBe('bigint');
  });

  it('can query inflatorInfo', async () => {
    const inflatorInfo = await getInflatorInfo();
    expect(inflatorInfo.length).toBe(2);
    expect(typeof inflatorInfo[0]).toBe('bigint');
    expect(typeof inflatorInfo[1]).toBe('bigint');
  });

  it('can query depositIndex', async () => {
    const t0Debt = (await getTotalT0DebtInAuction()) as bigint;
    const inflatorInfo = await getInflatorInfo();
    const wad = 10n ** 18n;
    const debt = (t0Debt * inflatorInfo[0] + wad / 2n) / wad;
    const realisticIndex = await getDepositIndex(debt);
    const arbitraryIndex = await getDepositIndex(100n * wad);

    expect(typeof realisticIndex).toBe('bigint');
    expect(arbitraryIndex).toBeGreaterThan(4000n);
  });
});
