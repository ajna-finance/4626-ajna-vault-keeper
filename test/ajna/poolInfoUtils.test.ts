import { describe, it, expect } from 'vitest';
import { createVault } from '../../src/ark/vault';
import { config } from '../../src/utils/config';

const vault = createVault(config.arks[0]!.vaultAddress, config.arks[0]!.vaultAuthAddress);

describe('PoolInfoUtils interface', () => {
  it('can query priceToIndex', async () => {
    const priceToIndex = await vault.getPriceToIndex(10n ** 18n);
    expect(priceToIndex).toBe(4156n);
  });

  it('can query indexToPrice', async () => {
    const lup = await vault.getLup();
    const lupIndex = await vault.getPriceToIndex(lup);
    const indexToPrice = await vault.getIndexToPrice(lupIndex);
    expect(indexToPrice).toBe(lup);
  });

  it('can query htp', async () => {
    const htp = await vault.getHtp();
    const value = Number(htp) / 1e18;
    const expectedValue = Number(976430666641620462n) / 1e18;
    expect(expectedValue).toBeCloseTo(value);
  });

  it('can query lup', async () => {
    const lup = await vault.getLup();
    const value = Number(lup) / 1e18;
    const expectedValue = Number(995024875621890556n) / 1e18;
    expect(value).toBeCloseTo(expectedValue);
  });

  it('can query auction status', async () => {
    const auction = await vault.getAuctionStatus('0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf');
    expect((auction as any[]).length).toBe(9);
  });

  it('can query borrow fee rate', async () => {
    const rate = await vault.getBorrowFeeRate();
    expect(rate).toBe(500000000000000n);
  });
});
