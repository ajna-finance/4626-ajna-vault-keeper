import { type Address, erc20Abi } from 'viem';
import { config, type ResolvedRecoverySettings, resolveRecoverySettings } from '../utils/config';
import { client } from '../utils/client';
import { log } from '../utils/logger';
import { createVault } from '../ark/vault';
import { detectRecoverable, type RecoverableBucket } from '../ark/recovery';
import { getChainTime, ChainTimeUnavailableError } from '../utils/chainTime';
import { isHalted } from './arkKeeper';
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

const DEDUP_STORE_MAX_ENTRIES = 1000;
const dedupStore = new Map<string, number>();
// Separate store for dust warnings so they don't compete with real alerts for LRU slots.
const dustDedupStore = new Map<string, number>();

// Quote-token dust floor divisor against assetScale: yields ~0.001 token units (e.g.
// 1000 wei USDC = $0.001, 1e15 wei DAI ≈ $0.001). The quote token is ~$1-valued in this
// protocol, so a token-count floor is also a value floor.
const QUOTE_DUST_DIVISOR = 1000n;

// Collateral dust floor in raw token units, scaled by the collateral token's decimals.
// Collateral has no value anchor (price is arbitrary), so the floor must stay negligible
// in token terms for every decimals config:
// - one micro-token (10^decimals / 1e6) so low-decimal tokens don't get real value
//   misread as dust (900 raw units of a 2-decimal token is 9 whole tokens);
// - at least 1 raw unit (smallest representable);
// - capped at 1000 raw units so high-decimal tokens keep the historical 1000-wei floor —
//   raising it would open a gap between the detection value floor (minRecoveryValueWad)
//   and the swap-skip floor where a recovery could strand with rcv > 0.
export function collateralDustFloor(decimals: number): bigint {
  const microToken = 10n ** BigInt(decimals) / 1_000_000n;
  const floored = microToken === 0n ? 1n : microToken;
  return floored > 1000n ? 1000n : floored;
}

export function dedupKey(evt: Pick<RecoveryRequiredEvent, 'chainId' | 'arkAddress' | 'buckets'>): string {
  // Lowercase arkAddress: config stores verbatim casing and an operator re-casing a
  // 0xAbC... to 0xabc... between restarts would otherwise silently bypass dedup.
  const sortedIndexes = [...evt.buckets].map((b) => b.index).sort((a, b) => (a < b ? -1 : 1));
  return `${evt.chainId}:${evt.arkAddress.toLowerCase()}:${sortedIndexes.join(',')}`;
}

export function shouldEmitAlert(
  evt: RecoveryRequiredEvent,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  const key = dedupKey(evt);
  const last = dedupStore.get(key);
  // Clock-skew guard: if system clock moved backwards (NTP), never silence the alert.
  if (last != null && now >= last && now - last < windowMs) {
    // Suppressed hit: refresh LRU position without changing the stored timestamp.
    // Otherwise a hot suppressed key can be evicted by 1000 new keys within its window.
    dedupStore.delete(key);
    dedupStore.set(key, last);
    return false;
  }
  // Bounded LRU: for a new key, evict the oldest-inserted entry when at capacity.
  // For an existing key, delete-then-set to move it to the tail of insertion order
  // (JS Map iterates in insertion order, so delete+set makes this genuine LRU).
  if (dedupStore.has(key)) {
    dedupStore.delete(key);
  } else if (dedupStore.size >= DEDUP_STORE_MAX_ENTRIES) {
    const oldestKey = dedupStore.keys().next().value;
    if (oldestKey !== undefined) dedupStore.delete(oldestKey);
  }
  dedupStore.set(key, now);
  return true;
}

export function _resetDedupStoreForTests(): void {
  dedupStore.clear();
}

export function _resetArkLocksForTests(): void {
  arkLocks.clear();
}

// ============= Refill pre-check =============

export type RefillPrecheckInput = {
  // Deposit amount in WAD (returnQuoteToken's _amt basis).
  amountWad: bigint;
  // The vault's OWN LP in the refill bucket (pool.lenderInfo) — the DustyBucket basis.
  vaultRefillLps: bigint;
  // Pool-total LP in the refill bucket (bucketInfo) — the BucketLPDangerous basis.
  bucketLps: bigint;
  bucketCollateral: bigint;
  bankruptcyTime: bigint;
  nowSec: bigint;
  minTimeSinceBankruptcy: bigint;
  lpDust: bigint;
  minLpMintedBps: number;
};

export type RefillPrecheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'recently_bankrupt' | 'bucket_lp_dangerous' | 'no_quote_to_refill' | 'below_dust';
      detail: Record<string, unknown>;
    };

// Mirrors the contract's refill gates so a doomed returnQuoteToken is caught before
// spending gas, with a precise reason instead of a generic revert.
export function refillPrecheck(i: RefillPrecheckInput): RefillPrecheckResult {
  if (i.bankruptcyTime > 0n && i.nowSec - i.bankruptcyTime < i.minTimeSinceBankruptcy) {
    return { ok: false, reason: 'recently_bankrupt', detail: { bankruptcyTime: i.bankruptcyTime } };
  }

  // _validDestination in AjnaVaultLibrary reverts with BucketLPDangerous when
  // 0 < POOL-TOTAL bucketLP <= 1_000_000.
  if (i.bucketLps > 0n && i.bucketLps <= 1_000_000n) {
    return { ok: false, reason: 'bucket_lp_dangerous', detail: { refillLps: i.bucketLps } };
  }

  // Zero-quote guard: if Stage 2 was skipped or the wallet was externally swept,
  // returnQuoteToken(bucket, 0) would revert or no-op, leaving rcv>0 and the vault
  // paused forever. Bail to operator.
  if (i.amountWad === 0n) {
    return { ok: false, reason: 'no_quote_to_refill', detail: {} };
  }

  // DustyBucket basis: the contract checks the VAULT'S OWN LP after minting
  // (AjnaVaultLibrary._fill: lps[bucket] += minted; revert if < LP_DUST) — NOT the
  // pool-total bucket LP and NOT the deposit amount. A bucket full of other lenders'
  // LP still reverts if the vault's own minted LP lands under LP_DUST.
  //
  // Minted-LP estimate: for pure-quote buckets the poor_exchange_rate gate (applied
  // after this pre-check) rejects any bucket whose round-trip falls below
  // minLpMintedBps, so minted >= amount * minLpMintedBps / 10000 on every path that
  // reaches the tx (the ~1% margin also absorbs Ajna's deposit fee). Mixed buckets
  // have no reliable bound — LP prices in collateral too — so approximate minted with
  // the full amount; a mixed bucket with an extreme rate can still revert on-chain,
  // reported as reason 'revert'.
  const estimatedMintedLp =
    i.bucketCollateral === 0n ? (i.amountWad * BigInt(i.minLpMintedBps)) / 10000n : i.amountWad;
  if (i.vaultRefillLps + estimatedMintedLp < i.lpDust) {
    return {
      ok: false,
      reason: 'below_dust',
      detail: { vaultRefillLps: i.vaultRefillLps, estimatedMintedLp, lpDust: i.lpDust },
    };
  }

  return { ok: true };
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

// Returns true when the run needs no operator attention: either a clean no-op
// (nothing recoverable) or a completed recovery. Every blocked/failed path returns
// false so recovery-oneshot can exit non-zero instead of masking failure.
export async function execute(
  target: ArkTarget,
  swapExecutor: SwapExecutor = new UnconfiguredSwapExecutor(),
): Promise<boolean> {
  const result = await withArkLock(target.vaultAddress, () => runExecute(target, swapExecutor));
  // A lock skip means another run is already executing this ark — nothing we can
  // claim succeeded in THIS invocation, so report it as needing attention.
  return result === true;
}

// ============= Detect mode =============

async function runDetectOnly(target: ArkTarget): Promise<void> {
  const ark = target.vaultAddress;
  const vault = createVault(target.vaultAddress, target.vaultAuthAddress);
  const [authPaused, rcv, onChainAuth, poolAddress, minBucketIndex] = await Promise.all([
    vault.isAuthPaused(),
    vault.getRemovedCollateralValue(),
    vault.getAuthAddress(),
    vault.getPoolAddress(),
    vault.getMinBucketIndex() as Promise<bigint>,
  ]);

  // Auth pointer drift: if the vault's on-chain AUTH differs from the config value,
  // isAuthPaused() read paused state from the wrong contract. Flag loudly — detect
  // mode can't recover from this, but the alert lets operator fix config.
  if (onChainAuth.toLowerCase() !== target.vaultAuthAddress.toLowerCase()) {
    log.error(
      {
        event: 'recovery_auth_drift',
        ark,
        configVaultAuth: target.vaultAuthAddress,
        onChainAuth,
      },
      'vault.AUTH() does not match config vaultAuthAddress; detection may be unreliable',
    );
    return;
  }

  if (authPaused && rcv === 0n) {
    log.warn(
      {
        event: 'recovery_blocked_admin_pause',
        ark,
        vaultAuthAddress: target.vaultAuthAddress,
      },
      'recovery blocked: admin paused with rcv=0',
    );
    return;
  }

  const candidates = await detectRecoverable(vault, {
    includeQuoteEstimate: true,
    minValueWad: target.settings.minRecoveryValueWad,
  });
  if (!candidates) return;

  const evt = await buildRecoveryRequiredEvent(
    target,
    candidates,
    authPaused,
    rcv,
    poolAddress,
    minBucketIndex,
  );
  if (!shouldEmitAlert(evt, target.settings.dedupWindowMs)) return;

  log.info({ event: 'collateral_recovery_required', ...evt }, 'collateral recovery required');
}

// ============= Execute mode =============

async function runExecute(target: ArkTarget, swapExecutor: SwapExecutor): Promise<boolean> {
  const ark = target.vaultAddress;
  // If arkKeeper halted (e.g. LUPBelowHTP on a recoverCollateral tx), don't retry every
  // tick — the on-chain precondition won't change from under us and each attempt just
  // burns gas on the same revert.
  if (isHalted(ark)) {
    log.warn(
      { event: 'recovery_skipped', reason: 'keeper_halted', ark },
      'recovery skipped: keeper halted',
    );
    return false;
  }

  const vault = createVault(target.vaultAddress, target.vaultAuthAddress);

  // Batch all vault-side reads needed for preflight + refill planning in one round-trip.
  // minBucketIndex/poolAddress are consumed later (refill + event build) but cheap to read now.
  const [authPaused, rcv, poolAddress, minBucketIndex] = await Promise.all([
    vault.isAuthPaused(),
    vault.getRemovedCollateralValue(),
    vault.getPoolAddress(),
    vault.getMinBucketIndex() as Promise<bigint>,
  ]);

  if (authPaused && rcv === 0n) {
    log.warn(
      {
        event: 'recovery_blocked_admin_pause',
        ark,
      },
      'recovery blocked: admin paused with rcv=0',
    );
    return false;
  }

  const collateralToken = await vault.getCollateralAddress();
  const quoteToken = config.quoteTokenAddress;
  const wallet = client.account.address;

  // Probe the swap executor BEFORE starting a FRESH recovery. recoverCollateral is
  // irreversible (rcv>0 pauses the vault until the full swap+refill pipeline
  // completes), so a deployment without a real Bot 1 adapter must fail here — not
  // after the vault is already paused with collateral stranded in the wallet.
  // Deliberately scoped to rcv == 0: a resume whose swap already happened (stage
  // SWAPPED — e.g. the operator swapped manually) never needs the executor and must
  // be able to finish the refill without one. Resumes that still hold collateral are
  // re-probed at the swap stage. getSpender is a local, synchronous call;
  // UnconfiguredSwapExecutor (the default) throws on it.
  if (rcv === 0n) {
    try {
      swapExecutor.getSpender(collateralToken);
    } catch (err) {
      log.error(
        {
          event: 'recovery_blocked_swap_executor',
          ark,
          err: abridgedViemError(err),
        },
        'swap executor unavailable; blocking recovery before any on-chain action',
      );
      return false;
    }
  }

  // Fail fast if the loaded wallet isn't the on-chain swapper for this vault.
  // Catches misconfigured env (wrong key, wrong vault, wrong chain) before any
  // recoverCollateral attempt wastes gas or reverts.
  const [swapper, onChainAuth] = await Promise.all([
    vault.getSwapper(),
    vault.getAuthAddress(),
  ]);
  if (swapper.toLowerCase() !== wallet.toLowerCase()) {
    log.error(
      {
        event: 'recovery_wallet_role_mismatch',
        ark,
        loadedWallet: wallet,
        onChainSwapper: swapper,
      },
      'loaded wallet is not the on-chain swapper; aborting',
    );
    return false;
  }
  // Auth pointer drift: if the vault's on-chain AUTH differs from the vaultAuthAddress
  // in config, we may have been reading paused/swapper state from the wrong contract.
  if (onChainAuth.toLowerCase() !== target.vaultAuthAddress.toLowerCase()) {
    log.error(
      {
        event: 'recovery_auth_drift',
        ark,
        configVaultAuth: target.vaultAuthAddress,
        onChainAuth,
      },
      'vault.AUTH() does not match config vaultAuthAddress; aborting',
    );
    return false;
  }

  // Dust thresholds — used by both the fresh-run contamination guard and the resume
  // path's dust normalization so a 1-wei transfer to the swapper can't DoS either path.
  const [lpDust, assetDecimalsRaw, collateralDecimals] = await Promise.all([
    vault.getLpDust(),
    vault.getAssetDecimals(),
    tokenDecimals(collateralToken),
  ]);
  const assetDecimals = Number(assetDecimalsRaw);
  const assetScale = 10n ** BigInt(assetDecimals);
  const wadScale = 10n ** 18n;
  // Quote-token dust floor: assetScale / QUOTE_DUST_DIVISOR, floored at 1 for pathological
  // <=3-decimal assets. See QUOTE_DUST_DIVISOR at module scope for rationale.
  const quoteDustRaw = assetScale / QUOTE_DUST_DIVISOR;
  const QUOTE_DUST_FLOOR = quoteDustRaw === 0n ? 1n : quoteDustRaw;
  // Collateral floor scales with the collateral token's decimals — see collateralDustFloor.
  const COLLATERAL_DUST_FLOOR = collateralDustFloor(collateralDecimals);

  // Contamination guard: the swapper wallet must hold nothing material to this vault
  // between cycles. If rcv==0 (no recovery in progress) but wallet has material balance,
  // those tokens didn't come from this recovery — the state machine would misread them
  // as recovered/swapped state and sweep them into the vault on the next run.
  const [entryCollateralBal, entryQuoteBal] = await Promise.all([
    balanceOf(collateralToken, wallet),
    balanceOf(quoteToken, wallet),
  ]);
  const quoteIsMaterial = entryQuoteBal >= QUOTE_DUST_FLOOR;
  const collateralIsMaterial = entryCollateralBal >= COLLATERAL_DUST_FLOOR;

  if (rcv === 0n) {
    if (quoteIsMaterial || collateralIsMaterial) {
      log.error(
        {
          event: 'recovery_wallet_contaminated',
          ark,
          wallet,
          collateralToken,
          quoteToken,
          entryCollateralBal,
          entryQuoteBal,
          collateralDustFloor: COLLATERAL_DUST_FLOOR,
          quoteDustFloor: QUOTE_DUST_FLOOR,
          quoteIsMaterial,
          collateralIsMaterial,
        },
        'swapper wallet has material pre-existing balance with rcv=0; operator must clear wallet before recovery',
      );
      return false;
    }
    if (entryCollateralBal > 0n || entryQuoteBal > 0n) {
      // Dedup dust warnings so we don't spam if operator hasn't swept yet. Uses a
      // dedicated store so dust entries don't contend with real alerts for LRU slots.
      const dustKey = `dust:${config.chainId}:${target.vaultAddress}`;
      const now = Date.now();
      const lastDust = dustDedupStore.get(dustKey);
      const suppressDust = lastDust != null && now >= lastDust && now - lastDust < target.settings.dedupWindowMs;
      if (!suppressDust) {
        // Simple bounded store — evict oldest entry when at cap.
        if (!dustDedupStore.has(dustKey) && dustDedupStore.size >= DEDUP_STORE_MAX_ENTRIES) {
          const oldest = dustDedupStore.keys().next().value;
          if (oldest !== undefined) dustDedupStore.delete(oldest);
        }
        dustDedupStore.delete(dustKey);
        dustDedupStore.set(dustKey, now);
        log.warn(
          {
            event: 'recovery_wallet_dust',
            ark,
            wallet,
            entryCollateralBal,
            entryQuoteBal,
          },
          'swapper wallet has dust-level balance; operator should sweep',
        );
      }
    }
  }

  // Stage 1: recoverCollateral (if fresh run, rcv == 0)
  if (rcv === 0n) {
    const candidates = await detectRecoverable(vault, {
      includeQuoteEstimate: true,
      minValueWad: target.settings.minRecoveryValueWad,
    });
    if (!candidates) return true;

    const evt = await buildRecoveryRequiredEvent(
      target,
      candidates,
      authPaused,
      rcv,
      poolAddress,
      minBucketIndex,
    );
    if (shouldEmitAlert(evt, target.settings.dedupWindowMs)) {
      log.info({ event: 'collateral_recovery_required', ...evt }, 'collateral recovery required');
    }

    log.info(
      { event: 'recovery_step', step: 'started', ark },
      'recovery started',
    );

    const walletCollateralBefore = await balanceOf(collateralToken, wallet);
    // Ascending-sort bucket indexes before submitting. The vault's array form does not
    // document an ordering requirement, but on-chain merge-style loops often assume
    // ascending; sorted inputs also stabilize replay analysis and match dedupKey's order.
    const sorted = [...candidates].sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
    const indexes = sorted.map((c) => c.index);
    const amts = sorted.map((c) => c.estimatedCollateralWad);

    const gas = await getGasWithBuffer(
      'vault',
      'recoverCollateral',
      [indexes, amts],
      target.vaultAddress,
    );
    // Concurrency guard (plan's layer 3): re-read rcv immediately before submitting.
    // The contract's recoverCollateral only checks AUTH.paused(), NOT rcv, so two
    // processes can both send recoverCollateral if we don't pre-check here. If another
    // process beat us to it, rcv > 0 at this point — bail instead of double-recovering.
    const rcvPreWrite = await vault.getRemovedCollateralValue();
    if (rcvPreWrite !== 0n) {
      log.error(
        {
          event: 'recovery_state_mismatch',
          ark,
          expected: 0n,
          observed: rcvPreWrite,
        },
        'rcv changed between preflight and recoverCollateral submission; another process may be recovering',
      );
      return false;
    }
    const receipt = await handleRecoveryTx(vault.recoverCollateral(indexes, amts, gas), {
      action: 'recoverCollateral',
      ark,
    });
    if (!receipt) return false;

    const walletCollateralAfter = await balanceOf(collateralToken, wallet);
    const actualRecovered = walletCollateralAfter - walletCollateralBefore;
    const logs = parseRecoverCollateralLogs(receipt);
    log.info(
      {
        event: 'recovery_recovered_collateral',
        ark,
        actualRecoveredCollateral: actualRecovered,
        perBucket: logs,
      },
      'recoverCollateral succeeded',
    );
  } else {
    // Resume path: stage derived from chain state + wallet balances.
    // Normalize against dust thresholds first — an attacker can send 1 wei of quote to
    // the swapper between runs to flip a legitimate RECOVERED stage into
    // PARTIAL_SWAP_AMBIGUOUS and halt recovery. Treat dust as zero for stage derivation.
    const [walletCollateralRaw, walletQuoteRaw] = await Promise.all([
      balanceOf(collateralToken, wallet),
      balanceOf(quoteToken, wallet),
    ]);
    const walletCollateralBal =
      walletCollateralRaw >= COLLATERAL_DUST_FLOOR ? walletCollateralRaw : 0n;
    // Same asset-unit floor as the contamination guard — keep resume normalization and
    // entry normalization symmetric so a value that's "dust" on entry stays "dust" on resume.
    const walletQuoteBal = walletQuoteRaw >= QUOTE_DUST_FLOOR ? walletQuoteRaw : 0n;
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
        ark,
        stage,
        walletCollateralBal,
        walletQuoteBal,
        walletCollateralRaw,
        walletQuoteRaw,
      },
      'resuming recovery from derived stage',
    );
    if (stage === 'PARTIAL_SWAP_AMBIGUOUS' || stage === 'NO_BALANCE') {
      log.error(
        { event: 'recovery_state_mismatch', ark, stage },
        'operator attention required',
      );
      return false;
    }
  }

  // Resolve refill bucket. minBucketIndex already fetched in the upfront Promise.all.
  // _validDestination in AjnaVaultLibrary reverts BucketIndexTooLow if refillBucket is
  // below minBucketIndex — catch it pre-flight after collateral is already recovered.
  const refillBucket = target.settings.refillBucketOverride ?? minBucketIndex;
  if (refillBucket < minBucketIndex) {
    log.error(
      {
        event: 'recovery_refill_bucket_override_invalid',
        ark,
        refillBucketOverride: target.settings.refillBucketOverride,
        minBucketIndex,
      },
      'refillBucketOverride is below AUTH.minBucketIndex; would revert on-chain',
    );
    return false;
  }

  // The vault's rcv is the quote-denominated WAD value of the recovered collateral at
  // the bucket's sell price. That's what the vault is owed and what the swap must produce
  // to keep the vault whole. Using rcv as the floor (not a vault-LP projection) aligns the
  // slippage guard with the actual debt.
  const rcvAtSwapTime = rcv === 0n ? await vault.getRemovedCollateralValue() : rcv;

  // Stage 2: swap (if wallet still holds material collateral). Dust-level balances
  // don't justify a swap round-trip; they'd quote/execute for near-nothing and fail.
  const walletCollateralBal = await balanceOf(collateralToken, wallet);
  if (walletCollateralBal >= COLLATERAL_DUST_FLOOR) {
    // Resume-path probe: a fresh run was already probed in preflight, but a resume
    // (rcv > 0) skips that so a swap-free SWAPPED resume can refill without an
    // adapter. This path DOES need the executor — validate before approving anything.
    try {
      swapExecutor.getSpender(collateralToken);
    } catch (err) {
      log.error(
        {
          event: 'recovery_blocked_swap_executor',
          ark,
          err: abridgedViemError(err),
        },
        'swap executor unavailable; collateral held in wallet needs a swap to proceed',
      );
      return false;
    }

    const chainId = config.chainId;
    const buildQuoteReq = (): SwapQuoteRequest => ({
      chainId,
      tokenIn: collateralToken,
      tokenOut: quoteToken,
      amountIn: walletCollateralBal,
      maxSlippageBps: target.settings.maxSlippageBps,
      maxValueLossBps: target.settings.maxValueLossBps,
      expectedQuoteOut: rcvAtSwapTime,
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
          ark,
          err: abridgedViemError(err),
        },
        'swap quote failed',
      );
      return false;
    }
    log.info(
      {
        event: 'recovery_step',
        step: 'swap_quoted',
        ark,
        rcvAtSwapTime,
        quote,
      },
      'swap quoted',
    );

    // Approve the adapter's spender (exact amount, reset if stale). The previous version
    // approved `wallet` itself — a no-op that granted nothing to anyone and burned gas
    // writing a storage slot. The SwapExecutor interface now requires adapters to expose
    // their real spender; UnconfiguredSwapExecutor throws, so we never silently self-approve.
    // NOTE: infinite approvals avoided per TODOS.md approval-lifecycle policy.
    const spender = swapExecutor.getSpender(collateralToken);
    if (spender.toLowerCase() === wallet.toLowerCase()) {
      log.error(
        {
          event: 'recovery_swap_failed',
          reason: 'invalid_spender',
          ark,
          spender,
          wallet,
        },
        'SwapExecutor.getSpender returned the bot wallet; self-approval is a no-op, adapter is misconfigured',
      );
      return false;
    }
    await approveExact(collateralToken, spender, walletCollateralBal);

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
          ark,
          err: abridgedViemError(err),
        },
        'swap execute failed',
      );
      return false;
    }
    const walletQuoteAfter = await balanceOf(quoteToken, wallet);
    const actualAmountOut = walletQuoteAfter - walletQuoteBefore;

    // Convert the swap output to WAD so it compares apples-to-apples with rcv.
    const actualAmountOutWad = (actualAmountOut * wadScale) / assetScale;
    const minAcceptableWad =
      (rcvAtSwapTime * BigInt(10000 - target.settings.maxValueLossBps)) / 10000n;
    if (actualAmountOutWad < minAcceptableWad) {
      log.error(
        {
          event: 'recovery_swap_value_loss_exceeded',
          ark,
          rcvAtSwapTime,
          actualAmountOut,
          actualAmountOutWad,
          maxValueLossBps: target.settings.maxValueLossBps,
          minAcceptableWad,
          swapResult,
        },
        'swap output below vault-debt threshold, halting',
      );
      return false;
    }

    log.info(
      {
        event: 'recovery_swap_executed',
        ark,
        actualAmountOut,
        actualAmountOutWad,
        rcvAtSwapTime,
        txHash: swapResult.txHash,
        routeId: swapResult.routeId,
      },
      'swap executed',
    );
  }

  // Stage 3: refill bucket pre-check + returnQuoteToken
  // walletQuoteBalFinal is in ASSET decimals (from ERC20.balanceOf).
  // The vault's returnQuoteToken treats _amt as WAD and internally calls
  // _convertWadToAsset(_amt) to pull that many asset units. We must therefore
  // pass WAD to the contract while approving in asset decimals (approveExact is
  // an ERC20 call, which is asset-dec). LP_DUST is also WAD.
  const walletQuoteBalFinal = await balanceOf(quoteToken, wallet);
  const walletQuoteBalFinalWad = (walletQuoteBalFinal * wadScale) / assetScale;
  const [{ lps: refillLps, collateral: refillCollateral, bankruptcyTime: refillBankruptcyTime }, vaultRefillLps] =
    await Promise.all([
      vault.getBucketDetails(refillBucket),
      vault.getVaultLps(refillBucket),
    ]);

  // bankruptcyTime is a chain timestamp, so the recency comparison must use chain
  // time too — wall clock drifts from block time (and test chains manipulate it),
  // which is why arkKeeper's bankruptcy gate uses getChainTime as well.
  let nowSec: bigint;
  try {
    nowSec = await getChainTime();
  } catch (err) {
    if (!(err instanceof ChainTimeUnavailableError)) throw err;
    log.error(
      {
        event: 'recovery_refill_failed',
        reason: 'chain_time_unavailable',
        ark,
        refillBucket,
        err: abridgedViemError(err),
      },
      'refill pre-check failed: chain time unavailable',
    );
    return false;
  }

  const precheck = refillPrecheck({
    amountWad: walletQuoteBalFinalWad,
    vaultRefillLps,
    bucketLps: refillLps,
    bucketCollateral: refillCollateral,
    bankruptcyTime: refillBankruptcyTime,
    nowSec,
    minTimeSinceBankruptcy: target.settings.minTimeSinceBankruptcy,
    lpDust,
    minLpMintedBps: target.settings.minLpMintedBps,
  });
  if (!precheck.ok) {
    log.error(
      {
        event: 'recovery_refill_failed',
        reason: precheck.reason,
        ark,
        refillBucket,
        walletQuoteBal: walletQuoteBalFinal,
        walletQuoteBalFinalWad,
        ...precheck.detail,
      },
      `refill pre-check failed: ${precheck.reason}`,
    );
    return false;
  }

  // Bucket health proxy: only meaningful for pure-quote buckets. For a pure-quote
  // bucket, 1 LP ≈ 1 quote (plus accrued interest), so lpToQuoteTokens(X) should return
  // >= X. Below minLpMintedBps indicates bankruptcy residue or other LP impairment.
  //
  // For MIXED buckets (non-zero collateral), lpToQuoteTokens(X) legitimately returns
  // less than X — the LP represents a claim on both quote AND collateral, so the
  // quote-redeemable portion is < X even in a perfectly healthy bucket. Skip the check
  // in that case to avoid false-positive halts. The bucket's bankruptcy state and
  // LP_DUST / BucketLPDangerous guards already cover the main safety cases.
  if (refillCollateral === 0n && walletQuoteBalFinalWad > 0n) {
    const roundTripQuote = await vault.lpToQuoteTokens(refillBucket, walletQuoteBalFinalWad);
    if (roundTripQuote > 0n) {
      const healthBps = (roundTripQuote * 10000n) / walletQuoteBalFinalWad;
      if (healthBps < BigInt(target.settings.minLpMintedBps)) {
        log.error(
          {
            event: 'recovery_refill_failed',
            reason: 'poor_exchange_rate',
            ark,
            refillBucket,
            walletQuoteBal: walletQuoteBalFinal,
            roundTripQuote,
            healthBps,
            minLpMintedBps: target.settings.minLpMintedBps,
          },
          'refill bucket health below minLpMintedBps threshold',
        );
        return false;
      }
    }
  }

  // Approve quote to vault (asset decimals — ERC20.transferFrom semantic).
  await approveExact(quoteToken, target.vaultAddress, walletQuoteBalFinal);

  log.info(
    {
      event: 'recovery_step',
      step: 'refill_started',
      ark,
      refillBucket,
      amountAsset: walletQuoteBalFinal,
      amountWad: walletQuoteBalFinalWad,
    },
    'refill started',
  );

  // Contract treats the _amt argument as WAD and pulls _convertWadToAsset(_amt) asset units.
  const refillGas = await getGasWithBuffer(
    'vault',
    'returnQuoteToken',
    [refillBucket, walletQuoteBalFinalWad],
    target.vaultAddress,
  );
  const refillReceipt = await handleRecoveryTx(
    vault.returnQuoteToken(refillBucket, walletQuoteBalFinalWad, refillGas),
    {
      action: 'returnQuoteToken',
      ark,
    },
  );

  if (!refillReceipt) {
    log.error(
      {
        event: 'recovery_refill_failed',
        reason: 'revert',
        ark,
        refillBucket,
      },
      'returnQuoteToken reverted',
    );
    return false;
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
      ark,
      adminPausePending: authPausedAfter,
      removedCollateralValue: rcvAfter,
      walletCollateralBalance: walletCollateralAfter,
      walletQuoteBalance: walletQuoteAfter,
      refillBucketIndex: refillBucket,
      lpMintedDelta: returnLog?.lps ?? null,
    },
    'recovery complete',
  );
  return true;
}

// ============= Helpers =============

async function buildRecoveryRequiredEvent(
  target: ArkTarget,
  candidates: RecoverableBucket[],
  authPaused: boolean,
  rcv: bigint,
  poolAddress: Address,
  minBucketIndex: bigint,
): Promise<RecoveryRequiredEvent> {
  const vaultEffectivePaused = authPaused || rcv > 0n;
  const proposedRefillBucket = target.settings.refillBucketOverride ?? minBucketIndex;
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

async function balanceOf(token: Address, owner: Address): Promise<bigint> {
  return (await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint;
}

async function tokenDecimals(token: Address): Promise<number> {
  return Number(
    await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'decimals',
    }),
  );
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
    // Context must reach wait(): its LUPBelowHTP branch reads context.ark to call
    // haltKeeper, which is what makes the isHalted guard at the top of runExecute
    // actually stop the next tick from resubmitting a doomed tx.
    return await wait(hash, context);
  } catch (err) {
    log.error(
      { event: 'recovery_tx_failed', ...context, err: abridgedViemError(err) },
      `recovery tx failed: ${context.action}`,
    );
    return null;
  }
}

// Exposed for tests only: handleRecoveryTx is module-private plumbing, but the
// context pass-through above is load-bearing (halt wiring) and needs a regression test.
export const _handleRecoveryTxForTests = handleRecoveryTx;

// ============= Config helpers for scheduler =============

export function getRecoveryTargets(): ArkTarget[] {
  return config.arks.map((ark) => ({
    vaultAddress: ark.vaultAddress,
    vaultAuthAddress: ark.vaultAuthAddress,
    settings: resolveRecoverySettings(ark),
  }));
}
