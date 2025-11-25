import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

vi.mock('graphql-request', async () => {
  const actual = await vi.importActual('graphql-request');
  return { ...actual, request: vi.fn() };
});

import {
  setAuctionStatus,
  setBankruptcyTime,
  setLps,
  setMockState,
  setPaused,
  useMocks,
} from '../helpers/vaultHelpers';
import { getBuckets, lpToValue } from '../../src/vault/vault';
import { run } from '../../src/keeper';
import { client } from '../../src/utils/client';
import { env } from '../../src/utils/env';
import { request } from 'graphql-request';

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('keeper run failure', () => {
  let snapshot: string;

  beforeAll(async () => {
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
    useMocks();
  });

  beforeEach(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
    await setMockState();

    (request as any).mockReset?.();
    (request as any).mockResolvedValue({ liquidationAuctions: [] });
  });

  afterAll(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
  });

  it('skips run if vault is paused', async () => {
    await setPaused(true);
    await run();

    const buckets = await getBuckets();
    for (let i = 0; i < buckets.length - 2; i++) {
      const balance = await lpToValue(buckets[i]);
      expect(balance).toBe(100000000000000000000n);
    }

    await setPaused(false);
  });

  it('skips run if optimal bucket is out of range', async () => {
    env.OPTIMAL_BUCKET_DIFF = 15n;
    await run();

    const buckets = await getBuckets();
    for (let i = 0; i < buckets.length - 2; i++) {
      const balance = await lpToValue(buckets[i]);
      expect(balance).toBe(100000000000000000000n);
    }

    env.OPTIMAL_BUCKET_DIFF = 1n;
  });

  it('skips run if optimal bucket is dusty', async () => {
    await setLps(100000n);
    await run();

    const buckets = await getBuckets();
    for (let i = 0; i < buckets.length - 2; i++) {
      const balance = await lpToValue(buckets[i]);
      expect(balance).toBe(100000000000000000000n);
    }
  });

  it('skips run if pool has bad debt', async () => {
    const borrower = '0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf';
    const kickTime = BigInt(Math.floor(Date.now() / 1000)) - 259201n;

    (request as any).mockResolvedValueOnce({
      liquidationAuctions: [{ borrower, kickTime: String(kickTime) }],
    });

    await setAuctionStatus(borrower, kickTime, 0n, 1000000000n);
    await run();

    const buckets = await getBuckets();
    for (let i = 0; i < buckets.length - 2; i++) {
      const balance = await lpToValue(buckets[i]);
      expect(balance).toBe(100000000000000000000n);
    }
  });

  it('skips run if optimal bucket has recently been bankrupt', async () => {
    const bankruptcyTime = BigInt(Math.floor(Date.now() / 1000) - 86400);
    await setBankruptcyTime(bankruptcyTime);

    await run();

    const buckets = await getBuckets();
    for (let i = 0; i < buckets.length - 2; i++) {
      const balance = await lpToValue(buckets[i]);
      expect(balance).toBe(100000000000000000000n);
    }
  });
});
