import { type Address, erc20Abi } from 'viem';
import { config, type ResolvedRecoverySettings, resolveRecoverySettings } from '../utils/config';
import { client } from '../utils/client';
import { log } from '../utils/logger';
import { createVault } from '../ark/vault';
import { detectRecoverable, type RecoverableBucket } from '../ark/recovery';
import {
  type SwapExecutor,
  type SwapQuoteRequest,
  UnconfiguredSwapExecutor,
} from '../ark/swapExecutor';
import {
  abridgedViemError,
  getGasWithBuffer,
  parseRecoverCollateralLogs,
  parseReturnQuoteTokenLog,
  wait,
} from '../utils/transaction';

// ============= Types =============

export type RecoveryRequiredEvent = {
  chainId: number;
  arkAddress: Address;
  vaultAddress: Address;
  vaultAuthAddress: Address;
  poolAddress: Address;
  detectedAt: string;
  reason: 'vault_bucket_collateral_detected';
  buckets: Array<{
    index: bigint;
    vaultLps: bigint;
    estimatedCollateralWad: bigint;
    estimatedQuoteValueWad?: bigint;
  }>;
  proposedRefillBucket?: bigint;
  vaultEffectivePaused: boolean;
  authPaused: boolean;
  removedCollateralValue: bigint;
};

export type RecoveryStage =
  | 'IDLE'
  | 'RECOVERED'
  | 'SWAPPED'
  | 'PARTIAL_SWAP_AMBIGUOUS'
  | 'NO_BALANCE'
  | 'BLOCKED_ADMIN_PAUSE'
  | 'ADMIN_PAUSED_DURING_RECOVERY';

type ArkTarget = {
  vaultAddress: Address;
  vaultAuthAddress: Address;
  settings: ResolvedRecoverySettings;
};

// ============= State derivation =============

export function deriveRecoveryStage(input: {
  authPaused: boolean;
  removedCollateralValue: bigint;
  walletCollateralBal: bigint;
  walletQuoteBal: bigint;
}): RecoveryStage {
  const { authPaused, removedCollateralValue, walletCollateralBal, walletQuoteBal } = input;
  if (!authPaused) {
    if (removedCollateralValue === 0n) return 'IDLE';
    if (walletCollateralBal > 0n && walletQuoteBal === 0n) return 'RECOVERED';
    if (walletCollateralBal === 0n && walletQuoteBal > 0n) return 'SWAPPED';
    if (walletCollateralBal > 0n && walletQuoteBal > 0n) return 'PARTIAL_SWAP_AMBIGUOUS';
    return 'NO_BALANCE';
  }
  if (removedCollateralValue === 0n) return 'BLOCKED_ADMIN_PAUSE';
  return 'ADMIN_PAUSED_DURING_RECOVERY';
}

// ============= Dedup store =============

const dedupStore = new Map<string, number>();

export function dedupKey(evt: Pick<RecoveryRequiredEvent, 'chainId' | 'arkAddress' | 'buckets'>): string {
  const sortedIndexes = [...evt.buckets].map((b) => b.index).sort((a, b) => (a < b ? -1 : 1));
  return `${evt.chainId}:${evt.arkAddress}:${sortedIndexes.join(',')}`;
}

export function shouldEmitAlert(
  evt: RecoveryRequiredEvent,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  const key = dedupKey(evt);
  const last = dedupStore.get(key);
  if (last != null && now - last < windowMs) return false;
  dedupStore.set(key, now);
  return true;
}

export function _resetDedupStoreForTests(): void {
  dedupStore.clear();
}

export function _resetArkLocksForTests(): void {
  arkLocks.clear();
}

// ============= Concurrency lock =============

const arkLocks = new Map<Address, Promise<unknown>>();

async function withArkLock<T>(
  addr: Address,
  fn: () => Promise<T>,
): Promise<T | { skipped: true }> {
  if (arkLocks.has(addr)) return { skipped: true };
  const p = fn();
  arkLocks.set(
    addr,
    p.catch(() => {}),
  );
  try {
    return await p;
  } finally {
    arkLocks.delete(addr);
  }
}

// ============= Public entry points =============

export async function detectOnly(target: ArkTarget): Promise<void> {
  await withArkLock(target.vaultAddress, () => runDetectOnly(target));
}

export async function execute(
  target: ArkTarget,
  swapExecutor: SwapExecutor = new UnconfiguredSwapExecutor(),
): Promise<void> {
  await withArkLock(target.vaultAddress, () => runExecute(target, swapExecutor));
}

// ============= Detect mode =============

async function runDetectOnly(target: ArkTarget): Promise<void> {
  const vault = createVault(target.vaultAddress, target.vaultAuthAddress);
  const [authPaused, rcv] = await Promise.all([
    vault.isAuthPaused(),
    vault.getRemovedCollateralValue(),
  ]);

  if (authPaused && rcv === 0n) {
    emitAlert({
      event: 'recovery_blocked_admin_pause',
      ark: target.vaultAddress,
      vaultAddress: target.vaultAddress,
      vaultAuthAddress: target.vaultAuthAddress,
    });
    return;
  }

  const candidates = await detectRecoverable(vault, { includeQuoteEstimate: true });
  if (!candidates) return;

  const evt = await buildRecoveryRequiredEvent(target, vault, candidates, authPaused, rcv);
  if (!shouldEmitAlert(evt, target.settings.dedupWindowMs)) return;

  log.info({ event: 'collateral_recovery_required', ...evt }, 'collateral recovery required');
}

// ============= Execute mode =============

async function runExecute(target: ArkTarget, swapExecutor: SwapExecutor): Promise<void> {
  const vault = createVault(target.vaultAddress, target.vaultAuthAddress);

  const [authPaused, rcv] = await Promise.all([
    vault.isAuthPaused(),
    vault.getRemovedCollateralValue(),
  ]);

  if (authPaused && rcv === 0n) {
    log.warn(
      {
        event: 'recovery_blocked_admin_pause',
        ark: target.vaultAddress,
      },
      'recovery blocked: admin paused with rcv=0',
    );
    return;
  }

  const collateralToken = await vault.getCollateralAddress();
  const quoteToken = config.quoteTokenAddress;
  const wallet = client.account.address;

  // Fail fast if the loaded wallet isn't the on-chain swapper for this vault.
  // Catches misconfigured env (wrong key, wrong vault, wrong chain) before any
  // recoverCollateral attempt wastes gas or reverts.
  const swapper = await vault.getSwapper();
  if (swapper.toLowerCase() !== wallet.toLowerCase()) {
    log.error(
      {
        event: 'recovery_wallet_role_mismatch',
        ark: target.vaultAddress,
        loadedWallet: wallet,
        onChainSwapper: swapper,
      },
      'loaded wallet is not the on-chain swapper; aborting',
    );
    return;
  }

  // Stage 1: recoverCollateral (if fresh run, rcv == 0)
  if (rcv === 0n) {
    const candidates = await detectRecoverable(vault, { includeQuoteEstimate: true });
    if (!candidates) return;

    const evt = await buildRecoveryRequiredEvent(target, vault, candidates, authPaused, rcv);
    if (shouldEmitAlert(evt, target.settings.dedupWindowMs)) {
      log.info({ event: 'collateral_recovery_required', ...evt }, 'collateral recovery required');
    }

    log.info(
      { event: 'recovery_step', step: 'started', ark: target.vaultAddress },
      'recovery started',
    );

    const walletCollateralBefore = await balanceOf(collateralToken, wallet);
    const indexes = candidates.map((c) => c.index);
    const amts = candidates.map((c) => c.estimatedCollateralWad);

    const gas = await getGasWithBuffer(
      'vault',
      'recoverCollateral',
      [indexes, amts],
      target.vaultAddress,
    );
    const receipt = await handleRecoveryTx(vault.recoverCollateral(indexes, amts, gas), {
      action: 'recoverCollateral',
      ark: target.vaultAddress,
    });
    if (!receipt) return;

    const walletCollateralAfter = await balanceOf(collateralToken, wallet);
    const actualRecovered = walletCollateralAfter - walletCollateralBefore;
    const logs = parseRecoverCollateralLogs(receipt);
    log.info(
      {
        event: 'recovery_recovered_collateral',
        ark: target.vaultAddress,
        actualRecoveredCollateral: actualRecovered,
        perBucket: logs,
      },
      'recoverCollateral succeeded',
    );
  } else {
    // Resume path: stage already known via chain state + wallet balances
    const [walletCollateralBal, walletQuoteBal] = await Promise.all([
      balanceOf(collateralToken, wallet),
      balanceOf(quoteToken, wallet),
    ]);
    const stage = deriveRecoveryStage({
      authPaused,
      removedCollateralValue: rcv,
      walletCollateralBal,
      walletQuoteBal,
    });
    log.info(
      {
        event: 'recovery_step',
        step: 'resume_detected',
        ark: target.vaultAddress,
        stage,
        walletCollateralBal,
        walletQuoteBal,
      },
      `resuming from stage ${stage}`,
    );
    if (stage === 'PARTIAL_SWAP_AMBIGUOUS' || stage === 'NO_BALANCE') {
      log.error(
        { event: 'recovery_state_mismatch', ark: target.vaultAddress, stage },
        'operator attention required',
      );
      return;
    }
  }

  // Resolve refill bucket now; some stages need it for the quote call
  const refillBucket =
    target.settings.refillBucketOverride ?? ((await vault.getMinBucketIndex()) as bigint);

  // Stage 2: swap (if wallet still holds collateral)
  const walletCollateralBal = await balanceOf(collateralToken, wallet);
  if (walletCollateralBal > 0n) {
    const totalVaultLps = await sumVaultLps(vault);
    const expectedQuoteOut = await vault.lpToQuoteTokens(refillBucket, totalVaultLps);

    const chainId = config.chainId;
    const buildQuoteReq = (): SwapQuoteRequest => ({
      chainId,
      tokenIn: collateralToken,
      tokenOut: quoteToken,
      amountIn: walletCollateralBal,
      maxSlippageBps: target.settings.maxSlippageBps,
      maxValueLossBps: target.settings.maxValueLossBps,
      expectedQuoteOut,
      recipient: wallet,
      deadline: BigInt(Math.floor(Date.now() / 1000) + target.settings.swapDeadlineSec),
    });

    const quoteReq = buildQuoteReq();

    let quote;
    try {
      quote = await swapExecutor.quoteExactIn(quoteReq);
    } catch (err) {
      log.error(
        {
          event: 'recovery_swap_failed',
          reason: 'quote_failed',
          ark: target.vaultAddress,
          err: abridgedViemError(err),
        },
        'swap quote failed',
      );
      return;
    }
    log.info(
      {
        event: 'recovery_step',
        step: 'swap_quoted',
        ark: target.vaultAddress,
        expectedQuoteOut,
        quote,
      },
      'swap quoted',
    );

    // Approve collateral to the swap adapter's recipient side (exact amount, reset if stale)
    // The adapter itself is expected to pull from `wallet` via standard ERC20 allowance pattern.
    // The concrete spender is adapter-specific; for now we approve to the quote executor itself
    // by convention — Bot 1's adapter must expose its spender address. This scaffold uses
    // the recipient field as a proxy when Bot 1 is the recipient. Real adapter replaces this.
    // NOTE: infinite approvals avoided per TODOS.md approval-lifecycle policy.
    await approveExact(collateralToken, wallet, walletCollateralBal);

    const walletQuoteBefore = await balanceOf(quoteToken, wallet);
    const executeReq = buildQuoteReq();
    let swapResult;
    try {
      swapResult = await swapExecutor.executeExactIn(executeReq);
    } catch (err) {
      log.error(
        {
          event: 'recovery_swap_failed',
          reason: 'revert',
          ark: target.vaultAddress,
          err: abridgedViemError(err),
        },
        'swap execute failed',
      );
      return;
    }
    const walletQuoteAfter = await balanceOf(quoteToken, wallet);
    const actualAmountOut = walletQuoteAfter - walletQuoteBefore;

    const minAcceptable = (expectedQuoteOut * BigInt(10000 - target.settings.maxValueLossBps)) / 10000n;
    if (actualAmountOut < minAcceptable) {
      log.error(
        {
          event: 'recovery_swap_value_loss_exceeded',
          ark: target.vaultAddress,
          expectedQuoteOut,
          actualAmountOut,
          maxValueLossBps: target.settings.maxValueLossBps,
          minAcceptable,
          swapResult,
        },
        'swap output below vault-value threshold, halting',
      );
      return;
    }

    log.info(
      {
        event: 'recovery_swap_executed',
        ark: target.vaultAddress,
        actualAmountOut,
        expectedQuoteOut,
        txHash: swapResult.txHash,
        routeId: swapResult.routeId,
      },
      'swap executed',
    );
  }

  // Stage 3: refill bucket pre-check + returnQuoteToken
  const walletQuoteBalFinal = await balanceOf(quoteToken, wallet);
  const refillInfo = await vault.getBucketInfo(refillBucket);
  const refillLps = (refillInfo as unknown as [bigint, bigint, bigint, bigint, bigint])[0];
  const refillBankruptcyTime = (refillInfo as unknown as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ])[2];
  const lpDust = await vault.getLpDust();

  if (
    refillBankruptcyTime > 0n &&
    BigInt(Math.floor(Date.now() / 1000)) - refillBankruptcyTime <
      target.settings.minTimeSinceBankruptcy
  ) {
    log.error(
      {
        event: 'recovery_refill_failed',
        reason: 'recently_bankrupt',
        ark: target.vaultAddress,
        refillBucket,
        bankruptcyTime: refillBankruptcyTime,
      },
      'refill bucket recently bankrupt',
    );
    return;
  }

  if (refillLps === 0n && walletQuoteBalFinal < lpDust) {
    log.error(
      {
        event: 'recovery_refill_failed',
        reason: 'below_dust',
        ark: target.vaultAddress,
        refillBucket,
        walletQuoteBal: walletQuoteBalFinal,
        lpDust,
      },
      'refill amount below LP_DUST on empty bucket',
    );
    return;
  }

  // Exchange rate check: if the amount we'd refill would mint proportionally less LP
  // than the minLpMintedBps threshold vs. a perfect 1:1 bucket, the bucket is impaired
  // (e.g., post-bankruptcy residual state). Bail rather than dump quote into a bad bucket.
  if (walletQuoteBalFinal > 0n) {
    const expectedLpForDeposit = await vault.lpToQuoteTokens(refillBucket, walletQuoteBalFinal);
    if (expectedLpForDeposit > 0n) {
      const ratioBps = (expectedLpForDeposit * 10000n) / walletQuoteBalFinal;
      if (ratioBps < BigInt(target.settings.minLpMintedBps)) {
        log.error(
          {
            event: 'recovery_refill_failed',
            reason: 'poor_exchange_rate',
            ark: target.vaultAddress,
            refillBucket,
            walletQuoteBal: walletQuoteBalFinal,
            expectedLpForDeposit,
            ratioBps,
            minLpMintedBps: target.settings.minLpMintedBps,
          },
          'refill bucket exchange rate below minLpMintedBps',
        );
        return;
      }
    }
  }

  // Approve quote to vault and call returnQuoteToken
  await approveExact(quoteToken, target.vaultAddress, walletQuoteBalFinal);

  log.info(
    {
      event: 'recovery_step',
      step: 'refill_started',
      ark: target.vaultAddress,
      refillBucket,
      amount: walletQuoteBalFinal,
    },
    'refill started',
  );

  const refillGas = await getGasWithBuffer(
    'vault',
    'returnQuoteToken',
    [refillBucket, walletQuoteBalFinal],
    target.vaultAddress,
  );
  const refillReceipt = await handleRecoveryTx(
    vault.returnQuoteToken(refillBucket, walletQuoteBalFinal, refillGas),
    {
      action: 'returnQuoteToken',
      ark: target.vaultAddress,
    },
  );

  if (!refillReceipt) {
    log.error(
      {
        event: 'recovery_refill_failed',
        reason: 'revert',
        ark: target.vaultAddress,
        refillBucket,
      },
      'returnQuoteToken reverted',
    );
    return;
  }

  // Stage 4: reconcile and emit completion
  const [rcvAfter, authPausedAfter, walletCollateralAfter, walletQuoteAfter] = await Promise.all([
    vault.getRemovedCollateralValue(),
    vault.isAuthPaused(),
    balanceOf(collateralToken, wallet),
    balanceOf(quoteToken, wallet),
  ]);
  const returnLog = parseReturnQuoteTokenLog(refillReceipt);

  log.info(
    {
      event: 'recovery_completed',
      ark: target.vaultAddress,
      adminPausePending: authPausedAfter,
      removedCollateralValue: rcvAfter,
      walletCollateralBalance: walletCollateralAfter,
      walletQuoteBalance: walletQuoteAfter,
      refillBucketIndex: refillBucket,
      lpMintedDelta: returnLog?.lps ?? null,
    },
    'recovery complete',
  );
}

// ============= Helpers =============

async function buildRecoveryRequiredEvent(
  target: ArkTarget,
  vault: ReturnType<typeof createVault>,
  candidates: RecoverableBucket[],
  authPaused: boolean,
  rcv: bigint,
): Promise<RecoveryRequiredEvent> {
  const poolAddress = await vault.getPoolAddress();
  const vaultEffectivePaused = authPaused || rcv > 0n;
  const proposedRefillBucket =
    target.settings.refillBucketOverride ?? ((await vault.getMinBucketIndex()) as bigint);
  return {
    chainId: config.chainId,
    arkAddress: target.vaultAddress,
    vaultAddress: target.vaultAddress,
    vaultAuthAddress: target.vaultAuthAddress,
    poolAddress,
    detectedAt: new Date().toISOString(),
    reason: 'vault_bucket_collateral_detected',
    buckets: candidates.map((c) => {
      const b: RecoveryRequiredEvent['buckets'][number] = {
        index: c.index,
        vaultLps: c.vaultLps,
        estimatedCollateralWad: c.estimatedCollateralWad,
      };
      if (c.estimatedQuoteValueWad !== undefined) b.estimatedQuoteValueWad = c.estimatedQuoteValueWad;
      return b;
    }),
    proposedRefillBucket,
    vaultEffectivePaused,
    authPaused,
    removedCollateralValue: rcv,
  };
}

async function sumVaultLps(vault: ReturnType<typeof createVault>): Promise<bigint> {
  const buckets = (await vault.getBuckets()) as readonly bigint[];
  const lps = await Promise.all(buckets.map((b) => vault.getVaultLps(b)));
  return lps.reduce((acc, x) => acc + x, 0n);
}

async function balanceOf(token: Address, owner: Address): Promise<bigint> {
  return (await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint;
}

async function approveExact(token: Address, spender: Address, amount: bigint): Promise<void> {
  const current = (await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [client.account.address, spender],
  })) as bigint;
  if (current === amount) return;
  if (current !== 0n) {
    const resetHash = await client.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, 0n],
      chain: null,
      account: client.account,
    });
    await wait(resetHash);
  }
  const hash = await client.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
    chain: null,
    account: client.account,
  });
  await wait(hash);
}

async function handleRecoveryTx(
  txP: Promise<`0x${string}`>,
  context: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof wait>> | null> {
  try {
    const hash = await txP;
    return await wait(hash);
  } catch (err) {
    log.error(
      { event: 'recovery_tx_failed', ...context, err: abridgedViemError(err) },
      `recovery tx failed: ${context.action}`,
    );
    return null;
  }
}

function emitAlert(payload: Record<string, unknown>): void {
  log.warn(payload, String(payload.event ?? 'recovery_alert'));
}

// ============= Config helpers for scheduler =============

export function getRecoveryTargets(): ArkTarget[] {
  return config.arks.map((ark) => ({
    vaultAddress: ark.vaultAddress,
    vaultAuthAddress: ark.vaultAuthAddress,
    settings: resolveRecoverySettings(ark),
  }));
}

