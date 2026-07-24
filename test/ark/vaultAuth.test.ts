import { describe, it, expect } from 'vitest';
import { createVault } from '../../src/ark/vault';
import { config } from '../../src/utils/config';
import { setBufferRatio, setMinBucketIndex } from '../helpers/vaultHelpers';

const vault = createVault(config.arks[0]!.vaultAddress, config.arks[0]!.vaultAuthAddress);

describe('vault auth interface', () => {
  it('can query buffer ratio', async () => {
    await setBufferRatio(5000n);
    const ratio = await vault.getBufferRatio();
    expect(ratio).toBe(5000n);
  });

  it('can query min bucket index', async () => {
    await setMinBucketIndex(4155n);
    const index = await vault.getMinBucketIndex();
    expect(index).toBe(4155n);
  });
});
