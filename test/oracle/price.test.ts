import { describe, it, expect } from 'vitest';
import { getPrice } from '../../src/oracle/price.ts';

describe('getPrice', () => {
  it('returns price from either feed', async () => {
    const currentPrice = await getPrice();
    expect(currentPrice).toBe(1000000000000000000n);
  });
});
