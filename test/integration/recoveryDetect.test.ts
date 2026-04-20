import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('graphql-request', async () => {
  const actual = await vi.importActual('graphql-request');
  return { ...actual, request: vi.fn() };
});

import {
  setAuthPaused,
  setLenderLps,
  setLpToCollateral,
} from '../helpers/vaultHelpers';
import {
  addOneBucket,
  authAddr,
  useForkSnapshot,
  useSubgraphMock,
  vaultAddr,
} from '../helpers/testEnv';
import {
  detectOnly,
  _resetDedupStoreForTests,
  _resetArkLocksForTests,
} from '../../src/keepers/recoveryKeeper';
import { config, resolveRecoverySettings } from '../../src/utils/config';
import { request } from 'graphql-request';
import { log } from '../../src/utils/logger';

const testRecoverySettings = resolveRecoverySettings(config.arks[0]!);

describe('recoveryKeeper detect mode', () => {
  useForkSnapshot();
  useSubgraphMock(request);

  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const target = () => ({
    vaultAddress: vaultAddr(),
    vaultAuthAddress: authAddr(),
    settings: testRecoverySettings,
  });

  beforeEach(() => {
    _resetDedupStoreForTests();
    _resetArkLocksForTests();
    logSpy = vi.spyOn(log, 'info');
    warnSpy = vi.spyOn(log, 'warn');
  });

  it('emits collateral_recovery_required when collateral is detected', async () => {
    const bucket = 4155n;
    await addOneBucket(bucket);
    await setLenderLps(bucket, vaultAddr(), 1000n);
    await setLpToCollateral(bucket, 500n);

    await detectOnly(target());

    const emitted = logSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'collateral_recovery_required',
    );
    expect(emitted).toBeDefined();
    expect(emitted![0]).toMatchObject({
      chainId: config.chainId,
      arkAddress: vaultAddr(),
      authPaused: false,
    });
  });

  it('stays silent when no collateral is found', async () => {
    await detectOnly(target());

    const emitted = logSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'collateral_recovery_required',
    );
    expect(emitted).toBeUndefined();
  });

  it('dedups repeat emissions within the configured window', async () => {
    const bucket = 4155n;
    await addOneBucket(bucket);
    await setLenderLps(bucket, vaultAddr(), 1000n);
    await setLpToCollateral(bucket, 500n);

    await detectOnly(target());
    await detectOnly(target());

    const emissions = logSpy.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'collateral_recovery_required',
    );
    expect(emissions.length).toBe(1);
  });

  it('emits recovery_blocked_admin_pause when AUTH is paused and rcv=0', async () => {
    await setAuthPaused(true);

    await detectOnly(target());

    const blocked = warnSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'recovery_blocked_admin_pause',
    );
    expect(blocked).toBeDefined();

    const collateralAlert = logSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'collateral_recovery_required',
    );
    expect(collateralAlert).toBeUndefined();
  });
});
