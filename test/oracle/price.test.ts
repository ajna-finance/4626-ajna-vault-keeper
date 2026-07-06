import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPrice } from '../../src/oracle/price.ts';
import { config } from '../../src/utils/config.ts';

describe('getPrice', () => {
  beforeAll(() => {
    config.oracle.fixedPrice = null;
  });

  it('returns price from either feed', async () => {
    const currentPrice = await getPrice();
    expect(currentPrice).toBe(999870478245824934n);
  });
});

describe('get fixed price', () => {
  beforeAll(() => {
    config.oracle.fixedPrice = '1.00';
  });

  afterAll(() => {
    config.oracle.fixedPrice = null;
  });

  it('returns properly converted fixed price', async () => {
    const currentPrice = await getPrice();
    expect(currentPrice).toBe(1000000000000000000n);
  });

  it('keeps fixed-price validation limited to positive decimal parsing', async () => {
    config.oracle.fixedPrice = '0.000000001';
    const currentPrice = await getPrice();
    expect(currentPrice).toBe(1000000000n);
  });
});
