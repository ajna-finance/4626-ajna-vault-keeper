import { describe, it, expect } from 'vitest';
import { _getUnsettledAuctions, isPastAuctionAge } from '../../src/subgraph/poolHealth';
import { createVault } from '../../src/ark/vault';
import { config } from '../../src/utils/config';

describe('subgraph query', () => {
  it('can query subgraph for unsettled auctions', async () => {
    const result = await _getUnsettledAuctions(
      createVault(config.arks[0]!.vaultAddress, config.arks[0]!.vaultAuthAddress),
    );

    expect(result).toHaveProperty('liquidationAuctions');
  });

  it('treats auctions older than the default maxAuctionAge as past the cutoff and fresh ones as within it', () => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const oldKickTime = 1725922914n;

    expect(isPastAuctionAge(oldKickTime, nowSec)).toBe(true);
    expect(isPastAuctionAge(nowSec, nowSec)).toBe(false);
  });
});
