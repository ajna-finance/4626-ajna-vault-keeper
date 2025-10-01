import { describe, it, expect } from 'vitest';
import { getOffchainPrice } from '../../src/oracle/offchain.ts';

describe('offchain oracle', () => {
  it('getOffchainPrice works with provided token address', async () => {
    const currentPrice = await getOffchainPrice();
    expect(currentPrice).toBeCloseTo(1);
  });
});
