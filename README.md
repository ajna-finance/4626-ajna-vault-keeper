# 4626 Ajna Vault Keeper

## Overview

The Ajna vault keeper is a permissioned off-chain agent that periodically rebalances the ERC-4626 Ajna Vault by moving quote tokens between Ajna buckets and the Buffer based on bucket price (derived from market price) and vault policy. This mechanism effectively channels liquidity into the bucket that offers optimal yield within predefined bounds. The keeper is authorised in `VaultAuth`, runs on a fixed interval and follows strict bail-out conditions to avoid unsafe actions.

## Why it Exists

- Maintain a configured Buffer ratio for fast withdrawals.
- Consolidate liquidity toward an optimal yielding bucket.
- Skip actions when the vault or pool is not in a healthy state (paused, bad debt, out-of-range or dusty).

## What it Does

- On each run (`KEEPER_INTERVAL_MS`), the keeper executes a full decision tree - fetching vault, pool, and buffer state, then it decides whether to continue by checking whether the vault is paused, if the pool has bad debt, and if the optimal bucket is out of range or dusty. If all of these are false, it computes the buffer deficit or surplus targets, as well as the optimal bucket pricing, and executes a rebalancing; either between buckets, to the buffer or from the buffer as needed. The keeper then concludes with a logging of results for transparency.

## In-Range Boundaries in Ajna

In Ajna, all deposits above the Lowest Utilized Price (LUP) or the Threshold Price of the least collateralized loan, known as the Highest Threshold Price (HTP), earn interest, while deposits below earn no interest. A pool’s LUP is defined as the lowest collateral price against which someone is actively borrowing. Therefore, when a bucket is referred to as “in-range”, it means that it lies within the band of the Ajna pool where deposits actively earn interest and are considered valid for allocation. Expanding upon the boundary limits:
* The lower boundary is defined as the lowest price between the HTP and the LUP - typically the HTP beyond which, deposits will not be earning interest and need to be moved to a bucket in range.
* The max value, which is defined in the auth contract as the MIN_BUCKET_INDEX, is designed to allow the admin to prevent vault deposits from being lent at disadvantageous prices, and will typically be an index corresponding to a bucket below the current price of the asset.
* The optimal bucket will always fall within this range, and deposits in buckets within this range are not touched in keeper runs except to add to the buffer if necessary (i.e. when in deficit).

Due to LUP and HTP shifting dynamically with pool activity, the in-range boundaries may not be static and as such a target bucket may shift in or out of range over time, which the keeper needs to monitor.

## Technical Overview

1. Keeper-local configuration values (set in .env.example):

| Configuration Values                         | Description                                                                      | Type                     | Required/Optional                              | Default          |
| ------------------------------ | -------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------- | ---------------- |
| `RPC_URL`                      | RPC endpoint used for on-chain interactions.                                     | URL (`https://…`)        | Required                                   | None             |
| `SUBGRAPH_URL`                 | Subgraph endpoint for pool/vault state queries.                                  | URL (`https://…`)        | Required                                   | None             |
| `ORACLE_API_URL`               | API endpoint for off-chain price oracle using CoinGecko.                        | URL (`https://…`)        | Required                                   | None             |
| `QUOTE_TOKEN_ADDRESS`          | Address of the vault’s quote token.                                              | Ethereum address (`0x…`) | Required                                   | None             |
| `PRIVATE_KEY`                  | Private key of the keeper’s authorized account.                                  | Hex string (`0x…`)       | Required                                   | None             |
| `VAULT_ADDRESS`                | Address of the vault contract.                                                   | Ethereum address (`0x…`) | Required                                   | None             |
| `VAULT_AUTH_ADDRESS`           | Address of the vault auth contract.                                              | Ethereum address (`0x…`) | Required                                   | None             |
| `KEEPER_INTERVAL_MS`           | Interval between keeper runs.                                                    | Integer (milliseconds)   | Required                                   | 43,200,000 (12hours) |
| `OPTIMAL_BUCKET_DIFF`          | Offset (in bucket indexes) from current pool price to select the optimal bucket. | Integer                  | Required                                   | 4                |
| `CONFIRMATIONS`                | Number of block confirmations to wait for each tx.                               | Integer                  | Optional                                       | 1                |
| `LOG_LEVEL`                    | Minimum severity of logs (`info`, `warn`, `error`).                              | String                   | Optional                                       | `info`           |
| `MIN_MOVE_AMOUNT`              | Skip moves if bucket's quote token balance is below this amount (dust limit) - enforced by vault.    | Integer (WAD units)      | Optional                                       | 1,000,000        |
| `MIN_TIME_SINCE_BANKRUPTCY`    | Minimum time since bucket bankruptcy to be considered valid. Abort keeper run if timestamp is between this value and current time.                     | Integer (seconds)        | Optional                                       | 259,200  (72h)    |
| `MAX_AUCTION_AGE`              | Only consider auctions with bad debt if they are older than this value.                                    | Integer (seconds)        | Optional                                       | 259,200  (72h)    |
| `EXIT_ON_SUBGRAPH_FAILURE` | Abort run if the subgraph query fails during the check for bad debt in the pool. | String (`true`/`false`) | Optional | `false`
| `ORACLE_API_KEY`               | CoinGecko API key.                                                               | String                   | Optional                                       | None             |
| `ORACLE_KEY_TIER`              | CoinGecko tier (`demo`, `pro`).                                                  | String                   | Conditional (if `ORACLE_API_KEY` set)          | None             |
| `ONCHAIN_ORACLE_ADDRESS`       | Address of Chronicle on-chain oracle.                                            | Ethereum address (`0x…`) | Conditional (if `ONCHAIN_ORACLE_PRIMARY=true`) | None             |
| `ONCHAIN_ORACLE_PRIMARY`       | Use on-chain oracle as primary instead of CoinGecko.                             | String (`true`/`false`)   | Optional                                       | false            |
| `ONCHAIN_ORACLE_MAX_STALENESS` | Max allowed age of on-chain price data.                                          | Integer (seconds)        | Conditional (if `ONCHAIN_ORACLE_PRIMARY=true`) | 43,200 (12h)     |


2. Fetching State:
  * Vault Status and configuration:
    * `vault.paused()` - reads the vault's global pause flag; if true, all keeper actions will immediately exit with no state changes.
    * `vault.bufferRatio()` - returns the configured target share of total assets (in basis points) that should be held in the Buffer. The keeper uses this to calculate whether to top up or drain the Buffer during rebalancing.
    * `vault.minBucketIndex()` - returns the configured lower bound for bucket indexes (0 = no restriction). The keeper checks this to ensure the selected optimal bucket is not below the allowed minimum bound.
    * (If exposed) `vault.toll()`, `vault.tax()` - return the configured deposit fee and withdrawal fee (in basis points). These are applied directly by the vault on user deposits and withdrawals, not by the keeper.
  * Pool state
    * `getPrice()` -> `getPriceToIndex(price)` - returns the pool's current price; the keeper reads and converts this into the corresponding bucket index and then applies `OPTIMAL_BUCKET_DIFF` to select the target bucket for rebalancing.
    * `poolHasBadDebt()` - returns true if the pool has unresolved bad debt or active liquidation auctions; if so, the keeper exits immediately without rebalancing to avoid acting in an unhealthy pool state.
  * Buffer/Vault
    * `getBufferTotal()`, `getTotalAssets()` - return the Buffer's current balance and the vault's total assets. The keeper compares these values against `bufferRatio()` to decide whether to top up or drain the Buffer during rebalancing.
    * `getAssetDecimals()`, `getBufferRatio()` - return the asset's decimals and the configured buffer ratio. The keeper uses these to compute the Buffer target (`bufferTarget`) for rebalancing decisions.
    * `Buffer.lpToValue(uint256 lps)` - converts a given amount of LP tokens into the equivalent quote token value. The keeper uses this when sizing potential moves out of buckets, especially to check for "dusty" buckets below the minimum move threshold.
  * Range Math Utilities - from `vault/poolInfoUtils.ts` to derive safe bucket targets for rebalancing:
    * `getLup()` - returns the current LUP (Lowest Utilized Price) of the pool. This is the lowest price bucket where there is a utilized deposit and is used to evaluate safe lower bounds.
    * `getHtp()` - returns the HTP (Highest Threshold Price). This is the threshold price of the least collateralized loan. The keeper uses this to ensure target buckets are not placed above the active debt range.
    * `getPriceToIndex()` - converts a given price into the corresponding bucket index. The keeper uses this to translate the current pool price into an index before applying `OPTIMAL_BUCKET_DIFF`.
    * `getIndexToPrice()` - converts a given bucket index back into its price. The keeper uses this to verify or display the price level of the selected target bucket.

2. Early Fail or Skip Conditions:
    * If `vault.paused()` is true - the keeper exits immediately with no state changes.
    * If `poolHasBadDebt()` is true - the pool has unresolved bad debt or active liquidations, the keeper exits immediately.
    * If the computed optimal bucket is out of range (below `vault.minBucketIndex()` or above `getHtp()`), the keeper exits early with no moves, leaving bucket balances unchanged.
    * If the computed move size is below the keeper's configured minimum threshold, the action is skipped to avoid dust transfers.
    * If the optimal bucket is dusty (≤ 1,000,000 WAD of value) then the keeper skips to avoid operating on very small bucket amounts.

3. Compute Targets:
    * The keeper reads the current pool price (`getPrice()`), converts it to a bucket index (`getPriceToIndex(price)`), then applies an integer offset `OPTIMAL_BUCKET_DIFF` to produce `optimalBucket`, which `_getKeeperData()` stores for subsequent range checks.
    * Concurrent internal index calculations - `_getKeeperData()` computes `lupIndex`, `htpIndex`, and `optimalBucket` using `Promise.all`, and binds the third value to `optimalBucket`.
    * Buffer target (computed here) & gap (computed later) - `_getKeeperData()` computes `bufferTarget` via `_calculateBufferTarget()`, which multiplies total assets (scaled to WAD using asset decimals) by the configured `bufferRatio` and divides by 10,000 (basis points). It also reads `bufferTotal` with `getBufferTotal()`. The actual deficit/surplus ("gap") is only derived during rebalancing (e.g. `calculateBufferDeficit(data)`), so it is not stored in `_getKeeperData()`.
    * Per-bucket sizing - The keeper sizes per bucket moves by using `getQtValue(bucket)` which provides the quote value used to size moves, whereas `getLpToValue(optimalBucket)` is only used to detect dusty optimal and skip.
    * KeeperRunData payload - `_getKeeperData()` returns `{ buckets, bufferTotal, bufferTarget, price, lup, htp, lupIndex, htpIndex, optimalBucket }`.
    * The keeper then validates `optimalBucket` with `isOptimalBucketInRange(data)`; this uses `getIndexToPrice`, `getLup`, `getHtp`, and `getMinBucketIndex()`, where `buckets` is the per-bucket snapshot the sizing loop iterates over.

4. Execute Rebalancing:
    * If the Buffer is in deficit and below target, the keeper withdraws from out-of-range buckets into the Buffer until the deficit is closed. For each candidate bucket, if `bucket === optimalBucket` or `getQtValue(bucket) < MIN_MOVE_AMOUNT`or `isBucketInRange(bucket, data) === true`, it skips; otherwise it calls `vault.moveToBuffer(from=bucket, amount=min(getQtValue(bucket), remainingDeficit))`.
    * If the Buffer is not in deficit (i.e. at target), the keeper consolidates out-of-range buckets. For each bucket where `!isBucketInRange(...)`, if it is not the `optimalBucket` and `getQtValue(bucket) ≥ MIN_MOVE_AMOUNT`, call `vault.move(from=bucket, to=optimalBucket, amount=getQtValue(bucket))`, otherwise skip.
    * After covering deficits or consolidating, the keeper re-checks Buffer vs. target:
      * If there is a surplus in the Buffer, the keeper transfers the excess from the Buffer into the optimal bucket via `vault.moveFromBuffer(to=optimalBucket, amount=bufferTotal - bufferTarget)`.
      * If the buffer is still in deficit, the keeper continues pulling liquidity from out-of-range buckets into the Buffer with `vault.moveToBuffer(...)` until the gap is closed or no suitable buckets remain.
    * Guards per move (reads before each tx)
      * `shouldSkipBucket(bucket, data)` - returns `true` if the bucket is the `optimalBucket`, if `getQtValue(bucket) < MIN_MOVE_AMOUNT` (dust), or if `isBucketInRange(bucket, data)` is `true`. Otherwise, the bucket is a candidate for moves.
      * `isBucketInRange(bucketPrice, data)` - returns `true` if the bucket's price lies within `[max(LUP, priceAt(minBucketIndex)), min(currentPrice, HTP)]`. Buckets outside this range are considered out-of-range and eligible for rebalancing.

5. Housekeeping & Telemetry:
    * Vault events & functions:
      * `Move(fromBucket, toBucket, amount)` - vault function and event that shifts liquidity directly between buckets. The keeper uses it when consolidating out-of-range buckets into the `optimalBucket` without touching the Buffer.
      * `MoveFromBuffer(toBucket, amount)` - vault function and event that moves liquidity out of the Buffer into a bucket. The keeper calls this to drain Buffer surplus or to place funds into the `optimalBucket`.
      * `MoveToBuffer(fromBucket, amount)` - vault function and event that withdraws liquidity from a bucket into the Buffer; the keeper uses it to top up the Buffer or cover a deficit.
    * Off-chain logs (via keeper `log` and `handleTransaction`)
      * Run-level:
        * `keeper_run_succeeded` - final state with buffer total, buffer target, current price, and optimal bucket.
        * `keeper_run_failed` - run aborted with error details.
        * `keeper_stopping` - process shutdown (SIGINT/SIGTERM).
      * Transactions:
        * `tx_success` - successful tx with hash, block, action (`move`, `moveToBuffer`, `moveFromBuffer`), amount, and from/to buckets.
        * `tx_failed` - failed tx with phase (`send`, `fail`, `revert`), hash, receipt, and context.
      * Warnings:
        * `buffer_imbalance` - emitted when the Buffer total does not match the computed bufferTarget after rebalancing (indicating a residual surplus/deficit).

## Local Set Up

#### Install dependencies:

```
pnpm install --frozen-lockfile --ignore-scripts
```

#### Install submodules:

```
git submodule update --init --recursive
```

#### Build:

```
pnpm build
```

#### Docker:

If using Docker, the above steps can be skipped. Instead, build locally with:

```
pnpm docker:build:local
```

Or build for production using:

```
pnpm docker:build:prod
```

Note that local builds inject `.env`, while production builds expect environment variables to be provided at runtime.

After building, run the keeper locally with:

```
pnpm docker:run:local
```

There is no default script for using Docker to run the keeper in production, since this is likely to be environment-specific.

## Configure Environment

Locally, you can define necessary values in `.env`. In production, these should be provided at runtime from the deployment environment.

To do this locally:

```
cp .env.example .env
```

Then replace the placeholder values in `.env`.

## Run Tests

First, complete the above steps for local configuration and set up. Then, install `foundryup`:

```
curl -L https://foundry.paradigm.xyz | bash
```

After following the instructions that will appear from `foundryup`, install the vault's submodules:

```
cd lib/4626-ajna-vault/
forge install
```

Then (after navigating back to the root of the keeper repo) run the tests:

```
pnpm test
```
