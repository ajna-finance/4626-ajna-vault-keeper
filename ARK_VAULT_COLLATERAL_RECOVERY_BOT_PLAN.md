# Ark Vault Collateral Recovery Bot — Implementation Plan

Status: approved for implementation
Date: 2026-04-19
Amended: 2026-07-06 — post-implementation corrections from review; see "Post-Implementation Amendments"
Supersedes: `ARK_VAULT_COLLATERAL_RECOVERY_BOT_SPEC.md` (2026-04-06, proposed)
Repo: `4626-ajna-vault-keeper`
Target implementation: `../eb-vault-fork/4626-ajna-vault-keeper`

## Post-Implementation Amendments (2026-07-06)

Review of the implemented bot (PR #20) confirmed several defects in this plan itself.
The affected sections below have been corrected inline; this list is the summary of
what changed and why:

1. **Keep `optimalBucketHasCollateral`** — this plan ordered its removal as dead code.
   Wrong: it guards the DESTINATION bucket's total collateral (any owner), which the
   vault-LP-based `detectRecoverable` cannot see. Both checks stay. (§Repo
   Implementation Plan → arkKeeper.)
2. **Refill dust gate had the wrong basis** — gate 3 checked pool-total bucket LP and
   compared the deposit amount against `LP_DUST`, but the contract's `DustyBucket`
   check is on the VAULT'S OWN LP after minting. Corrected, with a minted-LP estimate.
   (§Refill Bucket Pre-check.)
3. **`expectedQuoteOut` is sourced from `removedCollateralValue`**, not
   `poolInfoUtils.lpToQuoteTokens` — rcv IS the quote-WAD value the vault is owed at
   the recovery price; projecting remaining LP measured the wrong thing. It is a
   quote-denominated WAD, and the `SwapExecutor` interface now documents its units
   contract. (§Bot-to-Bot Interface, §Planned Recovery Flow.)
4. **Detection has a materiality floor** — `recovery.minRecoveryValueWad` (quote-WAD,
   default 1e15 = 0.001 quote token, per-ark override). Without it, a permissionless
   1-wei `addCollateral` halts arkKeeper every tick and walks recovery-auto into a
   stranded `rcv > 0` pause. (§Detection rule, §Repo Implementation Plan → config.)
5. **Swap executor is probed in preflight** — `getSpender()` is validated before any
   mutating tx so an unconfigured Bot 1 adapter blocks loudly
   (`recovery_blocked_swap_executor`) instead of after `recoverCollateral` has already
   paused the vault. (§Planned Recovery Flow.)
6. **`recovery-oneshot` exit code carries the outcome** — exits non-zero unless every
   enabled ark needed no operator attention. (§Process Model, §Runbook 2.)
7. **Bankruptcy recency uses chain time** — `bankruptcyTime` is a block timestamp, so
   the gate reads `getChainTime()`, failing closed with reason
   `chain_time_unavailable`. Swap deadlines and alert-dedup windows stay wall-clock.
8. **Event taxonomy expanded** — the implemented alert set is larger than the original
   nine events. (§Logging and Alerts.)
9. **Startup checks are BOT_MODE-gated** — the metavault allocator checks assume the
   scheduler's keeper wallet and only run in `scheduler` mode; recovery modes run with
   the swapper wallet (or none in `recovery-detect`). (§Process Model.)
10. **Wallet dust floors are decimals-aware** — the collateral-side floor scales with
    the collateral token's decimals (micro-token, min 1 raw unit, capped at 1000 raw
    units); the quote-side floor remains ~0.001 quote tokens. (§Recovery State Machine.)
11. **Adapter delivery is a compile-time registry** — the concrete `SwapExecutor` is
    selected by NAME via `recovery.swapExecutor.adapter` from a reviewed, compiled-in
    set (no dynamic code loading in the process holding the swapper key), with an
    optional operator-pinned spender allowlist. First registered adapter: CoW
    Protocol. (§Bot-to-Bot Interface → Adapter delivery.)

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
- exit via the existing run-abort path (`abortRun`, formerly `logRunExit`) when collateral is detected, preserving the current `ark_run_aborted` ERROR event taxonomy

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

- arkKeeper calls `detectRecoverable(vault, { minValueWad })` (from `src/ark/recovery.ts`) as a bail-out gate. On positive detection, it exits via the existing run-abort path (`abortRun`) — emitting the familiar `ark_run_aborted` ERROR log. It does NOT emit `collateral_recovery_required`.
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

**Materiality floor (amended 2026-07-06).** A candidate must additionally be worth at
least `recovery.minRecoveryValueWad` (quote-WAD; default 1e15 = 0.001 quote token;
per-ark override) — valued as `estimatedCollateralWad × bucketPrice / WAD`, the same
pricing `recoverCollateral` itself uses to set `removedCollateralValue`. Without the
floor, anyone can permissionlessly `addCollateral` 1 wei into a bucket where the vault
holds LP, halting arkKeeper on every tick; and recovery-auto would recover the dust
(`rcv > 0`, vault paused), skip the swap, and strand at `no_quote_to_refill`. Both
keepers apply the floor through the shared `detectRecoverable` helper, so detection
stays consistent. Collateral below the floor deliberately sits untouched in the bucket
— it is accepted dust, not a recovery condition.

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
  amountIn: bigint;                // RAW tokenIn units (tokenIn decimals)
  maxSlippageBps: number;          // DEX slippage tolerance (bps)
  maxValueLossBps: number;         // additional vault-value loss threshold (Bot 3 enforces; bps)
  expectedQuoteOut: bigint;        // QUOTE-DENOMINATED WAD (1e18) — carries removedCollateralValue
  recipient: `0x${string}`;        // must be the recovery wallet
  deadline: bigint;                // unix timestamp (seconds)
};

type SwapQuoteResult = {
  expectedAmountOut: bigint;       // RAW tokenOut units
  minAmountOut: bigint;            // RAW tokenOut units
  routeId: string;                 // correlation key for retry detection
  validUntil: bigint;              // unix timestamp (seconds)
};

type SwapExecutionResult = {
  amountIn: bigint;                // RAW tokenIn units
  amountOut: bigint;               // RAW tokenOut units
  minAmountOut: bigint;            // RAW tokenOut units
  txHash: `0x${string}`;
  routeId: string;
  recipient: `0x${string}`;
};

interface SwapExecutor {
  // Address that must hold the ERC20 allowance from the bot wallet to pull tokenIn.
  // Probed by Bot 3 in preflight BEFORE any mutating tx (amended 2026-07-06): an
  // unconfigured adapter must fail here, not after recoverCollateral has paused the vault.
  getSpender(tokenIn: `0x${string}`): `0x${string}`;
  quoteExactIn(input: SwapQuoteRequest): Promise<SwapQuoteResult>;
  executeExactIn(input: SwapQuoteRequest & { priorTxHash?: `0x${string}` }): Promise<SwapExecutionResult>;
}
```

**Units contract (amended 2026-07-06).** The interface mixes two decimal bases and the
split is invisible with an 18-decimal quote token: `amountIn` / `amountOut` /
`minAmountOut` are raw token units in each token's own decimals, while
`expectedQuoteOut` is a quote-denominated WAD carrying `removedCollateralValue` — NOT
`lpToQuoteTokens` output as this plan originally said, and NOT tokenOut native units.
rcv is the quote value the vault is owed at the recovery price, which is exactly what
the swap must produce; projecting the vault's remaining LP measured the wrong thing.
Bot 3 enforces the value-loss threshold against this WAD figure itself; adapters must
not derive `minAmountOut` from it without rescaling by `10^(tokenOutDecimals-18)`.

Bot 3 responsibilities around the swap:
- Snapshot `walletBalanceBefore = ERC20(tokenIn).balanceOf(recovery wallet)` AND `walletQuoteBefore = ERC20(tokenOut).balanceOf(recovery wallet)` immediately before `executeExactIn`
- Pass `expectedQuoteOut = removedCollateralValue` (quote-WAD; amended 2026-07-06 — see the units contract above)
- After `executeExactIn`, compute `actualAmountOut = ERC20(tokenOut).balanceOf(recovery wallet) - walletQuoteBefore`, then convert to WAD before comparing
- If `actualAmountOutWad < expectedQuoteOut * (10000 - maxValueLossBps) / 10000`, emit `recovery_swap_value_loss_exceeded` and HALT (do not proceed to returnQuoteToken with the under-valued output)
- Use `actualAmountOut` (not swap receipt's `amountOut`) as the return amount — fee-on-transfer tokens may report higher than delivered
- If the swap transaction is resubmitted on retry, pass the `priorTxHash` so Bot 1 can correlate; adapter returns existing result instead of executing a second swap

MEV-safe mempool submission (flashbots / private relay) is Bot 1's responsibility. Bot 3 enforces constraints; Bot 1 handles routing.

Rule:
- Bot 3 owns vault logic and constraints
- Bot 1 owns swap execution and routing
- Neither owns the other's state machine

### Adapter delivery (amended 2026-07-06)

The concrete `SwapExecutor` reaches the process through a compile-time registry
(`src/ark/swapAdapters/`), selected by name:

```jsonc
"recovery": {
  "swapExecutor": {
    "adapter": "cow",                // must be a compiled-in registry name
    "apiBaseUrl": "...",             // optional endpoint override
    "expectedSpender": "0xC92E..."   // optional operator-pinned spender allowlist
  }
}
```

Config stays data, never code: there is no dynamic module loading, so nothing
outside the reviewed registry can execute inside the process that holds the swapper
key. Unknown names are rejected at config load; the scheduler builds the executor
once at startup for the execute modes and fails closed if construction throws. With
no `swapExecutor` block, the fail-closed `UnconfiguredSwapExecutor` remains in place
and the preflight probe blocks fresh recoveries per run. When `expectedSpender` is
set, the address the wallet approves collateral to must equal it exactly — an
allowlist independent of the adapter implementation itself.

First registered adapter: **CoW Protocol** (`adapter: "cow"`), chosen because its
safety is enforced on-chain by the signed order (limit price, expiry, receiver)
rather than by the hosted API, MEV protection is structural (batch auctions, no open
mempool), and the approval target is the fixed, audited GPv2VaultRelayer. The
orderbook API is a liveness dependency only. Settlement is asynchronous; the adapter
polls until fill or `validTo` (= the keeper's swap deadline), and an expired order
can never fill later, so a timeout is a terminal, re-quotable failure that resumes
cleanly from the RECOVERED stage. A Bot 1 HTTP adapter slots in beside it as a
second registry entry whenever Bot 1's API contract is available.

Credential-mode constraint: CoW orders are EIP-712 typed-data signatures, and the
keeper's remote-signer account deliberately does not implement typed-data signing —
so the CoW adapter requires `PRIVATE_KEY` or `KEYSTORE_PATH` for the swapper wallet
and refuses to construct under `REMOTE_SIGNER_URL` (startup fail-fast, before any
on-chain action). Supporting remote signers here means adding verified
`eth_signTypedData_v4` support to `src/utils/remoteSigner.ts` first. Note the
on-chain `VaultAuth.swapper` is a bare address — governance COULD point it at a
contract wallet, in which case this keeper simply refuses to act
(`recovery_wallet_role_mismatch`), since it only executes when the loaded signing
account IS the swapper.

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

Wallet balances are dust-normalized before stage derivation, otherwise a 1-wei
transfer to the swapper wallet flips a legitimate RECOVERED into
PARTIAL_SWAP_AMBIGUOUS and halts recovery. Floors (amended 2026-07-06 to be
decimals-aware on the collateral side): quote — `assetScale / 1000` (~0.001 quote
tokens); collateral — one micro-token (`10^decimals / 1e6`), at least 1 raw unit,
capped at 1000 raw units so high-decimal tokens keep the historical 1000-wei floor
(raising it would open a gap between the detection value floor and the swap-skip floor
where a recovery could strand with `rcv > 0`).

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
4. **Swap-executor probe (amended 2026-07-06):** call `swapExecutor.getSpender(collateralToken)` (local, synchronous) BEFORE any mutating tx; on throw, emit `recovery_blocked_swap_executor` and return. `recoverCollateral` is irreversible — a missing Bot 1 adapter must fail here, not after the vault is already recovery-paused with collateral stranded in the wallet. Preflight also verifies the loaded wallet is the on-chain swapper (`recovery_wallet_role_mismatch`), that `vault.AUTH()` matches config (`recovery_auth_drift`), and that the wallet holds no material pre-existing balances (`recovery_wallet_contaminated`).
5. **Recovery stage (if `removedCollateralValue == 0`):**
   1. Run detection preflight (including the materiality floor); if no candidates, return (no-op)
   2. Emit `recovery_step` (step: `'started'`)
   3. Snapshot wallet collateral balance before
   4. Call `recoverCollateral(indexes[], amts[])` with gas buffer; await receipt
   5. Compute `actualRecoveredCollateral = walletCollateralAfter - walletCollateralBefore`
   6. Emit `recovery_recovered_collateral` with actual amount
6. **Swap stage:**
   1. Read collateral token address from `pool.collateralAddress()` (via vault wrapper)
   2. Set `expectedQuoteOut = removedCollateralValue` (quote-WAD; amended 2026-07-06 — rcv is the value the vault is owed at the recovery price)
   3. Call `swapExecutor.quoteExactIn(...)`, enforcing `minAmountOut` and passing `maxValueLossBps` + `expectedQuoteOut`
   4. Emit `recovery_step` (step: `'swap_quoted'`)
   5. Approve collateral to `swapExecutor.getSpender(tokenIn)` (exact amount, reset-to-zero if stale — see TODOS.md; a spender equal to the bot wallet is rejected as `invalid_spender`)
   6. Snapshot wallet quote balance before
   7. Call `swapExecutor.executeExactIn(...)` with `deadline` and `routeId`
   8. On revert / deadline / min-out failure: emit `recovery_swap_failed` with `reason` and HALT
   9. Compute `actualAmountOut = walletQuoteAfter - walletQuoteBefore`, convert to WAD
   10. If `actualAmountOutWad < expectedQuoteOut * (10000 - maxValueLossBps) / 10000`: emit `recovery_swap_value_loss_exceeded` and HALT
   11. Emit `recovery_swap_executed` with `actualAmountOut`
7. **Refill bucket pre-check (amended 2026-07-06 — see §Refill Bucket Pre-check for the corrected gates):**
   1. Determine `refillBucket = ark.recovery?.refillBucketOverride ?? vaultAuth.minBucketIndex()`; reject an override below `minBucketIndex` pre-flight (`recovery_refill_bucket_override_invalid`)
   2. Read `bucketInfo(refillBucket)`, the vault's own LP in that bucket (`pool.lenderInfo`), `vault.LP_DUST()`, and chain time (`getChainTime()`; on failure emit `recovery_refill_failed` reason `'chain_time_unavailable'` and HALT — `bankruptcyTime` is a block timestamp, so wall clock must not gate it)
   3. Apply the gates in order: `recently_bankrupt`, `bucket_lp_dangerous`, `no_quote_to_refill`, `below_dust` (vault-LP-after-mint basis), then `poor_exchange_rate`; on any failure emit `recovery_refill_failed` with the reason and HALT
8. **Refill stage:**
   1. Approve quote token to vault (exact amount, reset-to-zero if stale)
   2. Emit `recovery_step` (step: `'refill_started'`)
   3. Call `returnQuoteToken(refillBucket, actualAmountOut)` with gas buffer
   4. On revert: emit `recovery_refill_failed` (reason: `'revert'`) with decoded error
9. **Accounting reconciliation (after refill succeeds):**
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

Pre-check gates (amended 2026-07-06; applied in order before `returnQuoteToken`, all share the `recovery_refill_failed` event with distinct `reason` values). The `now` used below is CHAIN time (`getChainTime()`); if it cannot be read, the run fails closed → `reason: 'chain_time_unavailable'`.

1. Not admin-paused (defensive; state machine should already have prevented reaching this point)
2. Not recently bankrupt (`bankruptcyTime > 0` AND `now - bankruptcyTime < arkGlobal.minTimeSinceBankruptcy`) → `reason: 'recently_bankrupt'`
3. Pool-total bucket LP not in the `_validDestination` danger zone (`0 < bucketInfo.lps <= 1_000_000` reverts `BucketLPDangerous`) → `reason: 'bucket_lp_dangerous'`
4. Something to return (`amount > 0` — Stage 2 skipped on sub-dust collateral or wallet externally swept means `returnQuoteToken(bucket, 0)` would strand `rcv > 0`) → `reason: 'no_quote_to_refill'`
5. Vault LP after mint clears dust. **Corrected basis:** the contract's `DustyBucket` check (`AjnaVaultLibrary._fill`) is on the VAULT'S OWN LP after minting — `lps[bucket] += minted; revert if < LP_DUST` — not pool-total LP and not the deposit amount. This plan's original gate (`bucketInfo.lps == 0 AND amount < LP_DUST`) waved through any bucket holding other lenders' LP, and the tx then reverted on-chain as a generic `'revert'`. The gate is now `vaultLps(refillBucket) + estimatedMintedLp < LP_DUST` → `reason: 'below_dust'`, where `estimatedMintedLp = amount * minLpMintedBps / 10000` for pure-quote buckets (gate 6 guarantees that bound on every path that reaches the tx; the ~1% margin also absorbs Ajna's deposit fee) and the full `amount` for mixed buckets (no reliable bound — an extreme-rate mixed bucket can still revert on-chain as `'revert'`).
6. Exchange rate produces meaningful LP (`round-trip quote / amount >= recovery.minLpMintedBps`; pure-quote buckets only) → `reason: 'poor_exchange_rate'`

Each gate halts the flow. One alert event, seven reason codes (`'recently_bankrupt'`, `'bucket_lp_dangerous'`, `'no_quote_to_refill'`, `'below_dust'`, `'poor_exchange_rate'`, `'chain_time_unavailable'`, plus `'revert'` for any other returnQuoteToken failure).

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
5. `recoveryKeeper` runs end-to-end for configured arks once and exits. **The exit code carries the outcome (amended 2026-07-06):** 0 only when every enabled ark either had nothing to recover or completed cleanly; 1 when any ark was blocked or failed (`recovery_oneshot_incomplete` is logged alongside the per-ark failure event). Scripts may safely chain `recovery-oneshot && next-step`.
6. `arkKeeper` resumes on next tick automatically
7. `metavaultKeeper` resumes normal allocation once the ark is no longer paused

### 3. Recovery required, full-auto mode

1. `recoveryKeeper` (BOT_MODE=recovery-auto, continuous) detects collateral, emits `collateral_recovery_required`, and auto-executes if preflight passes
2. `arkKeeper` in the scheduler deployment bails silently with `ark_run_aborted` until the ark is no longer paused
3. Operator is notified only on failure (`recovery_swap_value_loss_exceeded`, `recovery_swap_failed`, `recovery_refill_failed`, `recovery_blocked_admin_pause`, `recovery_blocked_swap_executor`, `recovery_state_mismatch`, `recovery_wallet_contaminated`, `recovery_wallet_role_mismatch`, `recovery_auth_drift`, `recovery_tx_failed`) or completion (`recovery_completed` — check `adminPausePending` field)

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
- `recovery_refill_failed` fires with a `reason` field (amended 2026-07-06):
  - `'below_dust'` — pre-check: vault LP after mint would land under `LP_DUST` (operator funds recovery wallet to top up, or picks a bucket where the vault already holds LP)
  - `'recently_bankrupt'` — pre-check caught bankruptcy state on target bucket (operator picks a different bucket via `refillBucketOverride`)
  - `'bucket_lp_dangerous'` — pre-check: pool-total bucket LP in the `BucketLPDangerous` range, 1..1_000_000 (operator picks a different bucket)
  - `'no_quote_to_refill'` — wallet holds no quote token with `rcv > 0`; Stage 2 was skipped or the wallet was swept (operator investigates/funds)
  - `'poor_exchange_rate'` — pre-check caught impaired bucket (operator picks a different bucket)
  - `'chain_time_unavailable'` — could not read chain time to evaluate the bankruptcy gate; fail-closed, no tx sent (operator checks RPC health)
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
| `recovery-oneshot` | Detect + execute across configured arks for one pass, then exit. Operator trigger for semi-auto mode. Exit code 0 only when every enabled ark needed no attention; otherwise 1 (amended 2026-07-06). |

No new `package.json` scripts. Existing `pnpm start` remains the single entry point; deployments set `BOT_MODE` via container env. README documents the valid values. Mode is an operator / deployment concern, not a script choice.

Startup checks are BOT_MODE-gated (amended 2026-07-06): chain-id verification runs in
every mode, but the metavault allocator/strategy checks assume the SCHEDULER's keeper
wallet and only run for `BOT_MODE=scheduler` — recovery modes sign with the swapper
wallet (or, in `recovery-detect`, no wallet at all) and would fail those checks at
every startup.

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
// top-level recovery defaults (amended 2026-07-06: swapDeadlineSec, minRecoveryValueWad)
recovery: {
  dedupWindowMs?: number;                // default 3_600_000 (1h)
  maxSlippageBps?: number;               // default 50 (0.5%)
  maxValueLossBps?: number;              // default 100 (1%)
  minLpMintedBps?: number;               // default 9900 (99%)
  swapDeadlineSec?: number;              // default 300; swap deadline horizon (wall clock)
  minRecoveryValueWad?: string;          // default '1000000000000000' (1e15 = 0.001 quote token);
                                         // detection materiality floor, quote-WAD
};

// per-ark overrides extend the existing ArkConfig array element
type ArkConfig = {
  // ... existing fields (address, vaultAddress, allocation, optimalBucketDiff, etc.) ...
  recovery?: {
    enabled?: boolean;                   // default true; set false to opt this ark out of recovery-auto
    refillBucketOverride?: string;       // bigint string, 0..7388 (AJNA_MAX_FENWICK_INDEX)
    maxSlippageBps?: number;             // overrides top-level
    maxValueLossBps?: number;            // overrides top-level
    minRecoveryValueWad?: string;        // overrides top-level
  };
};
```

Design notes:
- Reuses existing `arkGlobal.minTimeSinceBankruptcy` from config.ts:102 rather than duplicating it
- `BOT_MODE` env is the single source of truth for mode — no `mode` override in config
- Per-ark nesting matches existing per-ark override pattern; no new config shape to learn

Validation: `maxSlippageBps` must be 0-1000, `maxValueLossBps` 0-5000, `minLpMintedBps`
0-9999 (10000 is mathematically unachievable and would halt every refill),
`swapDeadlineSec` 60-3600, `minRecoveryValueWad` a non-negative bigint string,
`refillBucketOverride` a valid Ajna bucket index (0-7388). Duplicate
`arks[].vaultAddress` entries are rejected — recovery runs per-vault, and a vault
listed twice would be double-operated.

`src/utils/scheduler.ts` — extend to respect `BOT_MODE`:
- `scheduler`: existing flow
- `recovery-detect`: continuous loop calling `recoveryKeeper.detectOnly(ark)` for each configured ark
- `recovery-auto`: continuous loop calling `recoveryKeeper.execute(ark)` for each configured ark
- `recovery-oneshot`: single-pass `recoveryKeeper.execute(ark)` for each ark, then exit — code 0 only when every enabled ark needed no attention, else 1 (amended 2026-07-06)

`src/utils/env.ts` — per-mode wallet requirement (same env var names as today):
- `scheduler`, `recovery-auto`, `recovery-oneshot`: require `PRIVATE_KEY` or `KEYSTORE_PATH` (existing)
- `recovery-detect`: no wallet required; relax the existing requirement for this mode only
- Unknown BOT_MODE: process exits with clear error (fail-closed)

`src/index.ts` — BOT_MODE dispatch (≈10 lines). Current file is 7 lines; update to select and invoke the right entry point.

`src/keepers/arkKeeper.ts`:
- Move the collateral check earlier in the flow — after `isPaused` and `poolHasBadDebt` checks, BEFORE `updateInterest` and `drain` (saves gas on every tick where recovery is needed)
- Add a call to `detectRecoverable(vault, { minValueWad })` from `src/ark/recovery.ts` (shared helper with recoveryKeeper) as that early preflight
- If `detectRecoverable` returns a non-empty candidate set, abort via the existing run-exit path with reason `"collateral detected, recovery required"` — preserves the current `ark_run_aborted` ERROR event taxonomy and keeps existing dashboards/alerts working
- **KEEP `optimalBucketHasCollateral` (amended 2026-07-06** — this plan originally ordered its removal as dead code, which was wrong**):** the two checks guard different invariants. `detectRecoverable` is vault-LP-based — it only sees buckets where the vault already holds LP that redeems to collateral. `optimalBucketHasCollateral` checks the DESTINATION bucket's total collateral (any owner): the optimal bucket is a price-derived target the vault typically holds no LP in yet, and without this guard the keeper would deposit quote into a collateral-contaminated bucket and acquire collateral exposure. Both stay.
- No new event emission from arkKeeper, no new helper function.

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

Structured events are grouped into **alertable events** (things operators route on) and **non-alert events** (progress traces and deduped housekeeping warnings).

### Alertable events

(Amended 2026-07-06 — the implemented taxonomy is larger than the original nine events.)

- `collateral_recovery_required` — detection found recoverable collateral (above the materiality floor)
- `recovery_recovered_collateral` — `recoverCollateral` succeeded, payload has `actualRecoveredCollateral`
- `recovery_swap_executed` — swap succeeded, payload has `actualAmountOut` (pre/post balance delta)
- `recovery_swap_failed` — swap stage failed; payload has `reason` (`'quote_failed'` | `'invalid_spender'` | `'revert'` — adapter-side deadline / min-out failures surface through the adapter's throw and land under `'revert'` with the error in the payload)
- `recovery_swap_value_loss_exceeded` — swap succeeded but output below vault-value threshold; refill NOT attempted
- `recovery_refill_failed` — `returnQuoteToken` did not land; payload has `reason` (`'recently_bankrupt'` | `'bucket_lp_dangerous'` | `'no_quote_to_refill'` | `'below_dust'` | `'poor_exchange_rate'` | `'chain_time_unavailable'` | `'revert'`)
- `recovery_refill_bucket_override_invalid` — configured `refillBucketOverride` is below `AUTH.minBucketIndex()`; would revert on-chain
- `recovery_blocked_admin_pause` — `AUTH.paused()` blocks fresh recovery
- `recovery_blocked_swap_executor` — preflight probe found no working swap adapter; no tx sent
- `recovery_wallet_role_mismatch` — loaded wallet is not the on-chain swapper; no tx sent
- `recovery_auth_drift` — `vault.AUTH()` does not match config `vaultAuthAddress`; pause/swapper reads untrustworthy
- `recovery_wallet_contaminated` — swapper wallet holds material pre-existing balance with `rcv == 0`; operator must sweep
- `recovery_tx_failed` — a recovery tx (recoverCollateral / returnQuoteToken) failed to land; payload has `action`
- `recovery_completed` — full flow complete; payload has `adminPausePending: boolean` (true if `AUTH.paused()` is still true post-`returnQuoteToken`)
- `recovery_state_mismatch` — concurrency guard: state doesn't match expected pre-condition (includes PARTIAL_SWAP_AMBIGUOUS / NO_BALANCE resume states)
- `recovery_oneshot_incomplete` — scheduler-level: a `recovery-oneshot` pass had at least one ark needing attention; process exits 1

### Non-alert events

- `recovery_step` — internal progress trace; payload has `step` (`'started'` | `'swap_quoted'` | `'refill_started'` | `'resume_detected'`). Not intended for alerting.
- `recovery_wallet_dust` — sub-material balance sitting in the swapper wallet (warn; deduped per `dedupWindowMs`); operator should sweep eventually
- `recovery_skipped` — ark skipped this tick (`disabled_by_config` from the scheduler, `keeper_halted` from the halt guard)

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

**Status: DONE** (amended 2026-07-06). Landed with the implementation. Note one
correction beyond the original spec: `MockVault.recoverCollateral` records
`removedCollateralValue` as the QUOTE-denominated WAD value at each bucket's price
(`(_amts[i] * indexToPrice[_fromIndexes[i]]) / 1e18`), matching the real vault's
`(_gems * _price) / WAD` — not the raw collateral sum. The keeper's value-loss guard
treats rcv as the quote value the swap must produce, so a raw-sum mock would have
validated future guard tests with wrong units whenever collateral price != 1 quote.

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
