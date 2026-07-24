import { describe, it, expect } from 'vitest';
import { getOffchainPrice } from '../../src/oracle/offchain.ts';

describe('offchain oracle', () => {
  it('returns quote-per-collateral as a WAD price', async () => {
    // config.test.json uses the same token for collateral and quote, so the ratio is exactly 1e18.
    const currentPrice = await getOffchainPrice();
    expect(currentPrice).toBe(10n ** 18n);
  });
});
