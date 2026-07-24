import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import {
  setAuctionBorrowers,
  setAuctionStatus,
  setBankruptcyTime,
  setLps,
  setMockState,
  useMocks,
} from '../helpers/vaultHelpers';
import { createVault } from '../../src/ark/vault';
import { arkRun } from '../../src/keepers/arkKeeper';
import { client } from '../../src/utils/client';
import { config, resolveArkSettings } from '../../src/utils/config';
import type { Address } from 'viem';

const testSettings = resolveArkSettings(config.arks[0]!);

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('keeper run failure', () => {
  let snapshot: string;
  let vault: ReturnType<typeof createVault>;

  beforeAll(async () => {
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
    useMocks();
    vault = createVault(
      process.env.MOCK_VAULT_ADDRESS as Address,
      process.env.MOCK_VAULT_AUTH_ADDRESS as Address,
    );
  });

  beforeEach(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
    await setMockState();
  });

  afterAll(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
  });

  it('skips run if optimal bucket is out of range', async () => {
    await arkRun(
      process.env.MOCK_VAULT_ADDRESS as Address,
      process.env.MOCK_VAULT_AUTH_ADDRESS as Address,
      { ...testSettings, optimalBucketDiff: 15n },
    );

    const buckets = await vault.getBuckets();
    for (let i = 0; i < buckets.length - 2; i++) {
      const balance = await vault.lpToValue(buckets[i]!);
      expect(balance).toBe(100000000000000000000n);
    }
  });

  it('skips run if optimal bucket is dusty', async () => {
    await setLps(100000n);
    await arkRun(
      process.env.MOCK_VAULT_ADDRESS as Address,
      process.env.MOCK_VAULT_AUTH_ADDRESS as Address,
      testSettings,
    );

    const buckets = await vault.getBuckets();
    for (let i = 0; i < buckets.length - 2; i++) {
      const balance = await vault.lpToValue(buckets[i]!);
      expect(balance).toBe(100000000000000000000n);
    }
  });

  it('skips run if pool has bad debt', async () => {
    const borrower = '0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf';
    const latestBlock = await client.getBlock({ blockTag: 'latest' });
    const kickTime = latestBlock.timestamp - 259201n;

    await setAuctionBorrowers([borrower]);
    await setAuctionStatus(borrower, kickTime, 0n, 1000000000n);
    await arkRun(
      process.env.MOCK_VAULT_ADDRESS as Address,
      process.env.MOCK_VAULT_AUTH_ADDRESS as Address,
      testSettings,
    );

    const buckets = await vault.getBuckets();
    for (let i = 0; i < buckets.length - 2; i++) {
      const balance = await vault.lpToValue(buckets[i]!);
      expect(balance).toBe(100000000000000000000n);
    }
  });

  it('skips run if optimal bucket has recently been bankrupt', async () => {
    const latestBlock = await client.getBlock({ blockTag: 'latest' });
    const bankruptcyTime = latestBlock.timestamp - 86400n;
    await setBankruptcyTime(bankruptcyTime);

    await arkRun(
      process.env.MOCK_VAULT_ADDRESS as Address,
      process.env.MOCK_VAULT_AUTH_ADDRESS as Address,
      testSettings,
    );

    const buckets = await vault.getBuckets();
    for (let i = 0; i < buckets.length - 2; i++) {
      const balance = await vault.lpToValue(buckets[i]!);
      expect(balance).toBe(100000000000000000000n);
    }
  });
});
