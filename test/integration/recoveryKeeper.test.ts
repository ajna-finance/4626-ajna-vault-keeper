import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('graphql-request', async () => {
  const actual = await vi.importActual('graphql-request');
  return { ...actual, request: vi.fn() };
});

import {
  setAuthPaused,
  setCollateralToken,
  setLenderLps,
  setLpToCollateral,
  setPoolCollateralAddress,
  setRemovedCollateralValue,
  setSwapper,
} from '../helpers/vaultHelpers';
import {
  addOneBucket,
  authAddr,
  collateralTokenAddr,
  fundWithQuoteToken,
  mintCollateral,
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
import type { SwapExecutor } from '../../src/ark/swapExecutor';
import { client } from '../../src/utils/client';
import { contract } from '../../src/utils/contract';
import { waitForWrite } from '../helpers/transactions';
import { config, resolveArkSettings, resolveRecoverySettings } from '../../src/utils/config';
import { log } from '../../src/utils/logger';
import { request } from 'graphql-request';
import { erc20Abi, type Address } from 'viem';

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
    const ok = await execute(target());
    expect(ok).toBe(false);

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

describe('recoveryKeeper execute mode: run outcome', () => {
  useForkSnapshot();
  useSubgraphMock(request);

  // Configured-but-inert executor: lets preflight pass so the outcome of the rest
  // of the run is observable. Tests that reach the swap stage are out of scope here.
  const stubExecutor: SwapExecutor = {
    getSpender: () => '0x00000000000000000000000000000000000000fe',
    quoteExactIn: async () => {
      throw new Error('stub executor: quote not expected in this test');
    },
    executeExactIn: async () => {
      throw new Error('stub executor: execute not expected in this test');
    },
  };

  const target = () => ({
    vaultAddress: vaultAddr(),
    vaultAuthAddress: authAddr(),
    settings: testRecoverySettings,
  });

  beforeEach(() => {
    _resetDedupStoreForTests();
    _resetArkLocksForTests();
  });

  it('returns true for a clean no-op run (nothing recoverable)', async () => {
    await setSwapper(client.account.address);
    // The integration deploy leaves MockPool.collateralAddress unset; the
    // contamination guard needs a real ERC20 to read balances from. The wallet
    // holds no quote token in INTEGRATION mode, so pointing at it keeps the
    // guard clean.
    await setPoolCollateralAddress(config.quoteTokenAddress);

    const ok = await execute(target(), stubExecutor);
    expect(ok).toBe(true);
  });

  it('returns false when blocked by admin pause', async () => {
    await setSwapper(client.account.address);
    await setAuthPaused(true);

    const ok = await execute(target(), stubExecutor);
    expect(ok).toBe(false);
  });

  it('returns false when the loaded wallet is not the on-chain swapper', async () => {
    // Default MockVaultAuth swapper is unset/zero — role check must fail.
    const ok = await execute(target(), stubExecutor);
    expect(ok).toBe(false);
  });
});

describe('recoveryKeeper execute mode: end-to-end', () => {
  useForkSnapshot();
  useSubgraphMock(request);

  const SPENDER = '0x00000000000000000000000000000000000000fe' as Address;
  const WAD = 10n ** 18n;

  // A "DEX" faithful enough for the keeper's accounting: it pulls the approved
  // collateral out of the wallet (so reconciliation sees it consumed) and delivers
  // `quoteOut` real DAI (so the keeper's balance-delta measurement sees the output).
  function fundingExecutor(quoteOut: bigint): SwapExecutor {
    return {
      getSpender: () => SPENDER,
      quoteExactIn: async (req) => ({
        expectedAmountOut: quoteOut,
        minAmountOut: quoteOut,
        routeId: 'stub-route',
        validUntil: req.deadline,
      }),
      executeExactIn: async (req) => {
        const pull = await client.writeContract({
          address: collateralTokenAddr(),
          abi: erc20Abi,
          functionName: 'transfer',
          args: [SPENDER, req.amountIn],
          chain: null,
          account: client.account,
        });
        await client.waitForTransactionReceipt({ hash: pull });
        await fundWithQuoteToken(req.recipient, quoteOut);
        return {
          amountIn: req.amountIn,
          amountOut: quoteOut,
          minAmountOut: quoteOut,
          txHash: `0x${'ab'.repeat(32)}` as `0x${string}`,
          routeId: 'stub-route',
          recipient: req.recipient,
        };
      },
    };
  }

  const target = () => ({
    vaultAddress: vaultAddr(),
    vaultAuthAddress: authAddr(),
    settings: testRecoverySettings,
  });

  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const findEvent = (spy: ReturnType<typeof vi.spyOn>, event: string) =>
    spy.mock.calls.find((c) => (c[0] as { event?: string })?.event === event);

  beforeEach(async () => {
    _resetDedupStoreForTests();
    _resetArkLocksForTests();
    infoSpy = vi.spyOn(log, 'info');
    errorSpy = vi.spyOn(log, 'error');
    // Wire the collateral token per-test, inside the fork-snapshot scope. The deploy
    // script deliberately only DEPLOYS the token: wiring it at deploy time
    // destabilizes the arkKeeper integration suite (see deploy.integration.s.sol).
    await setPoolCollateralAddress(collateralTokenAddr());
    await setCollateralToken(collateralTokenAddr());
    await mintCollateral(vaultAddr(), 1_000_000n * WAD);
  });

  it('runs the full pipeline: detect, recoverCollateral, swap, refill, reconcile', async () => {
    const bucket = 4156n;
    await addOneBucket(bucket); // price 1.0, so rcv == recovered collateral amount
    await setLenderLps(bucket, vaultAddr(), 1000n);
    await setLpToCollateral(bucket, WAD);
    await setSwapper(client.account.address);

    const ok = await execute(target(), fundingExecutor(WAD));
    expect(ok).toBe(true);

    expect(findEvent(infoSpy, 'recovery_recovered_collateral')).toBeDefined();
    expect(findEvent(infoSpy, 'recovery_swap_executed')).toBeDefined();
    const completed = findEvent(infoSpy, 'recovery_completed');
    expect(completed).toBeDefined();
    expect(completed![0]).toMatchObject({ adminPausePending: false });

    const vault = createVault(vaultAddr(), authAddr());
    expect(await vault.getRemovedCollateralValue()).toBe(0n);
    // The stub pulled the approved collateral, so nothing is stranded in the wallet.
    const walletCollateral = await client.readContract({
      address: collateralTokenAddr(),
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [client.account.address],
    });
    expect(walletCollateral).toBe(0n);
  });

  it('resumes from RECOVERED (crash after recoverCollateral) and completes', async () => {
    await setRemovedCollateralValue(WAD);
    await mintCollateral(client.account.address, WAD);
    await setSwapper(client.account.address);

    const ok = await execute(target(), fundingExecutor(WAD));
    expect(ok).toBe(true);

    expect(findEvent(infoSpy, 'recovery_swap_executed')).toBeDefined();
    expect(findEvent(infoSpy, 'recovery_completed')).toBeDefined();
    const vault = createVault(vaultAddr(), authAddr());
    expect(await vault.getRemovedCollateralValue()).toBe(0n);
  });

  it('resumes from SWAPPED and refills WITHOUT any configured swap executor', async () => {
    // The operator-assisted path: swap already happened (manually or pre-crash),
    // wallet holds quote only. Must complete with the default UnconfiguredSwapExecutor.
    await setRemovedCollateralValue(WAD);
    await fundWithQuoteToken(client.account.address, WAD);
    await setSwapper(client.account.address);

    const ok = await execute(target());
    expect(ok).toBe(true);

    expect(findEvent(errorSpy, 'recovery_blocked_swap_executor')).toBeUndefined();
    expect(findEvent(infoSpy, 'recovery_completed')).toBeDefined();
    const vault = createVault(vaultAddr(), authAddr());
    expect(await vault.getRemovedCollateralValue()).toBe(0n);
  });

  it('halts before refill when swap output breaches the value-loss threshold', async () => {
    const bucket = 4156n;
    await addOneBucket(bucket);
    await setLenderLps(bucket, vaultAddr(), 1000n);
    await setLpToCollateral(bucket, WAD);
    await setSwapper(client.account.address);

    // rcv will be 1e18; funding only 0.5e18 breaches maxValueLossBps (1%).
    const ok = await execute(target(), fundingExecutor(WAD / 2n));
    expect(ok).toBe(false);

    expect(findEvent(errorSpy, 'recovery_swap_value_loss_exceeded')).toBeDefined();
    const refillStarted = infoSpy.mock.calls.find(
      (c) => (c[0] as { step?: string })?.step === 'refill_started',
    );
    expect(refillStarted).toBeUndefined();
    // Vault stays recovery-paused for the operator.
    const vault = createVault(vaultAddr(), authAddr());
    expect(await vault.getRemovedCollateralValue()).toBe(WAD);
  });

  it('completes under admin pause and reports adminPausePending', async () => {
    await setRemovedCollateralValue(WAD);
    await setAuthPaused(true);
    await fundWithQuoteToken(client.account.address, WAD);
    await setSwapper(client.account.address);

    const ok = await execute(target());
    expect(ok).toBe(true);

    const completed = findEvent(infoSpy, 'recovery_completed');
    expect(completed).toBeDefined();
    expect(completed![0]).toMatchObject({ adminPausePending: true });
    const vault = createVault(vaultAddr(), authAddr());
    expect(await vault.getRemovedCollateralValue()).toBe(0n);
    expect(await vault.isAuthPaused()).toBe(true);
  });
});

describe('MockVault rcv pricing (contract-truth regression)', () => {
  useForkSnapshot();

  it('records removedCollateralValue as the quote-WAD value at bucket price, not raw collateral', async () => {
    // Price 2.0 makes raw-vs-priced distinguishable: the real vault records
    // (gems * price) / WAD, so 500 raw collateral at price 2e18 must yield rcv
    // 1000 — the pre-fix mock summed the raw amounts (500).
    const bucketA = 4155n;
    const bucketB = 4156n;
    const vaultContract = contract('vault', vaultAddr())();
    await waitForWrite(vaultContract.write.addBucket(bucketA, 2n * 10n ** 18n, 10n ** 18n));
    await waitForWrite(vaultContract.write.addBucket(bucketB, 5n * 10n ** 17n, 10n ** 18n));

    await waitForWrite(
      vaultContract.write.recoverCollateral([
        [bucketA, bucketB],
        [500n, 1000n],
      ]),
    );

    // 500 * 2.0 + 1000 * 0.5 = 1000 + 500 = 1500.
    const vault = createVault(vaultAddr(), authAddr());
    expect(await vault.getRemovedCollateralValue()).toBe(1500n);
  });
});
