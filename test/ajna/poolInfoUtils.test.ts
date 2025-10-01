import { describe, it, expect } from 'vitest';
import {
  getAuctionStatus,
  getHtp,
  getIndexToPrice,
  getLup,
  getPriceToIndex,
  getQtValue,
  lpToQuoteTokens,
} from '../../src/ajna/poolInfoUtils';
import { getLps, getPoolAddress } from '../../src/vault/vault';

describe('PoolInfoUtils interface', () => {
  it('can query priceToIndex', async () => {
    const priceToIndex = await getPriceToIndex(10n ** 18n);
    expect(priceToIndex).toBe(4156n);
  });

  it('can query indexToPrice', async () => {
    const lup = await getLup();
    const lupIndex = await getPriceToIndex(lup);
    const indexToPrice = await getIndexToPrice(lupIndex);
    expect(indexToPrice).toBe(lup);
  });

  it('can query htp', async () => {
    const htp = await getHtp();
    const value = Number(htp) / 1e18;
    const expectedValue = Number(976430666641620462n) / 1e18;
    expect(expectedValue).toBeCloseTo(value);
  });

  it('can query lup', async () => {
    const lup = await getLup();
    const value = Number(lup) / 1e18;
    const expectedValue = Number(995024875621890556n) / 1e18;
    expect(value).toBeCloseTo(expectedValue);
  });

  it('can query auction status', async () => {
    const auction = await getAuctionStatus('0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf');
    expect(auction.length).toBe(9);
  });

  it('can query lpToQuoteTokens', async () => {
    const poolAddress = await getPoolAddress();
    const lps = await getLps(4156n);
    const value = await lpToQuoteTokens(poolAddress, lps, 4156n);
    expect(value).toBe(0n);
  });

  it('can query qt value', async () => {
    const value = await getQtValue(4156n);
    expect(value).toBe(0n);
  });
});
