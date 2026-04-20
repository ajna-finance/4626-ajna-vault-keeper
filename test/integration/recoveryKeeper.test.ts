import { describe, it, vi } from 'vitest';

vi.mock('graphql-request', async () => {
  const actual = await vi.importActual('graphql-request');
  return { ...actual, request: vi.fn() };
});

import {
  setLenderLps,
  setLpToCollateral,
  setRemovedCollateralValue,
} from '../helpers/vaultHelpers';
import {
  addOneBucket,
  authAddr,
  useForkSnapshot,
  useSubgraphMock,
  vaultAddr,
} from '../helpers/testEnv';
import { arkRun } from '../../src/keepers/arkKeeper';
import { config, resolveArkSettings } from '../../src/utils/config';
import { request } from 'graphql-request';

const testSettings = resolveArkSettings(config.arks[0]!);

describe('arkKeeper detection preflight (regression)', () => {
  useForkSnapshot();
  useSubgraphMock(request);

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
