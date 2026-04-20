import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

vi.mock('graphql-request', async () => {
  const actual = await vi.importActual('graphql-request');
  return { ...actual, request: vi.fn() };
});

import {
  setAuthPaused,
  setLenderLps,
  setLpToCollateral,
  useMocks,
} from '../helpers/vaultHelpers';
import {
  detectOnly,
  _resetDedupStoreForTests,
  _resetArkLocksForTests,
} from '../../src/keepers/recoveryKeeper';
import { contract } from '../../src/utils/contract';
import { client } from '../../src/utils/client';
import { config, resolveRecoverySettings } from '../../src/utils/config';
import { request } from 'graphql-request';
import { log } from '../../src/utils/logger';
import type { Address } from 'viem';

const testRecoverySettings = resolveRecoverySettings(config.arks[0]!);

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('recoveryKeeper detect mode', () => {
  let snapshot: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const vaultAddr = () => process.env.MOCK_VAULT_ADDRESS as Address;
  const authAddr = () => process.env.MOCK_VAULT_AUTH_ADDRESS as Address;

  const target = () => ({
    vaultAddress: vaultAddr(),
    vaultAuthAddress: authAddr(),
    settings: testRecoverySettings,
  });

  // Minimal bucket setup — one bucket via direct MockVault.addBucket.
  // Avoids the heavy setMockState (18 buckets) which strains the mainnet fork RPC
  // across multiple tests in the same file.
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

    _resetDedupStoreForTests();
    _resetArkLocksForTests();
    logSpy = vi.spyOn(log, 'info');
    warnSpy = vi.spyOn(log, 'warn');
  });

  afterAll(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
  });

  it('emits collateral_recovery_required when collateral is detected', async () => {
    const bucket = 4155n;
    await addOneBucket(bucket);
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
    await addOneBucket(bucket);
    await setLenderLps(bucket, vaultAddr(), 1000n);
    await setLpToCollateral(bucket, 500n);

    await detectOnly(target());
    await detectOnly(target());

    const emissions = logSpy.mock.calls.filter(
      (c: any[]) => c[0]?.event === 'collateral_recovery_required',
    );
    expect(emissions.length).toBe(1);
  });

  it('emits recovery_blocked_admin_pause when AUTH is paused and rcv=0', async () => {
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
