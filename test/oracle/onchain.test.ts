import { describe, it, expect } from 'vitest';
import { getOnchainPrice } from '../../src/oracle/onchain.ts';

describe('onchain oracle', () => {
  it('getOnchainPrice works with provided Chronicle address', async () => {
    const currentPrice = await getOnchainPrice();
    expect(currentPrice).toBe(1000000000000000000n);
  });
});
