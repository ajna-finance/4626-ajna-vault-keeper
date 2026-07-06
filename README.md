# 4626 Ajna Vault Keeper

## Table of Contents

- [Overview](#overview)
- [Why it Exists](#why-it-exists)
- [What it Does](#what-it-does)
- [In-Range Boundaries in Ajna](#in-range-boundaries-in-ajna)
- [Technical Overview](#technical-overview)
  - [1. Configuration](#technical-overview-1-configuration)
      - [Environment Variables](#environment-variables)
      - [Credential Modes](#credential-modes)
      - [Config Values](#config-values)
  - [2. Fetching State](#technical-overview-2-fetching-state)
  - [3. Early Fail or Skip Conditions](#technical-overview-3-early-fail-or-skip-conditions)
  - [4. Compute Targets](#technical-overview-4-compute-targets)
  - [5. Execute Rebalancing](#technical-overview-5-execute-rebalancing)
  - [6. Housekeeping and Telemetry](#technical-overview-6-housekeeping-and-telemetry)
- [Local Set Up](#local-set-up)
- [Docker](#docker)
- [Configure Environment](#configure-environment)
- [Deployment Requirements](#deployment-requirements)
- [Operator Responsibilities](#operator-responsibilities)
- [Failure and Recovery](#failure-and-recovery)
- [Run Tests](#run-tests)

## <a name="overview"></a>Overview

The Ajna vault keeper is a permissioned offchain agent that manages an ERC-4626 vault system built on the Ajna lending protocol. It runs two keepers on a shared interval. The metavault keeper allocates capital across multiple Ajna vaults, referred to here as ARKs, through an Euler Earn contract, rebalancing based on borrow fee rates and configured allocation limits. The ARK keeper then runs for each individual ARK, moving quote tokens between Ajna buckets and the Buffer based on bucket price derived from market price and vault policy. Together, these keepers channel liquidity toward optimal yield at both the cross-vault and intra-pool levels within predefined bounds. Both keepers are authorised in their respective contracts, run on a fixed interval and follow strict bail-out conditions to avoid unsafe actions.

## <a name="why-it-exists"></a>Why it Exists

- Allocate capital across multiple Ajna vaults based on borrow fee rates.
- Maintain configured allocation bounds (min/max per ARK, buffer target) at the metavault level.
- Maintain a configured Buffer ratio for fast withdrawals at the ARK level.
- Consolidate liquidity toward an optimal yielding bucket within each ARK.
- Skip actions when the vault or pool is not in a healthy state (paused, bad debt, out-of-range or dusty).

## <a name="what-it-does"></a>What it Does

On each run, the keeper checks whether a metavault is configured. If so, the metavault keeper runs first, followed by the ARK keeper for each configured ARK. The metavault keeper can also be omitted entirely by leaving the metavault address out of the config, in which case only the ARK keeper runs.

**Metavault keeper:** Reads the current balance and borrow fee rate for each ARK, then determines whether any reallocation is needed. It first enforces allocation bounds by capping ARKs that exceed their maximum and filling or draining the buffer to its target percentage. It then evaluates rates across ARKs and moves capital from lower-rate ARKs to higher-rate ARKs when the rate difference exceeds a configured threshold (`minRateDiff`). For any ARK whose allocation needs to decrease, the metavault keeper executes onchain `drain` and `moveToBuffer` calls to free funds from the appropriate buckets. Finally, it builds a set of ordered allocations and calls `reallocate()` on the Euler Earn contract.

**ARK keeper:** For each ARK, the keeper executes a full decision tree, fetching vault, pool, and buffer state, then deciding whether to continue by checking whether the vault is paused, if the pool has bad debt, and if the optimal bucket is out of range or dusty. If all of these are false, it computes the buffer deficit or surplus targets, as well as the optimal bucket pricing, and executes rebalancing between buckets and the buffer as needed. The keeper then concludes with logging of results for transparency.

## <a name="in-range-boundaries-in-ajna"></a>In-Range Boundaries in Ajna

In Ajna, all deposits above the Lowest Utilized Price (LUP) or the Threshold Price of the least collateralized loan, known as the Highest Threshold Price (HTP), earn interest, while deposits below earn no interest. A pool's LUP is defined as the lowest collateral price against which someone is actively borrowing. Therefore, when a bucket is referred to as "in-range", it means that it lies within the band of the Ajna pool where deposits actively earn interest and are considered valid for allocation. Expanding upon the boundary limits:
* The lower boundary is defined as the lowest price between the HTP and the LUP - typically the HTP beyond which, deposits will not be earning interest and need to be moved to a bucket in range.
* The max value, which is defined in the auth contract as the MIN_BUCKET_INDEX, is designed to allow the admin to prevent vault deposits from being lent at disadvantageous prices, and will typically be an index corresponding to a bucket below the current price of the asset.
* The optimal bucket will always fall within this range, and deposits in buckets within this range are not touched in keeper runs except to add to the buffer if necessary (i.e. when in deficit).

Due to LUP and HTP shifting dynamically with pool activity, the in-range boundaries may not be static and as such a target bucket may shift in or out of range over time, which the keeper needs to monitor.

## <a name="technical-overview"></a>Technical Overview

1. <a name="technical-overview-1-configuration"></a>Configuration is split between `.env` (secrets and infrastructure) and `config.json` (operational parameters). Secrets stay in `.env` and should never be committed. All other configuration lives in `config.json`.

    <a name="environment-variables"></a>**Environment variables (set in `.env`):**

    | Variable                         | Description                                                                      | Type                     | Required/Optional                              | Default          |
    | -------------------------------- | -------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------- | ---------------- |
    | `RPC_URL`                        | RPC endpoint used for onchain interactions.                                      | URL (`https://...`)      | Required                                       | None             |
    | `SUBGRAPH_URL`                   | Subgraph endpoint for pool/vault state queries.                                  | URL (`https://...`)      | Required                                       | None             |
    | `CONFIG_PATH`                    | Optional path to the runtime `config.json` file. Useful when the config is mounted somewhere other than the working directory, such as inside a container. | String (file path)       | Optional                                       | `./config.json`  |
    | `PRIVATE_KEY`                    | Raw private key of the keeper's authorized account. Intended as a headless fallback when the deployer injects it from a secret manager. | Hex string (`0x...`)     | Conditional (exactly one credential mode must be configured) | None             |
    | `KEYSTORE_PATH`                  | Path to an Ethereum V3 keystore file. If set, the keeper prompts for the password on startup. Best suited to local/operator use. | String (file path)       | Conditional (exactly one credential mode must be configured) | None             |
    | `REMOTE_SIGNER_URL`              | Web3Signer-compatible JSON-RPC endpoint used only for signing transactions. Reads, fee estimation, waits, and broadcast still use `RPC_URL`. | URL (`https://...`)      | Conditional (`REMOTE_SIGNER_URL` and `REMOTE_SIGNER_ADDRESS` must be set together as one credential mode) | None             |
    | `REMOTE_SIGNER_ADDRESS`          | EOA address exposed by the remote signer and used as `client.account.address`.   | Ethereum address (`0x...`) | Conditional (`REMOTE_SIGNER_URL` and `REMOTE_SIGNER_ADDRESS` must be set together as one credential mode) | None             |
    | `REMOTE_SIGNER_ALLOW_INSECURE`   | Escape hatch that allows `REMOTE_SIGNER_URL` to use plaintext `http://`. Only the literal string `true` enables it. Intended for local testing; emits a startup warning when active. | Boolean (`true` only) | Optional | `false` |
    | `REMOTE_SIGNER_AUTH_TOKEN`       | Optional bearer token sent as `Authorization: Bearer <token>` on every signer request. Useful when the signer (or a fronting proxy) requires a static token or API key. Redacted from logs. | String                   | Optional                                       | None             |
    | `REMOTE_SIGNER_TLS_CLIENT_CERT`  | Path to a PEM file containing the client certificate the keeper presents to the signer for mTLS. Must be set together with `REMOTE_SIGNER_TLS_CLIENT_KEY`. | String (file path)       | Optional (paired with `REMOTE_SIGNER_TLS_CLIENT_KEY`) | None             |
    | `REMOTE_SIGNER_TLS_CLIENT_KEY`   | Path to a PEM file containing the client private key matching `REMOTE_SIGNER_TLS_CLIENT_CERT`. | String (file path)       | Optional (paired with `REMOTE_SIGNER_TLS_CLIENT_CERT`) | None             |
    | `REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD` | Optional passphrase for an encrypted client key. Only allowed when `REMOTE_SIGNER_TLS_CLIENT_KEY` is set. Redacted from logs. | String                   | Optional                                       | None             |
    | `REMOTE_SIGNER_TLS_CA`           | Path to a PEM file containing CA certificate(s) used to verify the signer's server certificate. Useful when the signer is issued by a private CA. When set, this **replaces** Node's default trust store (it does not augment it); concatenate the system CA bundle into the file if you also need to trust public CAs. When omitted, Node's default trust store is used. | String (file path)       | Optional                                       | None             |
    | `ORACLE_API_KEY`                 | CoinGecko API key.                                                               | String                   | Optional                                       | None             |
    | `ORACLE_API_TIER`                | CoinGecko tier (`demo`, `pro`).                                                  | String                   | Conditional (if `ORACLE_API_KEY` set)          | None             |
    | `MAINNET_RPC_URL`                | Since the RPC node defined here may refer to any chain, the test suite needs a mainnet RPC for set up. By default, the test suite uses the free node at 'https://eth.drpc.org', but this node is rate-limited, which may cause unexpected test failures. To avoid this, another RPC can be defined here. | String | Optional | None |

    <a name="credential-modes"></a>**Credential modes (mutually exclusive):**

    | Mode | Variables | Recommended use |
    | ---- | --------- | --------------- |
    | Remote signer | `REMOTE_SIGNER_URL` + `REMOTE_SIGNER_ADDRESS` | Preferred production posture where available. The keeper talks to a Web3Signer-compatible signer service, so the signing key can stay externalized. |
    | Local keystore | `KEYSTORE_PATH` | Local/operator mode. Startup is interactive: the keystore password is prompted on boot. |
    | Raw private key | `PRIVATE_KEY` | Headless fallback when the deployer must inject the key directly from a secret manager. |

    Remote signer mode is the strongest supported production posture in this repo. Direct AWS KMS integration is not implemented in the keeper itself, but AWS KMS, Vault, and similar custody systems can back a compatible signer service. The minimum expectation is a reachable Web3Signer-compatible JSON-RPC endpoint that signs for the EOA configured in `REMOTE_SIGNER_ADDRESS`. The signer must have `eth_sign` enabled for the keeper EOA, since the keeper performs an `eth_sign`-based identity verification at startup and will fail to boot if the signer rejects it. The keeper enforces `https` on `REMOTE_SIGNER_URL` by default; plaintext `http` is rejected at startup unless `REMOTE_SIGNER_ALLOW_INSECURE=true` is set as a deliberate escape hatch for local testing. The signer endpoint should stay on a restricted internal network or equivalent access-controlled path, not on the public internet.

    Two transport-layer auth options are supported and can be combined. `REMOTE_SIGNER_AUTH_TOKEN` adds an `Authorization: Bearer <token>` header to every signer request and is the simplest posture, well suited to deployments where an auth-terminating proxy or the signer itself accepts a static token or API key. mTLS via the `REMOTE_SIGNER_TLS_*` variables is the strongest posture and matches the standard production setup for Web3Signer: the keeper presents a client certificate (`CERT` + `KEY`, optionally encrypted with `KEY_PASSWORD`) and may verify the signer with a private CA bundle (`CA`). All TLS material must be provided as PEM files; if you have a PKCS#12 keystore you can extract PEM with `openssl pkcs12 -in keystore.p12 -out client.pem`. Use the bearer token when the signer or its proxy already terminates auth itself, and prefer mTLS when the signer is reachable directly and supports it. Combining `REMOTE_SIGNER_AUTH_TOKEN` with `REMOTE_SIGNER_ALLOW_INSECURE` sends the token over plaintext http, so that combination should be limited to local testing.

    <a name="config-values"></a>**Config values (set in `config.json`):**

    | Config Key                       | Description                                                                      | Type                     | Required/Optional                              | Default          |
    | -------------------------------- | -------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------- | ---------------- |
    | `chainId`                        | Chain ID for the intended network.                                               | Integer                  | Optional                                       | 1 (Ethereum mainnet) |
    | `quoteTokenAddress`              | Address of the vault's quote token.                                              | Ethereum address (`0x...`) | Required                                     | None             |
    | `metavaultAddress`               | Address of the Euler Earn (metavault) contract. If omitted, only the ARK keeper runs. | Ethereum address (`0x...`) | Optional                                   | None             |
    | `keeper.intervalMs`              | Interval between keeper runs.                                                    | Integer (milliseconds)   | Required                                       | 43,200,000 (12h) |
    | `keeper.logLevel`                | Minimum severity of logs (`info`, `warn`, `error`).                              | String                   | Optional                                       | `info`           |
    | `keeper.exitOnSubgraphFailure`   | Abort run if the subgraph query fails during the check for bad debt in the pool. The default is fail-closed. Set this to `false` only if you explicitly prefer availability over the bad-debt guard during subgraph outages. | Boolean                  | Optional                                       | `true`           |
    | `keeper.haltIfLupBelowHtp`       | If operations trigger `LUPBelowHTP` error from Ajna, halt keeper until restarted to prevent more tokens from being added to the pool while move targets are likely to require liquidations. | Boolean | Required                      | N/A              |
    | `oracle.apiUrl`                  | API endpoint for offchain price oracle using CoinGecko.                          | URL (`https://...`)      | Conditional (if onchain oracle is not primary and no fixed price is set) | None |
    | `oracle.onchainPrimary`          | Use onchain oracle as primary instead of CoinGecko.                              | Boolean                  | Required                                       | N/A              |
    | `oracle.onchainAddress`          | Address of Chronicle onchain oracle.                                             | Ethereum address (`0x...`) | Conditional (if `onchainPrimary` is true)    | None             |
    | `oracle.onchainMaxStaleness`     | Max allowed age of onchain price data. When omitted and the onchain oracle is primary, the keeper defaults this to `86400` seconds. Set to `null` only to explicitly disable the staleness check. | Integer (seconds) or `null` | Optional                                  | `86400` when `oracle.onchainPrimary` is `true`, otherwise `null` |
    | `oracle.offchainMaxStaleness`    | Max allowed age of CoinGecko price data based on the response `last_updated_at` timestamp. | Integer (seconds)        | Optional                                       | `86400`          |
    | `oracle.fixedPrice`              | The keeper can be configured to skip both oracles and use a hard-coded price, defined here. Set to `null` to use the live oracle. The value is parsed as a decimal string into Ajna's 18-decimal price domain, independent of quote-token decimals. Numeric literals are rejected to avoid precision loss. When enabled, the keeper emits a startup warning because this mode bypasses live oracle checks. | String decimal (e.g. `"1.00"`) or `null` | Optional | `null` |
    | `oracle.futureSkewTolerance`     | Max clock drift allowed from Chronicle timestamps.                               | Integer (seconds)        | Optional                                       | 120 (2 minutes)  |
    | `transaction.gasBuffer`          | Accounts for occasional Viem gas underestimation for the functions that interact with Ajna, resulting in sporadic `OutOfGas` reversions. | Integer (percentage)     | Optional                                       | 50 (50%)         |
    | `transaction.defaultGas`         | Default gas limit in the event that gas estimation with the above buffer fails.  | Integer                  | Optional                                       | 1,500,000        |
    | `transaction.confirmations`      | Number of block confirmations to wait for each tx.                               | Integer                  | Required                                       | N/A              |
    | `remoteSigner.requestTimeoutMs`  | Per-request timeout applied to every remote signer JSON-RPC call. Bounded above by `keeper.intervalMs` so a hung signer cannot pin the keeper across runs. Only consulted when remote signer credential mode is in use. | Integer (milliseconds) | Optional                                       | 30,000 (30s)     |
    | `arkGlobal.optimalBucketDiff`    | Offset (in bucket indexes) from current pool price to select the optimal bucket. Can also be set per ARK. | Integer | Conditional (required globally or per ARK) | None             |
    | `arkGlobal.bufferPadding`        | Accounts for the slight variation in the value of `totalAssets` (due to interest accruing in Ajna). | String (`WAD`)  | Optional                                       | `"100000000000000"` (1e14) |
    | `arkGlobal.minMoveAmount`        | Skip moves if bucket's quote token balance is below this amount (dust limit) - enforced by vault. | String (`WAD` units)    | Optional                                       | `"1000001"`      |
    | `arkGlobal.minTimeSinceBankruptcy` | Minimum time since bucket bankruptcy to be considered valid. Abort keeper run if timestamp is between this value and current time. | Integer (seconds) | Optional                        | 259,200 (72h)    |
    | `arkGlobal.maxAuctionAge`        | Treat active debt auctions as stale after this age. Zero-collateral bad debt is checked immediately. | Integer (seconds)        | Optional                                       | 259,200 (72h)    |
    | `arks[].address`                 | Address of the ARK, which is the Ajna vault strategy registered in the metavault. | Ethereum address (`0x...`) | Required                                     | None             |
    | `arks[].vaultAddress`            | Address of the ARK's vault contract.                                             | Ethereum address (`0x...`) | Required                                     | None             |
    | `arks[].vaultAuthAddress`        | Address of the ARK's vault auth contract.                                        | Ethereum address (`0x...`) | Required                                     | None             |
    | `arks[].allocation.min`          | Minimum allocation percentage for this ARK.                                      | Integer (percentage)     | Required                                       | N/A              |
    | `arks[].allocation.max`          | Maximum allocation percentage for this ARK. Must not be 0.                       | Integer (percentage)     | Required                                       | N/A              |
    | `arks[].optimalBucketDiff`       | Per-ARK override for `arkGlobal.optimalBucketDiff`.                              | Integer                  | Optional                                       | `arkGlobal` value |
    | `arks[].bufferPadding`           | Per-ARK override for `arkGlobal.bufferPadding`.                                  | String (`WAD`)           | Optional                                       | `arkGlobal` value |
    | `arks[].minMoveAmount`           | Per-ARK override for `arkGlobal.minMoveAmount`.                                  | String (`WAD` units)     | Optional                                       | `arkGlobal` value |
    | `arks[].minTimeSinceBankruptcy`  | Per-ARK override for `arkGlobal.minTimeSinceBankruptcy`.                         | Integer (seconds)        | Optional                                       | `arkGlobal` value |
    | `arks[].maxAuctionAge`           | Per-ARK override for `arkGlobal.maxAuctionAge`.                                  | Integer (seconds)        | Optional                                       | `arkGlobal` value |
    | `buffer.address`                 | Address of the buffer strategy registered in the metavault.                      | Ethereum address (`0x...`) | Required                                     | None             |
    | `buffer.allocation`              | Target allocation percentage for the buffer.                                     | Integer (percentage)     | Required                                       | N/A              |
    | `minRateDiff`                    | Minimum percentage difference in borrow fee rates between two ARKs before capital is reallocated from the lower-rate ARK to the higher-rate ARK. | Integer (percentage) | Optional               | 10               |

    The sum of all `arks[].allocation.max` values plus `buffer.allocation` must equal 100. Per-ARK settings (`optimalBucketDiff`, `bufferPadding`, `minMoveAmount`, `minTimeSinceBankruptcy`, `maxAuctionAge`) can be set globally in `arkGlobal` or individually per ARK. Per-ARK values take precedence over global values.

2. <a name="technical-overview-2-fetching-state"></a>Fetching State:

    **Metavault keeper:**
    * `getExpectedSupplyAssets(strategy)` - reads the current balance for each strategy, meaning each ARK and the buffer, from the Euler Earn contract. The sum of all strategy balances is the total assets under management.
    * `vault.getBorrowFeeRate()` - reads the borrow fee rate from the Ajna pool associated with each ARK. This rate is used to compare yield across ARKs and decide whether reallocation is warranted.
    * `poolHasBadDebt(vault)` - checks each ARK's pool for bad debt, using the same check as the ARK keeper. ARKs with bad debt are excluded from receiving capital during reallocation.
    * `poolBalanceCap(balance, vault)` - caps each ARK's balance to the actual quote token balance in its pool, preventing the keeper from planning moves for tokens that are not currently available.

    **ARK keeper:**
    
    * Vault Status and configuration:
      * `vault.paused()` - reads the vault's global pause flag. If true, all keeper actions will immediately exit with no state changes.
      * `vault.bufferRatio()` - returns the configured target share of total assets (in basis points) that should be held in the Buffer. The keeper uses this to calculate whether to top up or drain the Buffer during rebalancing.
      * `vault.minBucketIndex()` - returns the configured lower bound for bucket indexes (0 = no restriction). The keeper checks this to ensure the selected optimal bucket is not below the allowed minimum bound.
      * (If exposed) `vault.toll()`, `vault.tax()` - return the configured deposit fee and withdrawal fee (in basis points). These are applied directly by the vault on user deposits and withdrawals, not by the keeper.
    * Pool state
      * `getPrice()` -> `getPriceToIndex(price)` - returns the pool's current price. The keeper reads and converts this into the corresponding bucket index and then applies `optimalBucketDiff` to select the target bucket for rebalancing.
      * `poolHasBadDebt()` - returns true if the pool has unresolved bad debt or active liquidation auctions. If so, the keeper exits immediately without rebalancing to avoid acting in an unhealthy pool state.
    * Buffer/Vault
      * `getBufferTotal()`, `getTotalAssets()` - return the Buffer's current balance and the vault's total assets. The keeper compares these values against `bufferRatio()` to decide whether to top up or drain the Buffer during rebalancing.
      * `getAssetDecimals()`, `getBufferRatio()` - return the asset's decimals and the configured buffer ratio. The keeper uses these to compute the Buffer target (`bufferTarget`) for rebalancing decisions.
      * `Buffer.lpToValue(uint256 lps)` - converts a given amount of LP tokens into the equivalent quote token value. The keeper uses this when sizing potential moves out of buckets, especially to check for "dusty" buckets below the minimum move threshold.
    * Range Math Utilities - from `vault/poolInfoUtils.ts` to derive safe bucket targets for rebalancing:
      * `getLup()` - returns the current LUP (Lowest Utilized Price) of the pool. This is the lowest price bucket where there is a utilized deposit and is used to evaluate safe lower bounds.
      * `getHtp()` - returns the HTP (Highest Threshold Price). This is the threshold price of the least collateralized loan. The keeper uses this to ensure target buckets are not placed above the active debt range.
      * `getPriceToIndex()` - converts a given price into the corresponding bucket index. The keeper uses this to translate the current pool price into an index before applying `optimalBucketDiff`.
      * `getIndexToPrice()` - converts a given bucket index back into its price. The keeper uses this to verify or display the price level of the selected target bucket.

3. <a name="technical-overview-3-early-fail-or-skip-conditions"></a><a name="exit-conditions"></a>Early Fail or Skip Conditions:

    **Metavault keeper:**
    * If any ARK is paused, the metavault keeper skips the entire run.
    * If a `drain` or `moveToBuffer` call fails while withdrawing from a decreasing ARK back into the buffer, the run is aborted before any `reallocate` call is issued.
    * If the planned reallocation would violate an ARK's allocation bounds, below min or above max, the run is aborted with an error.
    * If the total withdrawn does not equal the total supplied after computing allocations - the run is aborted due to an inconsistent reallocation invariant.
    * If the `reallocate` call itself reverts, the run is aborted.
    * If no allocations need to change - the run exits cleanly with no state changes.

    **ARK keeper:**
    
    * If `vault.paused()` is true - the keeper exits immediately with no state changes.
    * If `poolHasBadDebt()` is true - the pool has unresolved bad debt or active liquidations, the keeper exits immediately.
    * If the computed optimal bucket is out of range (below `vault.minBucketIndex()` or above `getHtp()`), the keeper exits early with no moves, leaving bucket balances unchanged.
    * If the computed move size is below the keeper's configured minimum threshold, the action is skipped to avoid dust transfers.
    * If the optimal bucket is dusty (below the dust threshold in LP tokens) then the keeper skips to avoid operating on very small bucket amounts.
    * If the optimal bucket has been bankrupt more recently than the configured `minTimeSinceBankruptcy`, the run is aborted to prevent risky deposits.
    * If the optimal bucket's debt is locked due to an ongoing auction (i.e., withdrawals from the bucket would revert in Ajna with `RemoveDepositLockedByAuctionDebt()`), the run is aborted to prevent locking vault funds in the bucket.
    * If a `drain` or `updateInterest` transaction fails at any point in the run, the run is aborted to keep the keeper from operating against a partially completed move.

4. <a name="technical-overview-4-compute-targets"></a>Compute Targets:

    **Metavault keeper:**
    * Buffer target is computed as `(totalAssets * buffer.allocation) / 100`. The metavault keeper first caps any ARKs exceeding their max allocation, then fills or drains the buffer to its target by pulling from or pushing to ARKs sorted by rate. Lowest-rate ARKs are drained first and highest-rate ARKs are filled first.
    * Rate evaluation compares borrow fee rates across ARKs. For each ARK, the keeper identifies all other ARKs whose rate exceeds the current ARK's rate by at least `minRateDiff` percent. The threshold check is: `targetRate * 100 >= originRate * (100 + minRateDiff)`.
    * When reallocating for rates, the keeper processes ARKs from lowest rate to highest. For each ARK with available funds above its min allocation, it moves capital to higher-rate targets, sorted by rate descending, up to each target's max allocation. ARKs with bad debt are skipped.

    **ARK keeper:**
    
    * The keeper reads the current pool price (`getPrice()`), normalizes offchain and fixed-price inputs into Ajna's 18-decimal price domain, converts that price to a bucket index (`getPriceToIndex(price)`), then applies an integer offset `optimalBucketDiff` to produce `optimalBucket`, which `_getKeeperData()` stores for subsequent range checks.
    * Concurrent internal index calculations - `_getKeeperData()` computes `lupIndex`, `htpIndex`, and `optimalBucket` using `Promise.all`, and binds the third value to `optimalBucket`.
    * Buffer target (computed here) & gap (computed later) - `_getKeeperData()` computes `bufferTarget` via `_calculateBufferTarget()`, which multiplies total assets (scaled to WAD using asset decimals) by the configured `bufferRatio` and divides by 10,000 (basis points). It also reads `bufferTotal` with `getBufferTotal()`. The actual deficit/surplus ("gap") is only derived during rebalancing (e.g. `calculateBufferDeficit(data)`), so it is not stored in `_getKeeperData()`.
    * Per-bucket sizing - The keeper sizes per bucket moves by using `lpToValue(bucket)` which provides the quote value used to size moves, whereas `getLpToValue(optimalBucket)` is only used to detect dusty optimal and skip.
    * KeeperRunData payload - `_getKeeperData()` returns `{ buckets, bufferTotal, bufferTarget, price, lup, htp, lupIndex, htpIndex, optimalBucket }`.
    * The keeper then validates `optimalBucket` with `isOptimalBucketInRange(data)`. This uses `getIndexToPrice`, `getLup`, `getHtp`, and `getMinBucketIndex()`, where `buckets` is the per-bucket snapshot the sizing loop iterates over.

5. <a name="technical-overview-5-execute-rebalancing"></a>Execute Rebalancing:

    **Metavault keeper:**
    * For each ARK whose computed allocation decreased, the metavault keeper determines which buckets to withdraw from using `selectBuckets(vault, amountToMove)`. This function selects the optimal set of buckets to satisfy the withdrawal amount: if a single bucket has enough value, it is used, preferring the lowest-price bucket among candidates. Otherwise, the function fills greedily from the largest-value buckets first. In all cases, if a partial withdrawal would leave behind LP tokens below the dust threshold, the full bucket value is taken instead.
    * For each selected bucket, the keeper calls `vault.drain(bucket)` to claim pending interest, then `vault.moveToBuffer(bucket, amount)` to move the funds into the buffer.
    * After all `moveToBuffer` calls complete, the keeper builds the final allocation array for the `reallocate()` call. Decreasing allocations are ordered first (withdrawals), then increasing allocations (deposits). The last increasing allocation uses `maxUint256` to absorb rounding dust. The keeper validates that the total withdrawn equals the total supplied before submitting.
    * The `reallocate()` call on the Euler Earn contract atomically redistributes capital across all strategies according to the new allocations.

    **ARK keeper:**
    
    * If the Buffer is in deficit and below target, the keeper withdraws from out-of-range buckets into the Buffer until the deficit is closed. For each candidate bucket, if `bucket === optimalBucket` or `lpToValue(bucket) < minMoveAmount` or `isBucketInRange(bucket, data) === true`, it skips. Otherwise it calls `vault.moveToBuffer(from=bucket, amount=min(lpToValue(bucket), remainingDeficit))`.
    * If the Buffer is not in deficit (i.e. at target), the keeper consolidates out-of-range buckets. For each bucket where `!isBucketInRange(...)`, if it is not the `optimalBucket` and `lpToValue(bucket) >= minMoveAmount`, call `vault.move(from=bucket, to=optimalBucket, amount=lpToValue(bucket))`, otherwise skip.
    * After covering deficits or consolidating, the keeper re-checks Buffer vs. target:
      * If there is a surplus in the Buffer, the keeper transfers the excess from the Buffer into the optimal bucket via `vault.moveFromBuffer(to=optimalBucket, amount=bufferTotal - bufferTarget)`.
      * If the buffer is still in deficit, the keeper continues pulling liquidity from out-of-range buckets into the Buffer with `vault.moveToBuffer(...)` until the gap is closed or no suitable buckets remain.
    * Guards per move (reads before each tx)
      * `shouldSkipBucket(bucket, data)` - returns `true` if the bucket is the `optimalBucket`, if `lpToValue(bucket) < minMoveAmount` (dust), or if `isBucketInRange(bucket, data)` is `true`. Otherwise, the bucket is a candidate for moves.
      * `isBucketInRange(bucketPrice, data)` - returns `true` if the bucket's price lies within `[max(LUP, priceAt(minBucketIndex)), min(currentPrice, HTP)]`. Buckets outside this range are considered out-of-range and eligible for rebalancing.

6. <a name="technical-overview-6-housekeeping-and-telemetry"></a>Housekeeping & Telemetry:
    * Vault events & functions:
      * `Move(fromBucket, toBucket, amount)` - vault function and event that shifts liquidity directly between buckets. The keeper uses it when consolidating out-of-range buckets into the `optimalBucket` without touching the Buffer.
      * `MoveFromBuffer(toBucket, amount)` - vault function and event that moves liquidity out of the Buffer into a bucket. The keeper calls this to drain Buffer surplus or to place funds into the `optimalBucket`.
      * `MoveToBuffer(fromBucket, amount)` - vault function and event that withdraws liquidity from a bucket into the Buffer. The keeper uses it to top up the Buffer or cover a deficit.
    * Logs (pino-formatted JSON, filterable by event field):
      * Info events:
          * `ark_run_complete` - final state for an ARK run with buffer total, buffer target, current price, and optimal bucket.
          * `metavault_run_complete` - metavault reallocation completed with final allocations.
          * `no_metavault_reallocation_needed` - metavault run determined no reallocation is needed.
          * `paused_arks_detected` - one or more ARKs are paused, metavault run skipped.
          * `keeper_stopping` - process shutdown (SIGINT/SIGTERM).
          * `keeper_price_fixed` - keeper is bypassing price fetch and using the value defined in the config.
          * `tx_success` - successful tx with hash, block, action (`move`, `moveToBuffer`, `moveFromBuffer`, `drain`, `reallocate`), amount, and from/to buckets.
      * Warnings:
          * `ark_run_halted` - emitted when the ARK keeper is halted due to a `LUPBelowHTP` error. The keeper will not run again until the process is restarted.
          * `subgraph_fail_open_enabled` - emitted at startup when `keeper.exitOnSubgraphFailure` is set to `false`, meaning subgraph query failures will be treated as if there are no auctions.
          * `oracle_staleness_check_disabled` - emitted at startup when the Chronicle stale-price check has been explicitly disabled with `oracle.onchainMaxStaleness: null`.
          * `oracle_fixed_price_enabled` - emitted at startup when `oracle.fixedPrice` is configured and the keeper will bypass live oracle reads.
          * `price_query_failed` - query failed for the first of the two configured price feeds.
          * `gas_estimation_failed` - Viem gas estimation for vault functions failed, indicating that the keeper will fall back to the hard-coded value.
      * Errors:
          * `ark_run_aborted` - emitted when an ARK keeper run exits early for any of the reasons specified above in [Early Fail or Skip Conditions](#exit-conditions).
          * `metavault_run_aborted` - metavault run aborted with the reason.
          * `keeper_run_failed` - run aborted with error details (scheduler-level catch).
          * `tx_failed` - failed tx with phase (`send`, `fail`, `revert`, `insufficient_funds`), hash, receipt, and context.
          * `subgraph_query_failed` - query for open auctions via configured subgraph threw an error.
      * Fatal:
          * `uncaught_exception` - an unhandled error crashed the keeper process.
          * `unhandled_rejection` - an unhandled promise rejection crashed the keeper process.

## <a name="local-set-up"></a>Local Set Up

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

#### Import a private key to a keystore (local mode):

As an alternative to defining `PRIVATE_KEY` directly in `.env`, a private key can be encrypted into an Ethereum V3 keystore file. This avoids storing the raw key on disk for local environments. To import:

```
pnpm import-key
```

This will prompt for the private key and a password, then write the encrypted keystore file. Set `KEYSTORE_PATH` in `.env` to the path of the generated file. On startup, the keeper will prompt for the password to decrypt it.

## <a name="docker"></a>Docker

The Docker image only contains the compiled keeper and its production dependencies. It does not bake `.env` or `config.json` into build layers or the final runtime image.

Build the image with:

```
pnpm docker:build
```

Then run it by injecting environment variables at runtime and mounting the keeper config:

```
pnpm docker:run
```

Equivalent explicit `docker run` command:

```
docker run --rm \
  --env-file .env \
  -v "$PWD/config.json:/app/config.json:ro" \
  ajna-erc4626-keeper
```

If you mount the config somewhere else, set `CONFIG_PATH` to the in-container path:

```
docker run --rm \
  --env-file .env \
  -e CONFIG_PATH=/config/keeper.json \
  -v "$PWD/config.json:/config/keeper.json:ro" \
  ajna-erc4626-keeper
```

If you use `KEYSTORE_PATH`, mount that file too and set `KEYSTORE_PATH` to the container path. For example:

```
docker run --rm \
  --env-file .env \
  -e KEYSTORE_PATH=/secrets/keeper-key.json \
  -v "$PWD/config.json:/app/config.json:ro" \
  -v "$PWD/keystore/keeper-key.json:/secrets/keeper-key.json:ro" \
  -it \
  ajna-erc4626-keeper
```

If you use the remote signer with mTLS, mount the PEM files (and any private CA bundle) into the container and point the `REMOTE_SIGNER_TLS_*` variables at the in-container paths. Prefer mounting a directory read-only over mounting individual files. For example:

```
docker run --rm \
  --env-file .env \
  -e REMOTE_SIGNER_TLS_CLIENT_CERT=/etc/keeper/tls/client.pem \
  -e REMOTE_SIGNER_TLS_CLIENT_KEY=/etc/keeper/tls/client.key \
  -e REMOTE_SIGNER_TLS_CA=/etc/keeper/tls/ca.pem \
  -v "$PWD/config.json:/app/config.json:ro" \
  -v "$PWD/tls:/etc/keeper/tls:ro" \
  ajna-erc4626-keeper
```

Prefer `REMOTE_SIGNER_URL` plus `REMOTE_SIGNER_ADDRESS` for production deployments where possible. If you use `PRIVATE_KEY`, inject it at runtime from the deployment environment or secret manager rather than baking it into an image.

## <a name="configure-environment"></a>Configure Environment

Configuration is split between `.env` (secrets and infrastructure) and `config.json` (operational parameters).

For `.env`, define the required secrets:

```
cp .env.example .env
```

Then replace the placeholder values in `.env`. At minimum, `RPC_URL`, `SUBGRAPH_URL`, and exactly one credential mode must be set:

- `PRIVATE_KEY`
- `KEYSTORE_PATH`
- `REMOTE_SIGNER_URL` with `REMOTE_SIGNER_ADDRESS`

`CONFIG_PATH` is optional. Leave it unset when `config.json` will live in the current working directory. Set it when a container or deployment mounts the file elsewhere.

For `config.json`, start from the example:

```
cp config.example.json config.json
```

Then fill in the placeholder addresses and any environment-specific settings. At minimum, `quoteTokenAddress`, `arks`, `buffer`, and oracle configuration must be set. If the metavault address is provided, the metavault keeper will run alongside the ARK keeper. If omitted, only the ARK keeper runs.

In production, `.env` values should be provided at runtime from the deployment environment. Prefer a remote signer when available. If you use a raw private key instead, inject it from the deployer's secret manager rather than baking it into images or committed files. The default Docker image expects `config.json` to be mounted at runtime, though you can also bake it into a derivative image if your deployment process requires that.

## <a name="deployment-requirements"></a>Deployment Requirements

For every managed ARK, the keeper signer must be authorised as a keeper in the ARK's `VaultAuth`. If an ARK is managed through this repo's metavault flow, its `bufferRatio` must be set to `0`. In this operating model, withdrawal liquidity is managed at the shared Euler Earn Buffer layer rather than being intentionally retained inside each ARK.

If `metavaultAddress` is set, the Euler Earn deployment also needs to match the keeper's assumptions. The strategy at `buffer.address` must be the first strategy in the deployment's strategy array, its cap must be `type(uint136).max`, and that cap must already have been accepted on the metavault before the keeper starts. The keeper treats that strategy as the shared Buffer allocation when it computes metavault reallocations.

## <a name="operator-responsibilities"></a>Operator Responsibilities

This keeper automates rebalance decisions, but it does not own deployment operations. The operator is responsible for signer custody, process supervision, upstream service health, alert routing, contract permissions, and the config choices that define the keeper's risk posture.

At a minimum, the operator must ensure the following:

- the chosen credential mode matches the environment and the signer remains funded and reachable
- the process runs under a supervisor and is restarted after crashes or intentional halts
- RPC, subgraph, and oracle dependencies are monitored for latency, availability, and drift
- warning, error, and fatal logs are routed to paging or incident tooling
- ARK and metavault permissions are correct before the process is enabled
- deployment-specific values such as interval, oracle mode, allocation bounds, and gas settings have been reviewed for the target market

The settings below change the operational model and should be reviewed explicitly in every deployment:

| Setting | Operational meaning |
| ------- | ------------------- |
| `keeper.exitOnSubgraphFailure` | `true` fails closed when the bad-debt dependency is unavailable. `false` keeps the process running but treats subgraph outages as if there are no blocking auctions. |
| `oracle.fixedPrice` | Bypasses live oracle reads and freshness checks. Use only as an explicit emergency or controlled override. |
| `oracle.onchainPrimary`, `oracle.onchainAddress`, `oracle.apiUrl`, `oracle.onchainMaxStaleness`, `oracle.offchainMaxStaleness` | Define which oracle path the keeper trusts first, whether it can fall back, and how stale live oracle data may be before the run aborts. |
| `transaction.gasBuffer`, `transaction.defaultGas`, `transaction.confirmations` | Define gas padding, fallback gas limit, and how long the keeper waits before treating each submitted step as confirmed. |

## <a name="failure-and-recovery"></a>Failure and Recovery

A keeper run is not atomic across all writes. Each transaction is submitted independently, and later steps do not roll back earlier successful ones. The keeper waits according to `transaction.confirmations`, then continues from the result of that individual transaction.

This matters in both flows. A metavault run can complete one or more `drain` or `moveToBuffer` transactions before the final `reallocate()` call. An ARK run can complete `updateInterest`, `drain`, `move`, `moveToBuffer`, or `moveFromBuffer` before another step fails. Recovery is the next run, which re-reads live state and recomputes from current balances, prices, and queue conditions rather than attempting rollback.

The [full event list is above](#technical-overview-6-housekeeping-and-telemetry). For incident diagnosis, start with these:

| Event | Meaning |
| ----- | ------- |
| `ark_run_halted` | An ARK hit `LUPBelowHTP` and will stay halted until the process is restarted. |
| `paused_arks_detected`, `ark_run_aborted`, `metavault_run_aborted` | The run exited early because a contract state or keeper guard prevented safe progress. |
| `subgraph_fail_open_enabled`, `subgraph_query_failed` | The bad-debt dependency is in fail-open mode or currently failing. |
| `oracle_staleness_check_disabled`, `oracle_fixed_price_enabled`, `price_query_failed` | Oracle safety checks are disabled or a price source is degraded. |
| `gas_estimation_failed`, `tx_failed` | A transaction needed fallback gas logic or failed to execute. |
| `keeper_run_failed`, `uncaught_exception`, `unhandled_rejection` | The process or a full scheduled run failed at the top level. |

## <a name="run-tests"></a>Run Tests

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
