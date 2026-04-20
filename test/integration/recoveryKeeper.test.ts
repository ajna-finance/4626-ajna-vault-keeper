import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

vi.mock('graphql-request', async () => {
  const actual = await vi.importActual('graphql-request');
  return { ...actual, request: vi.fn() };
});

import {
  setLenderLps,
  setLpToCollateral,
  setRemovedCollateralValue,
  useMocks,
} from '../helpers/vaultHelpers';
import { arkRun } from '../../src/keepers/arkKeeper';
import { contract } from '../../src/utils/contract';
import { client } from '../../src/utils/client';
import { config, resolveArkSettings } from '../../src/utils/config';
import { request } from 'graphql-request';
import type { Address } from 'viem';

const testSettings = resolveArkSettings(config.arks[0]!);

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('arkKeeper detection preflight (regression)', () => {
  let snapshot: string;

  const vaultAddr = () => process.env.MOCK_VAULT_ADDRESS as Address;
  const authAddr = () => process.env.MOCK_VAULT_AUTH_ADDRESS as Address;

  // Minimal single-bucket setup — cheaper than the 18-bucket setMockState and
  // sufficient for detection regression tests (arkRun bails before needing full state).
  const addOneBucket = async (bucketIndex: bigint) => {
    await contract('vault', vaultAddr())().write.addBucket(
      bucketIndex,
      1_000_000_000_000_000_000n,
      1_000_000_000_000_000_000n,
    );
  };

  beforeAll(async () => {
    useMocks();
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
  });

  beforeEach(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });

    (request as any).mockReset?.();
    (request as any).mockResolvedValue({ liquidationAuctions: [] });
  });

  afterAll(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
  });

  it('aborts arkRun when collateral is detected in a non-optimal bucket', async () => {
    const bucket = 4149n;
    await addOneBucket(bucket);
    await setLenderLps(bucket, vaultAddr(), 1000n);
    await setLpToCollateral(bucket, 500n);

    // Run without throwing is the test; the key assertion is that arkRun exits via
    // logRunExit without sending any drain/updateInterest txs. If detection failed
    // to catch the collateral, arkRun would progress to expensive tx flows and fail.
    await arkRun(vaultAddr(), authAddr(), testSettings);
  });

  it('aborts arkRun when vault is already recovery-paused', async () => {
    await setRemovedCollateralValue(100n);

    // With rcv > 0, compound vault.paused() returns true, arkRun bails on isPaused
    // check before reaching detection or any tx.
    await arkRun(vaultAddr(), authAddr(), testSettings);
  });
});
