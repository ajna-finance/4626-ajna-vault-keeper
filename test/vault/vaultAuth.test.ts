import { describe, it, expect } from 'vitest';
import { getBufferRatio, getMinBucketIndex } from '../../src/vault/vaultAuth.ts';
import { setBufferRatio, setMinBucketIndex } from '../helpers/vaultHelpers.ts';

describe('vault auth interface', () => {
  it('can query buffer ratio', async () => {
    await setBufferRatio(5000n);
    const ratio = await getBufferRatio();
    expect(ratio).toBe(5000n);
  });

  it('can query min bucket index', async () => {
    await setMinBucketIndex(4155n);
    const index = await getMinBucketIndex();
    expect(index).toBe(4155n);
  });
});
