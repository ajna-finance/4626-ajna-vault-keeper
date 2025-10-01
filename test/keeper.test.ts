import { describe, it, expect } from 'vitest';
import { _calculateBufferTarget, _calculateOptimalBucket } from '../src/keeper';
import { getPrice } from '../src/oracle/price';
import { getIndexToPrice, getPriceToIndex } from '../src/ajna/poolInfoUtils';

describe('keeper calculations', () => {
  it('correctly calculates buffer target', async () => {
    const target = await _calculateBufferTarget();
    expect(50000000000000000000n - target).toBeLessThan(150000);
  });

  it('correctly calculates optimal bucket', async () => {
    const price = await getPrice();
    const currentBucket = await getPriceToIndex(price);
    const newBucket = await _calculateOptimalBucket(price);
    const newBucketPrice = await getIndexToPrice(newBucket);
    expect(newBucket).toBeGreaterThan(currentBucket);
    expect(newBucketPrice).toBeLessThan(price);
  });
});
