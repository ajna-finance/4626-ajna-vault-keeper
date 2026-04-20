import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

vi.mock('graphql-request', async () => {
  const actual = await vi.importActual('graphql-request');
  return { ...actual, request: vi.fn() };
});

import {
  setAuthPaused,
  setLenderLps,
  setLpToCollateral,
  setMockState,
  setRemovedCollateralValue,
  useMocks,
} from '../helpers/vaultHelpers';
import { createVault } from '../../src/ark/vault';
import { arkRun } from '../../src/keepers/arkKeeper';
import {
  detectOnly,
  _resetDedupStoreForTests,
  _resetArkLocksForTests,
} from '../../src/keepers/recoveryKeeper';
import { client } from '../../src/utils/client';
import { config, resolveArkSettings, resolveRecoverySettings } from '../../src/utils/config';
import { request } from 'graphql-request';
import { log } from '../../src/utils/logger';
import type { Address } from 'viem';

const testSettings = resolveArkSettings(config.arks[0]!);
const testRecoverySettings = resolveRecoverySettings(config.arks[0]!);

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('recovery integration', { timeout: 120_000 }, () => {
  let snapshot: string;
  let vault: ReturnType<typeof createVault>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const vaultAddr = () => process.env.MOCK_VAULT_ADDRESS as Address;
  const authAddr = () => process.env.MOCK_VAULT_AUTH_ADDRESS as Address;

  const target = () => ({
    vaultAddress: vaultAddr(),
    vaultAuthAddress: authAddr(),
    settings: testRecoverySettings,
  });

  beforeAll(async () => {
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
    useMocks();
    vault = createVault(vaultAddr(), authAddr());
  });

  beforeEach(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
    await setMockState();

    (request as any).mockReset?.();
    (request as any).mockResolvedValue({ liquidationAuctions: [] });

    _resetDedupStoreForTests();
    _resetArkLocksForTests();
    logSpy = vi.spyOn(log, 'info');
  });

  afterAll(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
  });

  describe('arkKeeper detection preflight (regression)', () => {
    it('aborts arkRun when collateral is detected in a NON-optimal bucket', async () => {
      const nonOptimalBucket = 4149n;
      await setLenderLps(nonOptimalBucket, vaultAddr(), 1000n);
      await setLpToCollateral(nonOptimalBucket, 500n);

      await arkRun(vaultAddr(), authAddr(), testSettings);

      const buckets = await vault.getBuckets();
      for (let i = 0; i < buckets.length - 2; i++) {
        const balance = await vault.lpToValue(buckets[i]!);
        expect(balance).toBe(100000000000000000000n);
      }
    });

    it('aborts arkRun when vault is already recovery-paused', async () => {
      await setRemovedCollateralValue(100n);

      await arkRun(vaultAddr(), authAddr(), testSettings);

      const buckets = await vault.getBuckets();
      for (let i = 0; i < buckets.length - 2; i++) {
        const balance = await vault.lpToValue(buckets[i]!);
        expect(balance).toBe(100000000000000000000n);
      }
    });
  });

  describe('recoveryKeeper detect-only mode', () => {
    it('emits collateral_recovery_required when collateral is detected', async () => {
      const bucket = 4155n;
      await setLenderLps(bucket, vaultAddr(), 1000n);
      await setLpToCollateral(bucket, 500n);

      await detectOnly(target());

      const emitted = logSpy.mock.calls.find(
        (c: any[]) => c[0]?.event === 'collateral_recovery_required',
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
        (c: any[]) => c[0]?.event === 'collateral_recovery_required',
      );
      expect(emitted).toBeUndefined();
    });

    it('dedups repeat emissions within the configured window', async () => {
      const bucket = 4155n;
      await setLenderLps(bucket, vaultAddr(), 1000n);
      await setLpToCollateral(bucket, 500n);

      await detectOnly(target());
      await detectOnly(target());

      const emissions = logSpy.mock.calls.filter(
        (c: any[]) => c[0]?.event === 'collateral_recovery_required',
      );
      expect(emissions.length).toBe(1);
    });
  });

  describe('recoveryKeeper admin pause handling', () => {
    it('emits recovery_blocked_admin_pause when AUTH is paused and rcv=0', async () => {
      const warnSpy = vi.spyOn(log, 'warn');
      await setAuthPaused(true);

      await detectOnly(target());

      const blocked = warnSpy.mock.calls.find(
        (c: any[]) => c[0]?.event === 'recovery_blocked_admin_pause',
      );
      expect(blocked).toBeDefined();

      const collateralAlert = logSpy.mock.calls.find(
        (c: any[]) => c[0]?.event === 'collateral_recovery_required',
      );
      expect(collateralAlert).toBeUndefined();
    });
  });
});
