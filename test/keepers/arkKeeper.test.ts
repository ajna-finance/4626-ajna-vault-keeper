import { describe, it, expect, beforeAll } from 'vitest';
import {
  _calculateBufferTarget,
  _calculateOptimalBucket,
  initArkKeeper,
} from '../../src/keepers/arkKeeper';
import { getPrice } from '../../src/oracle/price';
import { createVault } from '../../src/ark/vault';
import { config, resolveArkSettings } from '../../src/utils/config';

const vault = createVault(config.arks[0]!.vaultAddress, config.arks[0]!.vaultAuthAddress);

describe('keeper calculations', () => {
  beforeAll(() => {
    initArkKeeper(
      config.arks[0]!.vaultAddress,
      config.arks[0]!.vaultAuthAddress,
      resolveArkSettings(config.arks[0]!),
    );
  });

  it('correctly calculates buffer target', async () => {
    const target = await _calculateBufferTarget();
    expect(50000000000000000000n - target).toBeLessThan(150000);
  });

  it('correctly calculates optimal bucket', async () => {
    const price = await getPrice();
    const currentBucket = await vault.getPriceToIndex(price);
    const newBucket = await _calculateOptimalBucket(price);
    const newBucketPrice = await vault.getIndexToPrice(newBucket);
    expect(newBucket).toBeGreaterThan(currentBucket);
    expect(newBucketPrice).toBeLessThan(price);
  });
});
