# TODOs

Items deferred from the Ark Vault Collateral Recovery Bot plan review (2026-04-19).

---

## Token Approval Lifecycle Policy

**What:** Document and implement an exact-amount, reset-to-zero approval pattern for all ERC20 approvals the recovery bot makes. Applies to both vault approvals (for `returnQuoteToken`) and Bot 1 swap adapter approvals (for the collateral-to-quote swap).

**Why:** Infinite approvals on the swapper wallet are a persistent attack surface. Stale approvals from previously-crashed runs can also cause unexpected rejections later. Exact-amount-per-call + reset-to-zero is standard security hygiene for a swapper-role wallet.

**Pros:**
- Tighter blast radius if the swapper wallet or Bot 1 is compromised
- No surprises from leftover approvals in failure scenarios
- Clear audit trail of approve/revoke pairs

**Cons:**
- ~10 extra lines per approval site
- Minor gas cost from approve-zero-then-approve-N pattern

**Context:**
- Decided in the plan review (Outside Voice TODO #3) to defer rather than bundle into the main plan
- Policy to write into the spec: "Approvals are exact-amount per call. If `ERC20.allowance()` returns non-zero at the start of a stage, call `approve(0)` first, then `approve(exactAmount)`. Revoke (approve 0) after the stage completes successfully."
- Applies to: `src/keepers/recoveryKeeper.ts` approval sites before swap and before `returnQuoteToken`

**Depends on / blocked by:** Recovery bot implementation (this TODO is a hardening pass, not prerequisite)

---

## Multi-bucket Recovery Pagination / Gas Feasibility

**What:** Add a configurable `maxBucketsPerRecoveryTx` (default 5) to `src/utils/config.ts`. If the detection scan finds more collateralized buckets than this limit, `recoveryKeeper` must split into multiple sequential `recoverCollateral` array calls. Each array call is atomic within itself (per contract behavior).

**Why:** Array-form `recoverCollateral` gas cost grows with the number of buckets. At extreme N (10+), a single tx could exceed the block gas limit or be unreviewable. Pagination keeps each tx small and auditable.

**Pros:**
- Bot survives unusual many-bucket recovery scenarios gracefully
- Each paginated call is smaller and easier to simulate/estimate before sending

**Cons:**
- ~20 lines of batching logic + state tracking between calls
- Adds test surface (partial progress state across pagination boundaries)

**Context:**
- Realistic current bucket count per ark during liquidation is 1-3 (possibly up to 5)
- Deferred because it's defensive hedging for an edge case
- Existing `getGasWithBuffer()` already catches impossibly-large calls at runtime; worst case today is a revert + alert rather than silent failure

**Depends on / blocked by:** Recovery bot baseline implementation; add once production data shows real bucket counts

---

## Dead Code Cleanup (`pool.ts`, `poolInfoUtils.ts`, `vaultAuth.ts`)

**What:** Delete the following files — all define factory functions that are never imported anywhere in the codebase:
- `src/ajna/pool.ts` (`createPool` defined, 0 importers)
- `src/ajna/poolInfoUtils.ts` (`createPoolInfoUtils` defined, 0 importers)
- `src/ark/vaultAuth.ts` (`createVaultAuth` defined, 0 importers)

All functionality they provide is already in `src/ark/vault.ts`'s combined façade pattern.

**Why:** Dead code confuses future contributors. The current plan review caught a spec defect where the spec proposed extending `pool.ts` with `getCollateralAddress` — no one noticed `pool.ts` has zero importers, and the method would have been dead on arrival. Future maintainers would keep tripping over these files.

**Pros:**
- ~100 lines of code removed
- Single import path per contract type (via `createVault` in `src/ark/vault.ts`)
- Removes confusion about which wrapper to use

**Cons:**
- Cleanup PR coordination with other contributors
- Zero functional benefit (just hygiene)

**Context:**
- Explicitly deferred during plan review to minimize merge conflicts with in-flight PRs on remote main
- Execute after in-flight work lands
- Capturing intent now so it doesn't get forgotten

**Depends on / blocked by:** In-flight PRs on remote main landing first

---

## `logRunExit` Severity Refactor

**What:** Refactor `src/keepers/arkKeeper.ts`'s `logRunExit` helper to accept a severity parameter (`'info' | 'warn' | 'error'`) instead of hardcoding `log.error`. Migrate existing call sites to use appropriate severity based on the exit reason.

**Why:** Current behavior emits `log.error` for ALL exits including normal operational states (vault paused, optimal bucket dusty, recently bankrupt, pool has bad debt). This produces ERROR-level log spam for routine conditions and dilutes real error alerting.

**Pros:**
- Alerting routes based on real severity
- Easier to spot actual errors in log aggregators
- Better signal-to-noise for on-call engineers

**Cons:**
- Touches every existing `logRunExit` call site in `arkKeeper.ts`
- Higher merge conflict risk with in-flight PRs

**Context:**
- Recovery path already uses a dedicated helper (decided in Section 2 Issue 4), so this TODO is purely for cleaning up existing exit paths
- Deferred to minimize churn on shared code during in-flight PR window

**Depends on / blocked by:** In-flight PRs on remote main landing first

---

## Per-ark Metavault Skip (Optional Future Optimization)

**What:** Rewrite `src/keepers/metavaultKeeper.ts`'s `_getPausedArks` handling so it filters paused arks out of the rebalance pool and reallocates across the remaining arks, instead of halting the entire metavault run.

**Why:** In semi-auto recovery mode, operator review can take hours or days before recovery executes. During that window, every other ark in the metavault is frozen \u2014 no reallocation, no rebalancing. This costs yield if rates move during the window.

**Pros:**
- Other arks keep earning optimal rates while one is in recovery
- Better operational behavior for multi-ark metavaults

**Cons:**
- Requires renormalizing allocation math across the unpaused subset
- New edge cases: multiple arks paused simultaneously, buffer + unpaused can't meet bounds
- ~30-50 lines of new allocation logic in metavaultKeeper.ts + edge-case tests

**Context:**
- Decided to keep current halt-entirely behavior for now (Section 1 Issue 2)
- Revisit if production yield drag during recovery windows becomes measurable
- Spec currently documents the tradeoff

**Depends on / blocked by:** Production data showing recovery windows are long enough to matter

---

## Event-Based Bucket Enumeration (Belt-and-Suspenders Detection)

**What:** Augment `vault.getBuckets()` with event-based enumeration \u2014 query historical `AddQuoteToken` and `MoveQuoteToken` events since vault deployment to build a superset of candidate buckets for detection.

**Why:** The Vault's `buckets[]` array is a derived index; the `lps` mapping is authoritative. In theory (though not verified for the Ajna liquidation scope), LP could accumulate in a bucket not in the array. Event-based enumeration is ground truth.

**Pros:**
- Detection cannot silently miss collateral
- Belt-and-suspenders guarantee

**Cons:**
- Significantly larger diff (event querying, caching, state management)
- May be overkill if Ajna's invariants make this scenario impossible in practice

**Context:**
- Decided in Outside Voice section to trust `getBuckets()` for the recovery scope (liquidation doesn't create new buckets; it changes LP type in existing tracked buckets)
- Spec documents the assumption
- If production operations ever reveal the gap matters, reopen this TODO

**Depends on / blocked by:** Observed gap in production (not a current blocker)
