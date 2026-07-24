import { describe, it, expect } from 'vitest';
import { createVault } from '../../src/ark/vault';
import { config } from '../../src/utils/config';

const vault = createVault(config.arks[0]!.vaultAddress, config.arks[0]!.vaultAuthAddress);

describe('buffer interface', () => {
  it('can query buffer total', async () => {
    const total = await vault.getBufferTotal();
    expect(total).not.toBe(0n);
  });
});
