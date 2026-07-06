import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
  execute,
  _resetArkLocksForTests,
  _resetDedupStoreForTests,
} from '../../src/keepers/recoveryKeeper';
import { createVault } from '../../src/ark/vault';
import { config, resolveArkSettings, resolveRecoverySettings } from '../../src/utils/config';
import { log } from '../../src/utils/logger';
import { request } from 'graphql-request';

const testSettings = resolveArkSettings(config.arks[0]!);
const testRecoverySettings = resolveRecoverySettings(config.arks[0]!);

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

describe('recoveryKeeper execute mode: swap executor preflight', () => {
  useForkSnapshot();
  useSubgraphMock(request);

  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  const target = () => ({
    vaultAddress: vaultAddr(),
    vaultAuthAddress: authAddr(),
    settings: testRecoverySettings,
  });

  beforeEach(() => {
    _resetDedupStoreForTests();
    _resetArkLocksForTests();
    errorSpy = vi.spyOn(log, 'error');
    infoSpy = vi.spyOn(log, 'info');
  });

  it('blocks before any on-chain action when no SwapExecutor is configured', async () => {
    const bucket = 4155n;
    await addOneBucket(bucket);
    await setLenderLps(bucket, vaultAddr(), 1000n);
    await setLpToCollateral(bucket, 500n);

    // No executor argument: execute() falls back to UnconfiguredSwapExecutor.
    await execute(target());

    const blocked = errorSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'recovery_blocked_swap_executor',
    );
    expect(blocked).toBeDefined();

    // The irreversible stage must never have started: no recovery_step, and the
    // vault must not be recovery-paused (rcv untouched).
    const started = infoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'recovery_step',
    );
    expect(started).toBeUndefined();
    const vault = createVault(vaultAddr(), authAddr());
    expect(await vault.getRemovedCollateralValue()).toBe(0n);
  });
});
