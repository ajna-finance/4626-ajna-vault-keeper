import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { setBufferRatio, setMockState, useMocks } from '../helpers/vaultHelpers';
import { getPrice } from '../../src/oracle/price';
import { createVault } from '../../src/ark/vault';
import { arkRun } from '../../src/keepers/arkKeeper';
import { client } from '../../src/utils/client';
import { config, resolveArkSettings } from '../../src/utils/config';
import type { Address } from 'viem';

const testSettings = resolveArkSettings(config.arks[0]!);

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('keeper run success', () => {
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

  it('moves funds from the correct buckets to the optimal bucket and skips in-range buckets', async () => {
    const expectedMovedBuckets = [
      4166n,
      4165n,
      4164n,
      4163n,
      4162n,
      4161n,
      4155n,
      4154n,
      4153n,
      4152n,
      4151n,
      4150n,
    ];
    const expectedUnmovedBuckets = [4160n, 4159n, 4158n, 4156n];
    const currentPrice = await getPrice();

    // Hard-coded minimum earning threshold (lower than lup in current scenario)
    const htp = 976471570782600768n;

    // Twelve buckets expected for move, each with starting balance of 100000000000000000000n
    const expectedMoveAmount = 12n * 100000000000000000000n;

    const optimalBucketBalanceBefore = await vault.lpToValue(4157n);
    const dustyBucketBefore = await vault.lpToValue(4149n);

    await arkRun(
      process.env.MOCK_VAULT_ADDRESS as Address,
      process.env.MOCK_VAULT_AUTH_ADDRESS as Address,
      testSettings,
    );

    const optimalBucketBalanceAfter = await vault.lpToValue(4157n);
    const dustyBucketAfter = await vault.lpToValue(4149n);

    for (let i = 0; i < expectedMovedBuckets.length; i++) {
      const bucketPrice = await vault.getIndexToPrice(expectedMovedBuckets[i]!);
      const bucketPriceExpectation = bucketPrice < htp || bucketPrice > currentPrice;
      const balance = await vault.lpToValue(expectedMovedBuckets[i]!);

      expect(bucketPriceExpectation).toBe(true);
      expect(balance).toBe(0n);
    }

    for (let i = 0; i < expectedUnmovedBuckets.length; i++) {
      const bucketPrice = await vault.getIndexToPrice(expectedUnmovedBuckets[i]!);
      const balance = await vault.lpToValue(expectedUnmovedBuckets[i]!);

      expect(bucketPrice).toBeGreaterThan(htp);
      expect(bucketPrice).toBeLessThanOrEqual(currentPrice);
      expect(balance).toBe(100000000000000000000n);
    }

    expect(optimalBucketBalanceAfter - optimalBucketBalanceBefore).toBe(expectedMoveAmount);

    // Assert that minimum move balance is respected
    expect(dustyBucketBefore).toBeLessThan(testSettings.minMoveAmount);
    expect(dustyBucketBefore).toBe(dustyBucketAfter);
  });

  it('refills buffer before optimal bucket when necessary', async () => {
    await setBufferRatio(5000n);
    const bufferTotalBefore = await vault.getBufferTotal();
    const optimalBucketBalanceBefore = await vault.lpToValue(4157n);

    await arkRun(
      process.env.MOCK_VAULT_ADDRESS as Address,
      process.env.MOCK_VAULT_AUTH_ADDRESS as Address,
      testSettings,
    );

    const bufferTotalAfter = await vault.getBufferTotal();
    const optimalBucketBalanceAfter = await vault.lpToValue(4157n);

    expect(bufferTotalBefore).toBe(0n);
    expect(Number(bufferTotalAfter) / 1e18).toBeCloseTo(849e18 / 1e18, -1);
    expect(Number(optimalBucketBalanceAfter - optimalBucketBalanceBefore) / 1e18).toBeCloseTo(
      350e18 / 1e18,
      -1,
    );
  });
});
