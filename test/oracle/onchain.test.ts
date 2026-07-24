import { describe, it, expect } from 'vitest';
import { getOnchainPrice } from '../../src/oracle/onchain.ts';

describe('onchain oracle', () => {
  it('returns quote-per-collateral as a WAD price', async () => {
    // config.test.json points both Chronicle feeds at the same address, so the ratio is exactly 1e18.
    const currentPrice = await getOnchainPrice();
    expect(currentPrice).toBe(10n ** 18n);
  });
});
