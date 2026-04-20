# Ark Vault Collateral Recovery Bot — Implementation Plan

Status: approved for implementation
Date: 2026-04-19
Supersedes: `ARK_VAULT_COLLATERAL_RECOVERY_BOT_SPEC.md` (2026-04-06, proposed)
Repo: `4626-ajna-vault-keeper`
Target implementation: `../eb-vault-fork/4626-ajna-vault-keeper`

## Purpose

This document defines how the existing Ajna vault keepers and the new collateral recovery flow should work together in production when an Ark Vault winds up holding collateral in a lender bucket after liquidation activity.

This is not a generic "run a script when things break" design. The goal is a boring, resumable operational system that:

- keeps `arkKeeper` simple
- handles the collateral edge case without manual vault pausing
- makes recovery restart-safe from on-chain truth alone
- uses least-privilege wallets
- reuses Bot 1 swap logic instead of forking a second swap stack
- provides safe concurrency guarantees under the existing scheduler model

This plan targets the forked keeper architecture in `../eb-vault-fork/4626-ajna-vault-keeper`, which already has:

- a multi-ark scheduler
- separate `arkKeeper` and `metavaultKeeper`
- a shared `createVault(...)` abstraction in `src/ark/vault.ts`
- JSON config via `config.json` and `src/utils/config.ts`

## Terminology: "Bot 1" / "Bot 3"

The "Bot N" naming refers to the team's internal taxonomy of automated systems. The numbering is external to this repo, so this section exists to anchor the names for anyone reading the plan without that team context.

- **Bot 1** — External swap adapter. Pre-existing system maintained in a separate repo. Responsible for DEX routing, quote generation, slippage enforcement, and swap execution. Used across multiple bots in the team's ecosystem. This recovery bot consumes Bot 1 via a narrow TypeScript interface (`SwapExecutor`) rather than forking its own swap stack.
- **Bot 2** — [Fill in what Bot 2 is in your taxonomy, or delete this bullet if it doesn't exist.]
- **Bot 3** — The collateral recovery keeper defined in this document. Lives in this repo (`4626-ajna-vault-keeper`). Owns the vault-side recovery state machine (detect → recover → swap → refill → reconcile) and calls Bot 1 for the swap step.

The separation between Bot 1 and Bot 3 is deliberate: Bot 1 owns swap logic, Bot 3 owns vault logic, neither owns the other's state machine. The `SwapExecutor` interface is the contract between them. Concretely this means:

- Bot 1 can change DEXes, routing strategies, and MEV protection without touching Bot 3
- Bot 3 can change vault detection, state machine, or pre-checks without touching Bot 1
- Each can be tested and deployed independently
- Bot 3 tests against a mock `SwapExecutor` without needing Bot 1's infrastructure
- A bug in one has a bounded blast radius in the other

Throughout this document, "Bot 1" and "swap adapter" are interchangeable; "Bot 3" and "recoveryKeeper" are interchangeable.

## Problem

When an Ajna liquidation converts part of the vault's lender position into collateral, the vault is no longer holding only quote token value in the way the normal keeper expects.

The existing keeper logic in the fork is designed around quote-token bucket movement and buffer management. It should not try to recover collateral inline. That is a different state machine, with different permissions and different failure modes.

## Contract Truths

These points are the operational source of truth, verified against the pinned submodule at `lib/4626-ajna-vault@bd09f3d`:

- `recoverCollateral(uint256[] memory _fromIndexes, uint256[] memory _amts)` requires admin-or-swapper and reverts if `AUTH.paused()` is already `true`.
- `returnQuoteToken(uint256 _toIndex, uint256 _amt)` requires the vault to be paused.
- `paused()` is `AUTH.paused() || removedCollateralValue > 0` (compound — not just `VaultAuth.paused()`).
- `recoverCollateral(...)` transfers recovered collateral out to the caller (swapper wallet).
- `returnQuoteToken(...)` resets `removedCollateralValue = 0` before depositing quote back into the pool.
- `LP_DUST = max(1e18 / 10**assetDecimals, 1_000_000 + 1)`.
- `removedCollateralValue` is a `public uint256` state variable (auto-getter).
- `AUTH` is a `public immutable IVaultAuth` reference (auto-getter returns the VaultAuth address).

Sources (pinned commit `bd09f3d150f0baed29ad365fe9ce9d8ca3cd1152`):

- `Vault.sol` line 325: `recoverCollateral(uint256[], uint256[])`
- `Vault.sol` lines 35, 46: `AUTH`, `removedCollateralValue`
- `Vault.sol` lines 388-393: compound `paused()` formula
- `AjnaVaultLibrary.sol`
- `VaultAuth.sol`

### Operational consequence

Do **not** manually admin-pause the vault before calling `recoverCollateral`.

Why:
- admin pause blocks `recoverCollateral`
- `recoverCollateral` itself creates the recovery-paused state through `removedCollateralValue > 0`
- `returnQuoteToken` is meant to complete while recovery-paused

Two different pause states:

```
Admin pause:
  AUTH.paused() == true
  -> blocks new recoverCollateral

Recovery pause:
  removedCollateralValue > 0
  -> allows returnQuoteToken
```

The vault's `paused()` function returns `true` if EITHER condition holds. Bot logic must call `AUTH.paused()` directly when it needs to distinguish the two.

## System Overview

Four logical actors:

- `metavaultKeeper`: allocates across arks and buffer
- `arkKeeper`: rebalances each individual ark vault (runs detection preflight only)
- `recoveryKeeper`: the new per-ark collateral recovery runner (detect + execute + resume)
- Bot 1: an external swap executor or swap adapter that turns recovered collateral into quote token

```
               +---------------------------+
               |  Log aggregator / alerting|
               |  (Datadog, Grafana, etc.) |
               +------------+--------------+
                            ^
                            | pino structured events
                            |
 +--------------------+           +------------------------+
 | metavaultKeeper    |           | recoveryKeeper         |
 | allocates by ark   |           | detect / execute/resume|
 +----------+---------+           +-----------+------------+
            |                                 ^
            | skips entire run                | operator triggers
            | when ANY ark is paused          | via BOT_MODE switch
            v                                 |
 +--------------------+           +-----------+------------+
 | arkKeeper          |-----------| shared on-chain truth  |
 | rebalance per ark  |           +-----------+------------+
 +----------+---------+                       |
            | reads / txs                     | recoverCollateral /
            v                                 | returnQuoteToken txs
 +--------------------+           +------------------------+
 | Ark Vault + Pool   |<----------| Bot 1 Swap Adapter     |
 | on-chain state     |           | quoteExactIn / execute |
 +--------------------+           +------------------------+
```

Events are emitted as pino structured logs to stdout. External log aggregators (Datadog, Grafana, etc.) handle alerting and operator paging.

## Role Boundaries

### `arkKeeper`

Responsibilities:
- maintain buffer ratio and bucket placement during normal operation for one ark
- perform a cheap full-bucket collateral check (reads only) before any mutating tx — acts as a bail-out gate
- exit via existing `logRunExit` when collateral is detected, preserving the current `ark_run_aborted` ERROR event taxonomy

Non-responsibilities:
- no collateral withdrawal
- no swap execution
- no quote return
- no manual admin pause or unpause
- no emission of `collateral_recovery_required` — recoveryKeeper is the sole source of that event

### `recoveryKeeper`

Responsibilities:
- detect recoverable collateral positions for one ark (duplicates arkKeeper's preflight but with fuller context)
- own the recovery state machine
- resume safely after a crash by deriving stage from on-chain truth + wallet balance deltas
- call the Bot 1 swap adapter
- enforce vault-value loss threshold independently of DEX slippage
- perform refill bucket pre-check (dust + bankruptcy + exchange rate)
- complete quote return to the vault
- reconcile accounting on completion (rcv=0, AUTH.paused, wallet balances)
- emit precise alerts with in-memory deduplication

Non-responsibilities:
- no normal quote rebalance logic
- no governance or admin parameter changes

### Bot 1 swap adapter

Responsibilities:
- quote expected output for a collateral-to-quote swap
- enforce minimum output and slippage constraints at the DEX level
- execute the swap respecting `recipient`, `deadline`, and `routeId` for idempotency
- return exact output and receipt data (including `recipient`) to the recovery bot
- handle MEV-safe mempool submission (flashbots / private relay) as operator responsibility

Non-responsibilities:
- no vault-specific pause logic
- no bucket selection
- no `returnQuoteToken` logic
- no enforcement of vault-value loss (that is Bot 3's job)

### `metavaultKeeper`

Responsibilities:
- rebalance across configured arks and buffer
- halt entire run when ANY ark is paused (existing behavior; see Coordination Model)

Non-responsibilities:
- no collateral detection
- no recovery execution
- no swap execution

## Coordination Model

### `arkKeeper` and `recoveryKeeper`

Ark keeper and recovery keeper are NOT directly coordinated. They independently derive behavior from on-chain state:

- arkKeeper calls `detectRecoverable(vault)` (from `src/ark/recovery.ts`) as a bail-out gate. On positive detection, it exits via existing `logRunExit` — emitting the familiar `ark_run_aborted` ERROR log. It does NOT emit `collateral_recovery_required`.
- recoveryKeeper calls the SAME `detectRecoverable(vault)` function. On positive detection, it emits `collateral_recovery_required` (subject to in-memory dedup) and, in auto / oneshot modes, proceeds to execute.

Both read the same chain state via the same helper, so detection is consistent. Event emission is single-sourced in recoveryKeeper, eliminating cross-process dup-alerting.

Operator trigger for semi-auto execution is a separate invocation of `BOT_MODE=recovery-oneshot`.

The recovery role MUST live as a separate runner and separate state machine dispatched by `BOT_MODE`. Do not bury recovery into `arkRun(...)`.

**Resilience:** because both detection paths are pure functions of on-chain state with no local persistence, any recoveryKeeper outage is self-healing — when the process comes back online, detection re-derives the same condition from chain state and fresh dedup state causes it to re-emit. Additionally, arkKeeper's `ark_run_aborted` ERROR log fires on every tick while collateral is present in any vault bucket, providing a backstop alert even when recoveryKeeper is down, broken, or not yet deployed. Operators should wire log-aggregator alerting to match `event: 'ark_run_aborted'` with reason containing `'collateral'` for N consecutive cycles as a safety net.

### `metavaultKeeper` interaction

The fork already skips ALL allocation when any ark is paused. This is preserved as the top-level coordination rule:
- when an ark enters recovery-pause, `metavaultKeeper` halts its entire run for that cycle
- recovery completes against the paused ark
- normal metavault allocation resumes once the ark's `paused()` returns false

This means ark pause is the inter-keeper coordination mechanism; no separate global lock is introduced.

Tradeoff: while an ark is in recovery (auto mode: minutes; semi-auto: potentially hours), the metavault halts reallocation across all arks. For the current realistic recovery frequency and duration, this yield drag is accepted. If production data later shows it matters, per-ark skip math lives in `TODOS.md` as a future optimization.

### Detection rule

The ark keeper performs a cheap, read-only preflight BEFORE any mutating tx (updateInterest, drain). Detection must scan all vault-held buckets, not just the optimal bucket.

```
# Ordered early in arkRun, right after isPaused + poolHasBadDebt checks
async function collateralPreflight(vault) {
    buckets = await vault.getBuckets()    // Promise.all batchable

    lpResults = await Promise.all(
        buckets.map(b => vault.getVaultLps(b))   // pool.lenderInfo(b, vaultAddr)[0]
    )

    bucketsWithLp = buckets.filter((b, i) => lpResults[i] > 0)
    if (bucketsWithLp.length === 0) return null

    collateralResults = await Promise.all(
        bucketsWithLp.map((b, i) => vault.lpToCollateral(b, lpResults[i]))
    )

    candidates = bucketsWithLp
        .map((b, i) => ({ index: b, vaultLps: lpResults[i], estimatedCollateralWad: collateralResults[i] }))
        .filter(c => c.estimatedCollateralWad > 0)

    return candidates.length > 0 ? candidates : null
}
```

Edge cases (handled naturally):
- **Bankruptcy buckets:** `lpToCollateral` returns 0 (bankruptcy zeroed LP value); excluded.
- **Pure quote buckets:** `lpToCollateral` returns 0 (no collateral to recover); excluded.
- **Rounding:** down; underestimates but does not produce false positives.

`vault.getBuckets()` is trusted as the authoritative bucket set for liquidation recovery. Ajna liquidation converts LP TYPE within already-tracked buckets; it does not create new untracked buckets. Migration / legacy bucket state is explicitly out of scope (see `TODOS.md` entry).

Do not let the ark keeper "discover" collateral by trying rebalance txs and failing — that is noisy and ambiguous.

## Bot-to-Bot Interface

### 1. `recoveryKeeper` → operator (via structured logs)

Event name: `collateral_recovery_required`

Emitted exclusively by recoveryKeeper when detection finds vault-held collateral. Consumed by the log aggregator / alerting pipeline. arkKeeper does NOT emit this event; its collateral bail-out uses the existing `ark_run_aborted` error log instead.

Payload:

```ts
type RecoveryRequiredEvent = {
  chainId: number;
  arkAddress: `0x${string}`;
  vaultAddress: `0x${string}`;
  vaultAuthAddress: `0x${string}`;
  poolAddress: `0x${string}`;
  detectedAt: string;                    // ISO 8601
  reason: 'vault_bucket_collateral_detected';
  buckets: Array<{
    index: bigint;
    vaultLps: bigint;
    estimatedCollateralWad: bigint;
    estimatedQuoteValueWad?: bigint;     // via poolInfoUtils.lpToQuoteTokens
  }>;
  proposedRefillBucket?: bigint;
  vaultEffectivePaused: boolean;         // vault.paused() (compound)
  authPaused: boolean;                   // AUTH.paused() (admin only)
  removedCollateralValue: bigint;
};
```

Semantics:
- Emitted every time a fresh recovery condition is detected, subject to in-memory dedup (see below)
- The payload distinguishes `vaultEffectivePaused` (compound) from `authPaused` (admin only) to eliminate the previous `paused` field ambiguity

### Event deduplication

Deduplication lives inside `recoveryKeeper` in memory:

```ts
// recoveryKeeper internal state
const dedupStore = new Map<string, number>();   // dedupKey → lastEmittedAt (unix ms)

function dedupKey(evt) {
    return `${evt.chainId}:${evt.arkAddress}:${evt.buckets.map(b => b.index).sort().join(',')}`;
}

function shouldEmit(evt, windowMs) {
    const k = dedupKey(evt);
    const last = dedupStore.get(k);
    if (last && Date.now() - last < windowMs) return false;
    dedupStore.set(k, Date.now());
    return true;
}
```

Config: `recovery.dedupWindowMs` (default 3_600_000 = 1h).

### 2. `recoveryKeeper` → Bot 1 swap adapter

Narrow TypeScript interface so Bot 3 can reuse Bot 1 logic without importing Bot 1's operational model. Hardened for crash-safety and independent value-loss enforcement:

```ts
type SwapQuoteRequest = {
  chainId: number;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  maxSlippageBps: number;          // DEX slippage tolerance
  maxValueLossBps: number;         // additional vault-value loss threshold (Bot 3 enforces)
  expectedQuoteOut: bigint;        // from poolInfoUtils.lpToQuoteTokens
  recipient: `0x${string}`;        // must be the recovery wallet
  deadline: bigint;                // unix timestamp
};

type SwapQuoteResult = {
  expectedAmountOut: bigint;
  minAmountOut: bigint;
  routeId: string;                 // correlation key for retry detection
  validUntil: bigint;
};

type SwapExecutionResult = {
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  txHash: `0x${string}`;
  routeId: string;
  recipient: `0x${string}`;
};

interface SwapExecutor {
  quoteExactIn(input: SwapQuoteRequest): Promise<SwapQuoteResult>;
  executeExactIn(input: SwapQuoteRequest & { priorTxHash?: `0x${string}` }): Promise<SwapExecutionResult>;
}
```

Bot 3 responsibilities around the swap:
- Snapshot `walletBalanceBefore = ERC20(tokenIn).balanceOf(recovery wallet)` AND `walletQuoteBefore = ERC20(tokenOut).balanceOf(recovery wallet)` immediately before `executeExactIn`
- Pass `expectedQuoteOut = poolInfoUtils.lpToQuoteTokens(pool, totalVaultLps, refillBucketIndex)`
- After `executeExactIn`, compute `actualAmountOut = ERC20(tokenOut).balanceOf(recovery wallet) - walletQuoteBefore`
- If `actualAmountOut < expectedQuoteOut * (10000 - maxValueLossBps) / 10000`, emit `recovery_swap_value_loss_exceeded` and HALT (do not proceed to returnQuoteToken with the under-valued output)
- Use `actualAmountOut` (not swap receipt's `amountOut`) as the return amount — fee-on-transfer tokens may report higher than delivered
- If the swap transaction is resubmitted on retry, pass the `priorTxHash` so Bot 1 can correlate; adapter returns existing result instead of executing a second swap

MEV-safe mempool submission (flashbots / private relay) is Bot 1's responsibility. Bot 3 enforces constraints; Bot 1 handles routing.

Rule:
- Bot 3 owns vault logic and constraints
- Bot 1 owns swap execution and routing
- Neither owns the other's state machine

## Recovery State Machine

The recovery bot derives its stage from on-chain truth + recovery-wallet balances. No local checkpoint file is used.

```
IDLE
  -> DETECTING
  -> READY_TO_EXECUTE
  -> RECOVERING_COLLATERAL
  -> SWAPPING_TO_QUOTE
  -> REFILLING_BUCKET
  -> COMPLETE
  -> BLOCKED
```

Interpretation rules (derived from `AUTH.paused()`, `removedCollateralValue`, and wallet balances):

| `AUTH.paused()` | `removedCollateralValue` | `walletCollateralBal` | `walletQuoteBal` | Derived state |
|---|---|---|---|---|
| false | 0 | — | — | IDLE → DETECTING |
| false | > 0 | > 0 | 0 | RECOVERED (resume: continue to swap) |
| false | > 0 | 0 | > 0 | SWAPPED (resume: continue to refill) |
| false | > 0 | > 0 | > 0 | PARTIAL_SWAP_AMBIGUOUS (operator decides) |
| false | > 0 | 0 | 0 | NO_BALANCE (operator funds wallet or aborts) |
| true | 0 | — | — | BLOCKED_ADMIN_PAUSE |
| true | > 0 | — | — | ADMIN_PAUSED_DURING_RECOVERY (can finish returnQuoteToken) |

## Concurrency

Three layers of defense against races:

1. **In-memory per-ark lock inside recoveryKeeper:**
   ```ts
   const arkLocks = new Map<Address, Promise<void>>();
   async function withArkLock<T>(addr, fn): Promise<T | null> {
       if (arkLocks.has(addr)) return null;           // already running
       const p = fn();
       arkLocks.set(addr, p.then(() => {}, () => {}));
       try { return await p; } finally { arkLocks.delete(addr); }
   }
   ```
   Any second caller while a run is active returns null immediately.

2. **Deployment invariant (documented in README and runbook):** at most one `recovery-auto` replica runs per ark at a time. Orchestrator (k8s, docker-compose, etc.) is responsible for enforcing this.

3. **On-chain guard at critical transitions:** Before calling `recoverCollateral`, re-read `removedCollateralValue`; if non-zero, another process already initiated recovery — bail with `recovery_state_mismatch`. At resume entry (when a run starts with `removedCollateralValue > 0`), derive stage from the state table before sending any tx. No speculative transactions; every mutating call is preceded by a state read that confirms the expected pre-condition.

## Planned Recovery Flow

### Detect mode (BOT_MODE=recovery-detect, continuous)

1. For each configured ark:
   1. Acquire ark lock (skip if held)
   2. Run collateral preflight (see Detection Rule above)
   3. If candidates found: build `RecoveryRequiredEvent`, apply dedup check, emit if fresh
4. Sleep `keeper.intervalMs`, repeat

Wallet: NOT required (RPC-only). `env.ts` must relax its current requirement for this mode.

### Execute mode (BOT_MODE=recovery-auto, continuous, OR BOT_MODE=recovery-oneshot, single pass)

For each configured ark:

1. Acquire ark lock (skip if held)
2. **Preflight:** read `authPaused`, `removedCollateralValue`, wallet balances
3. **Blocked-admin-pause check:** if `authPaused == true` and `removedCollateralValue == 0`, emit `recovery_blocked_admin_pause` and return
4. **Recovery stage (if `removedCollateralValue == 0`):**
   1. Run detection preflight; if no candidates, return (no-op)
   2. Emit `recovery_step` (step: `'started'`)
   3. Snapshot wallet collateral balance before
   4. Call `recoverCollateral(indexes[], amts[])` with gas buffer; await receipt
   5. Compute `actualRecoveredCollateral = walletCollateralAfter - walletCollateralBefore`
   6. Emit `recovery_recovered_collateral` with actual amount
5. **Swap stage:**
   1. Read collateral token address from `pool.collateralAddress()` (via vault wrapper)
   2. Compute `expectedQuoteOut = poolInfoUtils.lpToQuoteTokens(pool, totalVaultLps, refillBucketIndex)`
   3. Call `swapExecutor.quoteExactIn(...)`, enforcing `minAmountOut` and passing `maxValueLossBps` + `expectedQuoteOut`
   4. Emit `recovery_step` (step: `'swap_quoted'`)
   5. Approve collateral to swap adapter (exact amount, reset-to-zero if stale — see TODOS.md)
   6. Snapshot wallet quote balance before
   7. Call `swapExecutor.executeExactIn(...)` with `deadline` and `routeId`
   8. On revert / deadline / min-out failure: emit `recovery_swap_failed` with `reason` and HALT
   9. Compute `actualAmountOut = walletQuoteAfter - walletQuoteBefore`
   10. If `actualAmountOut < expectedQuoteOut * (10000 - maxValueLossBps) / 10000`: emit `recovery_swap_value_loss_exceeded` and HALT
   11. Emit `recovery_swap_executed` with `actualAmountOut`
6. **Refill bucket pre-check:**
   1. Determine `refillBucket = ark.recovery?.refillBucketOverride ?? vaultAuth.minBucketIndex()`
   2. Read `bucketInfo(refillBucket)` and `vault.LP_DUST()`
   3. If `bankruptcyTime > 0 AND (now - bankruptcyTime < arkGlobal.minTimeSinceBankruptcy)`: emit `recovery_refill_failed` (reason: `'recently_bankrupt'`) and HALT
   4. If `bucketInfo.lps == 0 AND actualAmountOut < LP_DUST`: emit `recovery_refill_failed` (reason: `'below_dust'`) and HALT (operator funds recovery wallet, bot resumes)
   5. If `actualAmountOut / expected_lp_minted < recovery.minLpMintedBps`: emit `recovery_refill_failed` (reason: `'poor_exchange_rate'`) and HALT
7. **Refill stage:**
   1. Approve quote token to vault (exact amount, reset-to-zero if stale)
   2. Emit `recovery_step` (step: `'refill_started'`)
   3. Call `returnQuoteToken(refillBucket, actualAmountOut)` with gas buffer
   4. On revert: emit `recovery_refill_failed` (reason: `'revert'`) with decoded error
8. **Accounting reconciliation (after refill succeeds):**
   1. Read `removedCollateralValue` (should be 0)
   2. Read `authPaused`
   3. Read wallet collateral + quote balances
   4. Compute `lpMintedDelta` from receipt events
   5. Emit `recovery_completed` with `adminPausePending: authPaused` and full reconciliation payload

### Resume mode (implicit in Execute mode)

If the bot restarts with `removedCollateralValue > 0`, the state table above tells execute-mode which stage to resume at based on wallet balances. No explicit resume mode — it's just execute-mode with the recovery stage skipped when `removedCollateralValue != 0`.

## Refill Bucket Pre-check (combined)

Default refill bucket: `vaultAuth.minBucketIndex()`. Per-ark override: `ArkConfig.recovery.refillBucketOverride`.

Rationale for default:
- Already an admin-controlled low bucket boundary
- Avoids inventing a second "very low bucket" policy surface
- Smallest diff from existing vault policy

Pre-check gates (applied in order before `returnQuoteToken`, all share the `recovery_refill_failed` event with distinct `reason` values):
1. Not admin-paused (defensive; state machine should already have prevented reaching this point)
2. Not recently bankrupt (`bankruptcyTime > 0` AND `now - bankruptcyTime < arkGlobal.minTimeSinceBankruptcy`) → `reason: 'recently_bankrupt'`
3. Not below dust on empty bucket (`bucketInfo.lps == 0 AND amount < LP_DUST`) → `reason: 'below_dust'`
4. Exchange rate produces meaningful LP (`actualAmountOut / expected_lp_minted >= recovery.minLpMintedBps`) → `reason: 'poor_exchange_rate'`

Each gate halts the flow. One alert event, four reason codes (including `'revert'` for any other returnQuoteToken failure).

## Operator Runbooks

### 1. Normal operations

- `metavaultKeeper` runs on schedule (BOT_MODE=scheduler)
- `arkKeeper` runs on schedule for each configured ark (BOT_MODE=scheduler)
- `recoveryKeeper` runs detect mode on a similar or slightly faster interval (BOT_MODE=recovery-detect, separate deployment)
- No operator action required

### 2. Recovery required, semi-auto mode

1. `recoveryKeeper` (BOT_MODE=recovery-detect) emits `collateral_recovery_required` via structured log. `arkKeeper` in the scheduler deployment independently bails with `ark_run_aborted` ERROR (backstop — fires even if recoveryKeeper is down).
2. Log aggregator fires an alert to on-call
3. Operator reviews event payload:
   - bucket indexes
   - estimated collateral per bucket
   - expected quote out
   - proposed refill bucket
   - `authPaused` / `removedCollateralValue`
4. Operator triggers recovery execution by invoking `BOT_MODE=recovery-oneshot` (via cron, manual command, or CI job)
5. `recoveryKeeper` runs end-to-end for configured arks once and exits
6. `arkKeeper` resumes on next tick automatically
7. `metavaultKeeper` resumes normal allocation once the ark is no longer paused

### 3. Recovery required, full-auto mode

1. `recoveryKeeper` (BOT_MODE=recovery-auto, continuous) detects collateral, emits `collateral_recovery_required`, and auto-executes if preflight passes
2. `arkKeeper` in the scheduler deployment bails silently with `ark_run_aborted` until the ark is no longer paused
3. Operator is notified only on failure (`recovery_swap_value_loss_exceeded`, `recovery_swap_failed`, `recovery_refill_failed`, `recovery_blocked_admin_pause`, `recovery_state_mismatch`) or completion (`recovery_completed` — check `adminPausePending` field)

### 4. Manual admin pause is active before recovery

Condition:
- `AUTH.paused() == true`
- `removedCollateralValue == 0`

Action:
- `recoveryKeeper` emits `recovery_blocked_admin_pause`
- Operator decides whether to unpause and rerun recovery

Do not auto-unpause.

### 5. Recovery bot crashes mid-run

Condition:
- `removedCollateralValue > 0`

Action:
- `recoveryKeeper` resumes from chain truth and wallet balances (per state table)
- Operator only intervenes if balances don't match any expected stage or swap retries exceed threshold

### 6. `returnQuoteToken(...)` fails

Action:
- `recovery_refill_failed` fires with a `reason` field:
  - `'below_dust'` — pre-check caught dust amount on empty bucket (operator funds recovery wallet to top up)
  - `'recently_bankrupt'` — pre-check caught bankruptcy state on target bucket (operator picks a different bucket via `refillBucketOverride`)
  - `'poor_exchange_rate'` — pre-check caught impaired bucket (operator picks a different bucket)
  - `'revert'` — returnQuoteToken reverted for unknown reason (decoded error in payload; operator investigates)
- Vault remains paused via `removedCollateralValue > 0`
- Operator reads the `reason` field to decide how to respond

### 7. Swap value loss exceeds threshold

Action:
- `recovery_swap_value_loss_exceeded` emitted before refill attempted
- Collateral is still in the recovery wallet; `removedCollateralValue > 0` means vault is still recovery-paused
- Operator decides whether to lower expectations (raise `maxValueLossBps`) or wait for better market conditions

## Permissions

Wallet split (least-privilege):

| Wallet | Role on-chain | Assigned to |
|---|---|---|
| `keeper` | `AUTH.isAdminOrKeeper` | scheduler / arkKeeper |
| `swapper` | `AUTH.isAdminOrSwapper` | recoveryKeeper (recovery-auto, recovery-oneshot) |
| `admin` | `AUTH.isAdmin` | human only, not loaded in any bot |

BOT_MODE → wallet mapping (loaded by `src/utils/env.ts`):

| BOT_MODE | Required env | Wallet role on-chain |
|---|---|---|
| `scheduler` | `PRIVATE_KEY` or `KEYSTORE_PATH` | keeper |
| `recovery-detect` | none (RPC only) | — |
| `recovery-auto` | `PRIVATE_KEY` or `KEYSTORE_PATH` | swapper |
| `recovery-oneshot` | `PRIVATE_KEY` or `KEYSTORE_PATH` | swapper |

Same env var names across modes. The deployer supplies the appropriate wallet for each deployment: keeper wallet for `scheduler`, swapper wallet for `recovery-auto` / `recovery-oneshot`. Privilege separation is enforced on-chain via `AUTH` role checks, not by env var name.

## Process Model / Entry Points

Single binary with `BOT_MODE` dispatch in `src/index.ts`. Four modes:

| Mode | Description |
|---|---|
| `scheduler` | Existing scheduler tick (metavault + per-ark arkRun). Default. |
| `recovery-detect` | Continuous detection-only loop across configured arks; emits alerts, no txs. |
| `recovery-auto` | Continuous detect + execute loop across configured arks with auto-execute. |
| `recovery-oneshot` | Detect + execute across configured arks for one pass, then exit. Operator trigger for semi-auto mode. |

No new `package.json` scripts. Existing `pnpm start` remains the single entry point; deployments set `BOT_MODE` via container env. README documents the valid values. Mode is an operator / deployment concern, not a script choice.

Dockerfile: retains single `CMD ["node", "dist/index.js"]`; `BOT_MODE` is passed at container invocation time via env. Each deployment (k8s Deployment, docker-compose service, etc.) sets its own `BOT_MODE`.

## Repo Implementation Plan

### New files

- `src/keepers/recoveryKeeper.ts` — orchestration, state machine (`deriveRecoveryState`), dedup, concurrency lock, `RecoveryRequiredEvent` + `RecoveryStage` types
- `src/ark/recovery.ts` — detection logic (`detectRecoverable`), used by arkKeeper preflight and recoveryKeeper
- `src/ark/swapExecutor.ts` — `SwapExecutor` interface + `SwapQuoteRequest`/`SwapQuoteResult`/`SwapExecutionResult` types + default implementation scaffold

Types colocated with consumers — matches the existing repo convention (`src/keepers/arkKeeper.ts:17-38` defines its types inline). No separate `types.ts` or `recoveryState.ts`.

### Extend existing wrappers

`src/ark/vault.ts` — add the following methods to the existing monolithic façade:
- `recoverCollateral(indexes: bigint[], amts: bigint[], gas: bigint)`
- `returnQuoteToken(toIndex: bigint, amt: bigint, gas: bigint)`
- `getRemovedCollateralValue() → bigint`
- `getVaultLps(bucket: bigint) → bigint` — calls `pool.lenderInfo(bucket, vaultAddress)[0]`
- `getLpDust() → bigint`
- `getSwapper() → Address` — calls `vaultAuth.swapper()`
- `isAuthPaused() → boolean` — calls `vaultAuth.paused()` directly
- `lpToCollateral(bucket: bigint, lps: bigint) → bigint` — calls `poolInfoUtils.lpToCollateral`
- `lpToQuoteTokens(bucket: bigint, lps: bigint) → bigint` — calls `poolInfoUtils.lpToQuoteTokens`
- `getCollateralAddress() → Address` — calls `pool.collateralAddress()` (NOT added to `src/ajna/pool.ts`; that file is dead code and extending it would produce unreachable code)

`src/utils/transaction.ts` — add parsing for `RecoverCollateral` and `ReturnQuoteToken` events in `getAmountMoved` equivalent helper for recovery receipts

`src/utils/config.ts` — add recovery config block at the top level and extend `ArkConfig` for per-ark overrides (matches the existing `arks[].optimalBucketDiff` pattern):

```ts
// top-level recovery defaults
recovery: {
  dedupWindowMs?: number;                // default 3_600_000 (1h)
  maxSlippageBps?: number;               // default 50 (0.5%)
  maxValueLossBps?: number;              // default 100 (1%)
  minLpMintedBps?: number;               // default 9900 (99%)
};

// per-ark overrides extend the existing ArkConfig array element
type ArkConfig = {
  // ... existing fields (address, vaultAddress, allocation, optimalBucketDiff, etc.) ...
  recovery?: {
    enabled?: boolean;                   // default true; set false to opt this ark out of recovery-auto
    refillBucketOverride?: bigint;
    maxSlippageBps?: number;             // overrides top-level
    maxValueLossBps?: number;            // overrides top-level
  };
};
```

Design notes:
- Reuses existing `arkGlobal.minTimeSinceBankruptcy` from config.ts:102 rather than duplicating it
- `BOT_MODE` env is the single source of truth for mode — no `mode` override in config
- Per-ark nesting matches existing per-ark override pattern; no new config shape to learn

Validation: `maxSlippageBps`, `maxValueLossBps`, and `minLpMintedBps` must be 0-10000.

`src/utils/scheduler.ts` — extend to respect `BOT_MODE`:
- `scheduler`: existing flow
- `recovery-detect`: continuous loop calling `recoveryKeeper.detectOnly(ark)` for each configured ark
- `recovery-auto`: continuous loop calling `recoveryKeeper.execute(ark)` for each configured ark
- `recovery-oneshot`: single-pass `recoveryKeeper.execute(ark)` for each ark, then process.exit(0)

`src/utils/env.ts` — per-mode wallet requirement (same env var names as today):
- `scheduler`, `recovery-auto`, `recovery-oneshot`: require `PRIVATE_KEY` or `KEYSTORE_PATH` (existing)
- `recovery-detect`: no wallet required; relax the existing requirement for this mode only
- Unknown BOT_MODE: process exits with clear error (fail-closed)

`src/index.ts` — BOT_MODE dispatch (≈10 lines). Current file is 7 lines; update to select and invoke the right entry point.

`src/keepers/arkKeeper.ts`:
- Move the collateral check earlier in the flow — after `isPaused` and `poolHasBadDebt` checks, BEFORE `updateInterest` and `drain` (saves gas on every tick where recovery is needed)
- Replace the call to `optimalBucketHasCollateral(data)` at line 73 with a call to `detectRecoverable(vault)` from `src/ark/recovery.ts` (shared helper with recoveryKeeper)
- If `detectRecoverable` returns a non-empty candidate set, call existing `logRunExit` with reason `"collateral detected, recovery required"` — preserves the current `ark_run_aborted` ERROR event taxonomy and keeps existing dashboards/alerts working
- Remove the now-unused `optimalBucketHasCollateral` helper (it becomes dead code)
- No new event emission from arkKeeper, no new helper function. Smaller diff than the pre-simplification design.

### ABI updates

**Already applied to `src/abi/Vault.ts`:**
- `recoverCollateral` input types changed from single `uint256/uint256` to array `uint256[]/uint256[]`
- Added `removedCollateralValue() view returns (uint256)`
- Added `AUTH() view returns (address)`

### Mock updates (in-place, migrate existing callers)

**`test/mocks/contracts/MockVault.sol`:**
- Add `uint256 public removedCollateralValue`
- Add `address public AUTH` (constructor-set)
- Add `uint256 private _lpDust` (default per LP_DUST formula, settable)
- Add `mapping(uint256 => mapping(address => uint256)) public lenderLps` (bucket → lender → LP)
- Replace `bool public paused` with `function paused() view returns (bool) { return MockVaultAuth(AUTH).paused() || removedCollateralValue > 0; }`
- Add `function recoverCollateral(uint256[] memory _fromIndexes, uint256[] memory _amts)` with matching semantics (reverts if authPaused, sets rcv, transfers collateral)
- Add `function returnQuoteToken(uint256 _toIndex, uint256 _amt)` with matching semantics (requires paused, enforces LP_DUST on empty bucket, resets rcv)
- Add `function LP_DUST() view returns (uint256)`
- Add setters: `setRemovedCollateralValue`, `setLpDust`, `setLenderLps`
- Remove `setPaused(bool)` (migrate callers to `setAuthPaused` on MockVaultAuth)

**`test/mocks/contracts/MockVaultAuth.sol`:**
- Add `bool public paused`
- Add `address public swapper`
- Add `function setAuthPaused(bool)`, `function setSwapper(address)`

**`test/mocks/contracts/MockPoolInfoUtils.sol`:**
- Add `function lpToCollateral(address _pool, uint256 _lps, uint256 _index) view returns (uint256)`
- Add `mapping(uint256 => uint256) public mockLpToCollateral`
- Add `function setLpToCollateral(uint256 _index, uint256 _amount)`
- Existing `lpToQuoteTokens` preserved

**`test/mocks/contracts/MockPool.sol`:**
- Add `address public collateralAddress`
- Add `mapping(uint256 => mapping(address => uint256)) private _lpBalances`
- Add `function lenderInfo(uint256 _index, address _lender) view returns (uint256, uint256)` returning `(_lpBalances[_index][_lender], 0)`
- Add setters: `setCollateralAddress`, `setLenderLps`
- `bucketInfo` remains; add bankruptcy-state setter if not already present

**Corresponding TS ABI twins in `test/mocks/abi/*.ts`** updated to match each Solidity change.

### Test helper migration

- `test/helpers/vaultHelpers.ts:40` — rename `setPaused` → `setAuthPaused`; change call target from `vault().write.setPaused()` to `vaultAuth().write.setAuthPaused()`
- Find all callers of `setPaused` helper (via grep) and update import

### Packaging changes

- No new `package.json` scripts. Mode is set via `BOT_MODE` env at container invocation (operator knob, not a script choice)
- `Dockerfile` unchanged (CMD stays single entrypoint; BOT_MODE injected at container invocation)
- Build pipeline: `tsup src/index.ts --format esm --clean` already produces a single `dist/index.js`; no changes needed
- README: document the valid `BOT_MODE` values and which wallet env to supply per mode

## Logging and Alerts

Structured events are grouped into **alertable events** (things operators route on) and a **debug trace event** (internal progress, no alerting).

### Alertable events (9)

- `collateral_recovery_required` — detection found recoverable collateral
- `recovery_recovered_collateral` — `recoverCollateral` succeeded, payload has `actualRecoveredCollateral`
- `recovery_swap_executed` — swap succeeded, payload has `actualAmountOut` (pre/post balance delta)
- `recovery_swap_failed` — swap tx reverted or deadline expired; payload has `reason` (`'revert'` | `'deadline_expired'` | `'min_out_not_met'`)
- `recovery_swap_value_loss_exceeded` — swap succeeded but output below vault-value threshold; refill NOT attempted
- `recovery_refill_failed` — `returnQuoteToken` did not land; payload has `reason` (`'below_dust'` | `'recently_bankrupt'` | `'poor_exchange_rate'` | `'revert'`)
- `recovery_blocked_admin_pause` — `AUTH.paused()` blocks fresh recovery
- `recovery_completed` — full flow complete; payload has `adminPausePending: boolean` (true if `AUTH.paused()` is still true post-`returnQuoteToken`)
- `recovery_state_mismatch` — concurrency guard: state doesn't match expected pre-condition

### Debug trace event (1)

- `recovery_step` — internal progress; payload has `step` (`'preflight_passed'` | `'started'` | `'swap_quoted'` | `'refill_started'` | `'resume_detected'`). Emitted at debug level; not intended for alerting.

### Common payload fields on all events

- `arkAddress`, `vaultAddress`, `vaultAuthAddress`, `poolAddress`
- Relevant bucket indexes
- `vaultEffectivePaused` (compound `paused()`) and `authPaused` (admin only)
- `removedCollateralValue`
- Timing / receipt data where relevant

All recovery events MUST be distinct from the generic `keeper_run_failed` event.

`recovery_completed` additionally includes reconciliation data: `walletCollateralBalance`, `walletQuoteBalance`, `refillBucketIndex`, `lpMintedDelta`. `removedCollateralValue` is always present (should be 0 on clean completion).

## Test Plan

### Unit

- Non-18-decimal quote conversion for refill sizing (6-dec USDC, 18-dec DAI)
- Refill bucket policy: default + config override
- State derivation from `AUTH.paused`, `removedCollateralValue`, and wallet balances (all 7 states in table)
- Swap min-out enforcement
- Value-loss enforcement (`expectedQuoteOut` vs `actualAmountOut`)
- Dedup logic (dedupKey generation + window behavior)
- Detection rule: bucket with vaultLps==0 excluded, bucket with LP but zero collateral excluded, bucket with both included, bankruptcy bucket excluded

### Integration

- Detect-only emits `collateral_recovery_required` with correct payload
- Execute mode recovers, swaps, and returns quote (happy path, mocked Bot 1)
- Crash after recoverCollateral: resume from SWAPPING stage (simulated via state manipulation)
- Crash after swap: resume from REFILLING stage
- Crash after returnQuoteToken: subsequent run is IDLE
- Admin pause blocks fresh recovery (`recovery_blocked_admin_pause` fires, zero txs)
- Admin pause during active recovery allows completion but emits `recovery_completed` with `adminPausePending: true`
- Low bucket dust handling uses actual `LP_DUST`; `recovery_refill_failed` fires on pre-check with `reason: 'below_dust'`
- Bankruptcy bucket refill: `recovery_refill_failed` with `reason: 'recently_bankrupt'`
- Swap value-loss exceeded: `recovery_swap_value_loss_exceeded` fires, refill NOT attempted
- `metavaultKeeper` halts entire run while any ark is recovery-paused
- Concurrency: second call to recoveryKeeper while first is in-flight returns immediately (lock held)

### Regression (mandatory per iron rule)

- `arkKeeper` detects collateral in non-optimal bucket via shared `detectRecoverable()` (current code only checks optimal)
- `arkKeeper` never invokes any admin-pause before `recoverCollateral`
- `recoveryKeeper` resumes correctly from crash at each stage (restart-safe requirement)
- `arkKeeper` bail-out still emits existing `ark_run_aborted` ERROR log (with updated reason `"collateral detected, recovery required"`) — preserves backstop alerting for operators
- `arkKeeper` does NOT emit `collateral_recovery_required` (single-source emission from recoveryKeeper only)
- Resilience: detection after recoveryKeeper restart re-fires `collateral_recovery_required` (in-memory dedup store resets on restart)

### Mock updates required

Covered under "Mock updates" section above. Mocks must be in place BEFORE integration coverage can be trusted.

## Not In Scope

- Multi-vault org coordinator in this repo
- New DEX integration implementation here (Bot 1's domain)
- Automatic admin unpause
- Per-ark metavault skip math (see TODOS.md for future optimization)
- Event-based bucket enumeration as belt-and-suspenders detection (see TODOS.md)
- Cleanup of `src/ajna/pool.ts`, `src/ajna/poolInfoUtils.ts`, `src/ark/vaultAuth.ts` dead code (see TODOS.md — deferred to avoid conflicts with in-flight PRs on remote main)
- `logRunExit` severity refactor (see TODOS.md)
- Infinite ERC20 approvals (see TODOS.md — exact-amount reset-to-zero pattern)
- Multi-bucket recovery pagination (see TODOS.md — defensive hedging)
- KeeperHub integration (canceled, never to be built)

## Pre-Implementation Checklist

Replaces the original "Open Issues" section. Each must land before code implementation begins.

### 1. ABI resolution

**Status: DONE.** Applied in this review session:
- `src/abi/Vault.ts:519-525` — `recoverCollateral` inputs changed to `uint256[]/uint256[]`
- Added `removedCollateralValue()` view returning `uint256`
- Added `AUTH()` view returning `address`

Verification: upstream main and pinned submodule commit `bd09f3d` both use array form.

### 2. Submodule initialization

**Status: DONE** for initialization and local verification. **Outstanding: production bytecode verification.**

Applied:
- `lib/4626-ajna-vault` initialized to pinned commit `bd09f3d150f0baed29ad365fe9ce9d8ca3cd1152`
- Confirmed pinned source uses array form of `recoverCollateral`
- Confirmed `AUTH`, `removedCollateralValue`, and compound `paused()` formula match spec

Outstanding:
- Someone with production access must verify the deployed vault's bytecode matches commit `bd09f3d` (or identify the actual deployed commit and re-pin if different). Do this before first run against a live vault.

### 3. Mock updates (in-place, migrate callers)

**Status: TODO for implementer.** Precise changes specified under "Mock updates" section above. Four Solidity files + four ABI twins + rename of `setPaused` helper in `test/helpers/vaultHelpers.ts` + any test files that import it.

### 4. Spec corrections (this document)

**Status: DONE.** This document IS the corrected spec, superseding `ARK_VAULT_COLLATERAL_RECOVERY_BOT_SPEC.md`.

## Current Fork Status

The fork has one partial safeguard today:
- `arkKeeper` aborts when `optimalBucketHasCollateral(...)` is true

This implementation plan replaces that partial safeguard with:
- full-bucket detection preflight before any mutating tx
- distinct recovery keeper with its own state machine
- mocked recovery flow in test infrastructure

## Recommended Initial Rollout

### Phase 1: Detect-only

- Deploy `BOT_MODE=recovery-detect` alongside `BOT_MODE=scheduler`
- Detection fires `collateral_recovery_required` events; log aggregator alerts on-call
- Operator manually triggers `BOT_MODE=recovery-oneshot` via cron or manual command when an alert fires
- Validates detection accuracy against real liquidation events before auto-execute touches real capital

### Phase 2: Full auto-execute

- Approved per-ark via config (`recovery.arks[].autoExecute = true`)
- Deploy `BOT_MODE=recovery-auto` alongside Phase 1 infrastructure
- Human review only on failure events
- Detect-only can remain running in parallel for observation

This keeps the first rollout safe while avoiding the bad manual pattern of "pause first, figure it out later".
