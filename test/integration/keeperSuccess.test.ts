import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { addToBuffer, setBufferRatio, setMockState, useMocks } from '../helpers/vaultHelpers';
import { getPrice } from '../../src/oracle/price';
import { getIndexToPrice } from '../../src/ajna/poolInfoUtils';
import { _calculateBufferTarget, run } from '../../src/keeper';
import { getBufferTotal } from '../../src/vault/buffer';
import { client } from '../../src/utils/client';
import { lpToValue } from '../../src/vault/vault';

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('keeper run success', () => {
  let snapshot: string;

  beforeAll(async () => {
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
    useMocks();
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

    const optimalBucketBalanceBefore = await lpToValue(4157n);
    const dustyBucketBefore = await lpToValue(4149n);

    await run();

    const optimalBucketBalanceAfter = await lpToValue(4157n);
    const dustyBucketAfter = await lpToValue(4149n);

    for (let i = 0; i < expectedMovedBuckets.length; i++) {
      const bucketPrice = await getIndexToPrice(expectedMovedBuckets[i]!);
      const bucketPriceExpectation = bucketPrice < htp || bucketPrice > currentPrice;
      const balance = await lpToValue(expectedMovedBuckets[i]!);

      expect(bucketPriceExpectation).toBe(true);
      expect(balance).toBe(0n);
    }

    for (let i = 0; i < expectedUnmovedBuckets.length; i++) {
      const bucketPrice = await getIndexToPrice(expectedUnmovedBuckets[i]!);
      const balance = await lpToValue(expectedUnmovedBuckets[i]!);

      expect(bucketPrice).toBeGreaterThan(htp);
      expect(bucketPrice).toBeLessThanOrEqual(currentPrice);
      expect(balance).toBe(100000000000000000000n);
    }

    expect(optimalBucketBalanceAfter - optimalBucketBalanceBefore).toBe(expectedMoveAmount);

    // Assert that minimum move balance is respected
    expect(dustyBucketBefore).toBeLessThan(BigInt(process.env.MIN_MOVE_AMOUNT!));
    expect(dustyBucketBefore).toBe(dustyBucketAfter);
  });

  it('refills buffer before optimal bucket when necessary', async () => {
    await setBufferRatio(5000n);
    const bufferTotalBefore = await getBufferTotal();
    const optimalBucketBalanceBefore = await lpToValue(4157n);
    const expectedBufferBalance = await _calculateBufferTarget();
    const expectedMoveAmount = 12n * 100000000000000000000n;

    await run();

    const bufferTotalAfter = await getBufferTotal();
    const optimalBucketBalanceAfter = await lpToValue(4157n);

    expect(bufferTotalBefore).toBe(0n);
    expect(bufferTotalAfter).toBe(expectedBufferBalance);
    expect(optimalBucketBalanceAfter - optimalBucketBalanceBefore).toBe(
      expectedMoveAmount - expectedBufferBalance,
    );
  });

  it('moves buffer surplus into optimal bucket', async () => {
    await setBufferRatio(5000n);
    const bufferTarget = await _calculateBufferTarget();
    const expectedMoveAmount = 12n * 100000000000000000000n;

    await addToBuffer(2n * bufferTarget);

    const bufferTotalBefore = await getBufferTotal();
    const optimalBucketBalanceBefore = await lpToValue(4157n);

    await run();

    const bufferTotalAfter = await getBufferTotal();
    const optimalBucketBalanceAfter = await lpToValue(4157n);

    expect(bufferTotalBefore).toBe(2n * bufferTarget);
    expect(bufferTotalAfter).toBe(bufferTarget);
    expect(optimalBucketBalanceAfter - optimalBucketBalanceBefore).toBe(
      bufferTarget + expectedMoveAmount,
    );
  });
});
