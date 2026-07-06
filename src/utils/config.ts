import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { isAddress, type Address } from 'viem';
import { toAsset } from './decimalConversion.ts';
import { AJNA_MAX_FENWICK_INDEX } from '../ajna/constants.ts';

// ============= Raw JSON Types =============

type ArkRecoveryConfig = {
  enabled?: boolean;
  refillBucketOverride?: string;
  maxSlippageBps?: number;
  maxValueLossBps?: number;
  minRecoveryValueWad?: string;
};

type ArkConfig = {
  address: Address;
  vaultAddress: Address;
  vaultAuthAddress: Address;
  allocation: {
    min: number;
    max: number;
  };
  optimalBucketDiff?: number;
  bufferPadding?: string;
  minMoveAmount?: string;
  minTimeSinceBankruptcy?: number;
  maxAuctionAge?: number;
  recovery?: ArkRecoveryConfig;
};

type RawConfig = {
  chainId: number;
  quoteTokenAddress: string;
  metavaultAddress?: string;

  keeper: {
    intervalMs: number;
    logLevel?: string;
    exitOnSubgraphFailure?: boolean;
    haltIfLupBelowHtp: boolean;
  };

  oracle: {
    apiUrl?: string;
    onchainPrimary: boolean;
    onchainAddress?: string;
    onchainMaxStaleness?: number | null;
    offchainMaxStaleness?: number;
    fixedPrice: string | null;
    futureSkewTolerance?: number;
  };

  arkGlobal: {
    optimalBucketDiff?: number;
    bufferPadding?: string;
    minMoveAmount?: string;
    minTimeSinceBankruptcy?: number;
    maxAuctionAge?: number;
  };

  transaction: {
    gasBuffer?: number;
    defaultGas?: number;
    confirmations: number;
  };

  remoteSigner?: {
    requestTimeoutMs?: number;
  };

  recovery?: {
    dedupWindowMs?: number;
    maxSlippageBps?: number;
    maxValueLossBps?: number;
    minLpMintedBps?: number;
    swapDeadlineSec?: number;
    minRecoveryValueWad?: string;
  };

  arks: ArkConfig[];
  buffer: {
    address: Address;
    allocation: number;
  };
  minRateDiff: number;
};

// ============= Defaults =============

export const DEFAULT_ONCHAIN_MAX_STALENESS = 86400;
export const DEFAULT_OFFCHAIN_MAX_STALENESS = 86400;
export const DEFAULT_REMOTE_SIGNER_REQUEST_TIMEOUT_MS = 30000;
export const DEFAULT_FUTURE_SKEW_TOLERANCE = 120;
const DEFAULT_BUFFER_PADDING = '100000000000000';
const DEFAULT_MIN_MOVE_AMOUNT = '1000001';
const DEFAULT_MIN_TIME_SINCE_BANKRUPTCY = 259200;
const DEFAULT_MAX_AUCTION_AGE = 259200;
const DEFAULT_GAS_BUFFER = 50;
const DEFAULT_GAS = 5000000;
const DEFAULT_MIN_RATE_DIFF = 10;
const DEFAULT_RECOVERY_DEDUP_WINDOW_MS = 3_600_000;
const DEFAULT_RECOVERY_MAX_SLIPPAGE_BPS = 50;
const DEFAULT_RECOVERY_MAX_VALUE_LOSS_BPS = 100;
const DEFAULT_RECOVERY_MIN_LP_MINTED_BPS = 9900;
const DEFAULT_RECOVERY_SWAP_DEADLINE_SEC = 300;
// Quote-WAD value below which vault-held collateral is ignored by detection: 1e15 WAD
// = 0.001 quote token, the same "$0.001 blast radius" as QUOTE_DUST_DIVISOR in the
// recovery keeper. Collateral must be worth more than this before arkKeeper halts or
// recovery triggers — otherwise a permissionless 1-wei addCollateral griefs both.
const DEFAULT_RECOVERY_MIN_VALUE_WAD = '1000000000000000';

const PINO_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

// ============= Load File =============

const CONFIG_PATH = process.env.CONFIG_PATH
  ? resolve(process.env.CONFIG_PATH)
  : join(process.cwd(), 'config.json');

const raw = loadRawConfig(CONFIG_PATH);

// ============= Validation Pipeline =============

requireObject(raw, 'root');

requireSafeInteger(raw.chainId, 'chainId', { min: 1 });
const quoteTokenAddress = requireAddress(raw.quoteTokenAddress, 'quoteTokenAddress');

const metavaultAddress = normalizeOptionalAddress(raw.metavaultAddress, 'metavaultAddress');
raw.metavaultAddress = metavaultAddress;

validateKeeper(raw);
validateOracle(raw);
validateArkGlobal(raw);
validateTransaction(raw);
validateRemoteSigner(raw);
validateBuffer(raw);
validateArks(raw);
validateRecovery(raw);
validateAllocationSum(raw);
validateNoDuplicateAddresses(raw);

if (raw.minRateDiff !== undefined) {
  requireSafeInteger(raw.minRateDiff, 'minRateDiff', { min: 0 });
}
raw.minRateDiff ??= DEFAULT_MIN_RATE_DIFF;

// ============= Public API =============

export type ResolvedArkSettings = {
  optimalBucketDiff: bigint;
  bufferPadding: bigint;
  minMoveAmount: bigint;
  minTimeSinceBankruptcy: bigint;
  maxAuctionAge: number;
  // Optional so test fixtures predating the recovery floor stay valid; the resolver
  // always populates it, and detection treats absence as "no floor".
  minRecoveryValueWad?: bigint;
};

export type ResolvedRecoverySettings = {
  enabled: boolean;
  refillBucketOverride?: bigint;
  maxSlippageBps: number;
  maxValueLossBps: number;
  minLpMintedBps: number;
  minTimeSinceBankruptcy: bigint;
  minRecoveryValueWad: bigint;
  dedupWindowMs: number;
  swapDeadlineSec: number;
};

export function resolveArkSettings(ark: ArkConfig): ResolvedArkSettings {
  return {
    optimalBucketDiff: BigInt(ark.optimalBucketDiff ?? raw.arkGlobal.optimalBucketDiff!),
    bufferPadding: BigInt(ark.bufferPadding ?? raw.arkGlobal.bufferPadding!),
    minMoveAmount: BigInt(ark.minMoveAmount ?? raw.arkGlobal.minMoveAmount!),
    minTimeSinceBankruptcy: BigInt(
      ark.minTimeSinceBankruptcy ?? raw.arkGlobal.minTimeSinceBankruptcy!,
    ),
    maxAuctionAge: ark.maxAuctionAge ?? raw.arkGlobal.maxAuctionAge!,
    minRecoveryValueWad: BigInt(
      ark.recovery?.minRecoveryValueWad ?? raw.recovery!.minRecoveryValueWad!,
    ),
  };
}

export function resolveRecoverySettings(ark: ArkConfig): ResolvedRecoverySettings {
  const g = raw.recovery!;
  const r = ark.recovery ?? {};
  const resolved: ResolvedRecoverySettings = {
    enabled: r.enabled ?? true,
    maxSlippageBps: r.maxSlippageBps ?? g.maxSlippageBps!,
    maxValueLossBps: r.maxValueLossBps ?? g.maxValueLossBps!,
    minLpMintedBps: g.minLpMintedBps!,
    minTimeSinceBankruptcy: BigInt(
      ark.minTimeSinceBankruptcy ?? raw.arkGlobal.minTimeSinceBankruptcy!,
    ),
    minRecoveryValueWad: BigInt(r.minRecoveryValueWad ?? g.minRecoveryValueWad!),
    dedupWindowMs: g.dedupWindowMs!,
    swapDeadlineSec: g.swapDeadlineSec!,
  };
  if (r.refillBucketOverride != null) {
    resolved.refillBucketOverride = BigInt(r.refillBucketOverride);
  }
  return resolved;
}

type ResolvedOracleConfig = Omit<
  RawConfig['oracle'],
  'onchainMaxStaleness' | 'offchainMaxStaleness' | 'futureSkewTolerance'
> & {
  onchainMaxStaleness: number | null;
  offchainMaxStaleness: number;
  futureSkewTolerance: number;
};

export const config = {
  ...raw,
  keeper: raw.keeper as Required<RawConfig['keeper']>,
  oracle: raw.oracle as ResolvedOracleConfig,
  arkGlobal: raw.arkGlobal as Required<RawConfig['arkGlobal']>,
  transaction: raw.transaction as Required<RawConfig['transaction']>,
  recovery: raw.recovery as Required<NonNullable<RawConfig['recovery']>>,
  remoteSigner: raw.remoteSigner as Required<NonNullable<RawConfig['remoteSigner']>>,
  quoteTokenAddress: quoteTokenAddress.toLowerCase() as Address,
  metavaultAddress: (metavaultAddress || undefined) as Address | undefined,
  defaultGas: BigInt(raw.transaction.defaultGas!),
  gasBuffer: BigInt(raw.transaction.gasBuffer!),
};

// ============= Section Validators =============

function validateKeeper(c: RawConfig): void {
  requireObject(c.keeper, 'keeper');
  requireSafeInteger(c.keeper.intervalMs, 'keeper.intervalMs', { min: 1 });
  requireBoolean(c.keeper.haltIfLupBelowHtp, 'keeper.haltIfLupBelowHtp');

  if (c.keeper.logLevel !== undefined) {
    requireString(c.keeper.logLevel, 'keeper.logLevel');
    if (!(PINO_LOG_LEVELS as readonly string[]).includes(c.keeper.logLevel)) {
      throwConfigError(
        `keeper.logLevel must be one of ${PINO_LOG_LEVELS.join(', ')} (got '${c.keeper.logLevel}')`,
      );
    }
  }

  if (c.keeper.exitOnSubgraphFailure !== undefined) {
    requireBoolean(c.keeper.exitOnSubgraphFailure, 'keeper.exitOnSubgraphFailure');
  }
  c.keeper.exitOnSubgraphFailure ??= true;
}

function validateOracle(c: RawConfig): void {
  requireObject(c.oracle, 'oracle');
  requireBoolean(c.oracle.onchainPrimary, 'oracle.onchainPrimary');

  if (c.oracle.apiUrl !== undefined) requireString(c.oracle.apiUrl, 'oracle.apiUrl');

  if (c.oracle.onchainAddress !== undefined) {
    requireAddress(c.oracle.onchainAddress, 'oracle.onchainAddress');
  }

  if (c.oracle.fixedPrice !== null && c.oracle.fixedPrice !== undefined) {
    if (typeof c.oracle.fixedPrice !== 'string') {
      throwConfigError('oracle.fixedPrice must be a string decimal to avoid precision loss');
    }
    if (toAsset(c.oracle.fixedPrice, 18) <= 0n) {
      throwConfigError('oracle.fixedPrice must be a positive decimal value');
    }
  } else {
    c.oracle.fixedPrice = null;
  }

  if (!c.oracle.onchainPrimary && c.oracle.fixedPrice == null && !c.oracle.apiUrl) {
    throwConfigError(
      'oracle.apiUrl is required when onchainPrimary is false and fixedPrice is not set',
    );
  }

  const hasOnchainOracle = Boolean(c.oracle.onchainAddress);
  if (c.oracle.onchainPrimary && !hasOnchainOracle) {
    throwConfigError('oracle.onchainAddress is required when onchainPrimary is true');
  }

  if (c.oracle.onchainMaxStaleness === undefined) {
    c.oracle.onchainMaxStaleness = hasOnchainOracle ? DEFAULT_ONCHAIN_MAX_STALENESS : null;
  } else if (c.oracle.onchainMaxStaleness !== null) {
    requireSafeInteger(
      c.oracle.onchainMaxStaleness,
      'oracle.onchainMaxStaleness',
      { min: 1 },
      {
        detail: 'must be a positive integer or null',
      },
    );
  }

  if (c.oracle.offchainMaxStaleness !== undefined) {
    requireSafeInteger(
      c.oracle.offchainMaxStaleness,
      'oracle.offchainMaxStaleness',
      { min: 1 },
      {
        detail: 'must be a positive integer',
      },
    );
  }
  c.oracle.offchainMaxStaleness ??= DEFAULT_OFFCHAIN_MAX_STALENESS;

  if (c.oracle.futureSkewTolerance !== undefined) {
    requireSafeInteger(c.oracle.futureSkewTolerance, 'oracle.futureSkewTolerance', { min: 0 });
  }
  c.oracle.futureSkewTolerance ??= DEFAULT_FUTURE_SKEW_TOLERANCE;
}

function validateArkGlobal(c: RawConfig): void {
  requireObject(c.arkGlobal, 'arkGlobal');

  if (c.arkGlobal.optimalBucketDiff !== undefined) {
    requireSafeInteger(c.arkGlobal.optimalBucketDiff, 'arkGlobal.optimalBucketDiff', { min: 0 });
  }
  if (c.arkGlobal.minTimeSinceBankruptcy !== undefined) {
    requireSafeInteger(c.arkGlobal.minTimeSinceBankruptcy, 'arkGlobal.minTimeSinceBankruptcy', {
      min: 0,
    });
  }
  if (c.arkGlobal.maxAuctionAge !== undefined) {
    requireSafeInteger(c.arkGlobal.maxAuctionAge, 'arkGlobal.maxAuctionAge', { min: 0 });
  }
  if (c.arkGlobal.bufferPadding !== undefined) {
    requireNonNegativeBigIntString(c.arkGlobal.bufferPadding, 'arkGlobal.bufferPadding');
  }
  if (c.arkGlobal.minMoveAmount !== undefined) {
    requireNonNegativeBigIntString(c.arkGlobal.minMoveAmount, 'arkGlobal.minMoveAmount');
  }

  c.arkGlobal.bufferPadding ??= DEFAULT_BUFFER_PADDING;
  c.arkGlobal.minMoveAmount ??= DEFAULT_MIN_MOVE_AMOUNT;
  c.arkGlobal.minTimeSinceBankruptcy ??= DEFAULT_MIN_TIME_SINCE_BANKRUPTCY;
  c.arkGlobal.maxAuctionAge ??= DEFAULT_MAX_AUCTION_AGE;
}

function validateTransaction(c: RawConfig): void {
  requireObject(c.transaction, 'transaction');
  requireSafeInteger(c.transaction.confirmations, 'transaction.confirmations', { min: 0 });

  if (c.transaction.gasBuffer !== undefined) {
    requireSafeInteger(c.transaction.gasBuffer, 'transaction.gasBuffer', { min: 0 });
  }
  if (c.transaction.defaultGas !== undefined) {
    requireSafeInteger(c.transaction.defaultGas, 'transaction.defaultGas', { min: 1 });
  }

  c.transaction.gasBuffer ??= DEFAULT_GAS_BUFFER;
  c.transaction.defaultGas ??= DEFAULT_GAS;
}

function validateRemoteSigner(c: RawConfig): void {
  if (c.remoteSigner !== undefined) {
    requireObject(c.remoteSigner, 'remoteSigner');

    if (c.remoteSigner.requestTimeoutMs !== undefined) {
      requireSafeInteger(
        c.remoteSigner.requestTimeoutMs,
        'remoteSigner.requestTimeoutMs',
        { min: 1 },
        { detail: 'must be a positive integer' },
      );
      if (c.remoteSigner.requestTimeoutMs > c.keeper.intervalMs) {
        throwConfigError(
          `remoteSigner.requestTimeoutMs (${c.remoteSigner.requestTimeoutMs}) must not exceed keeper.intervalMs (${c.keeper.intervalMs})`,
        );
      }
    }
  }
  c.remoteSigner ??= {};
  c.remoteSigner.requestTimeoutMs ??= DEFAULT_REMOTE_SIGNER_REQUEST_TIMEOUT_MS;
}

function validateBuffer(c: RawConfig): void {
  requireObject(c.buffer, 'buffer');

  const rawBufferAddress = (c.buffer as { address?: unknown }).address;
  if (c.metavaultAddress) {
    requireAddress(rawBufferAddress, 'buffer.address');
  } else if (typeof rawBufferAddress === 'string' && rawBufferAddress !== '') {
    requireAddress(rawBufferAddress, 'buffer.address');
  }

  requireAllocationPercent(c.buffer.allocation, 'buffer.allocation');
}

function validateArks(c: RawConfig): void {
  if (!Array.isArray(c.arks)) {
    throwConfigError('arks must be an array');
  }

  const metavaultMode = Boolean(c.metavaultAddress);

  for (const [i, ark] of c.arks.entries()) {
    const at = `arks[${i}]`;
    requireObject(ark, at);
    requireAddress(ark.vaultAddress, `${at}.vaultAddress`);
    requireAddress(ark.vaultAuthAddress, `${at}.vaultAuthAddress`);

    const rawAddress = (ark as { address?: unknown }).address;
    if (metavaultMode) {
      const address = requireAddress(rawAddress, `${at}.address`);
      if (address.toLowerCase() !== ark.vaultAddress.toLowerCase()) {
        throwConfigError(
          `${at}.address (${address}) must equal ${at}.vaultAddress (${ark.vaultAddress}) in metavault mode`,
        );
      }
    } else if (typeof rawAddress === 'string' && rawAddress !== '') {
      requireAddress(rawAddress, `${at}.address`);
    }

    requireObject(ark.allocation, `${at}.allocation`);
    requireAllocationPercent(ark.allocation.min, `${at}.allocation.min`);
    requireAllocationPercent(ark.allocation.max, `${at}.allocation.max`);
    if (ark.allocation.max === 0) {
      throwConfigError(`${at}.allocation.max must not be 0`);
    }
    if (ark.allocation.min > ark.allocation.max) {
      throwConfigError(
        `${at}.allocation.min (${ark.allocation.min}) must not exceed max (${ark.allocation.max})`,
      );
    }

    if (ark.optimalBucketDiff !== undefined) {
      requireSafeInteger(ark.optimalBucketDiff, `${at}.optimalBucketDiff`, { min: 0 });
    }
    if (ark.minTimeSinceBankruptcy !== undefined) {
      requireSafeInteger(ark.minTimeSinceBankruptcy, `${at}.minTimeSinceBankruptcy`, { min: 0 });
    }
    if (ark.maxAuctionAge !== undefined) {
      requireSafeInteger(ark.maxAuctionAge, `${at}.maxAuctionAge`, { min: 0 });
    }
    if (ark.bufferPadding !== undefined) {
      requireNonNegativeBigIntString(ark.bufferPadding, `${at}.bufferPadding`);
    }
    if (ark.minMoveAmount !== undefined) {
      requireNonNegativeBigIntString(ark.minMoveAmount, `${at}.minMoveAmount`);
    }
  }

  if (c.arkGlobal.optimalBucketDiff === undefined) {
    const missing = c.arks
      .map((ark, i) => (ark.optimalBucketDiff == null ? i : null))
      .filter((i) => i !== null);
    if (missing.length > 0) {
      throwConfigError(
        `optimalBucketDiff must be set globally in arkGlobal or individually for every ark (missing on arks: ${missing.join(', ')})`,
      );
    }
  }
}

function validateAllocationSum(c: RawConfig): void {
  if (!c.metavaultAddress || c.arks.length === 0) return;

  const arkSum = c.arks.reduce((sum, ark) => sum + ark.allocation.max, 0);
  const total = arkSum + c.buffer.allocation;
  if (total !== 100) {
    throwConfigError(
      `sum of ark max allocations (${arkSum}) + buffer allocation (${c.buffer.allocation}) must equal 100`,
    );
  }
}

function validateNoDuplicateAddresses(c: RawConfig): void {
  // Recovery (and rebalancing) run per-vault, so a vault listed under two arks
  // would be operated on twice. The integration test rig deliberately points
  // every ark entry at the single deployed mock vault, so it opts out.
  if (process.env.TEST_ENV !== 'true') {
    const seenVaults = new Map<string, string>();
    for (const [i, ark] of c.arks.entries()) {
      const key = ark.vaultAddress.toLowerCase();
      const prior = seenVaults.get(key);
      if (prior !== undefined) {
        throwConfigError(
          `arks[${i}].vaultAddress (${ark.vaultAddress}) duplicates ${prior} — each vault must appear at most once`,
        );
      }
      seenVaults.set(key, `arks[${i}].vaultAddress`);
    }
  }

  if (!c.metavaultAddress) return;

  const seen = new Map<string, string>();
  const remember = (raw: string, path: string): void => {
    const key = raw.toLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined) {
      throwConfigError(`${path} (${raw}) duplicates ${prior}`);
    }
    seen.set(key, path);
  };

  remember(c.metavaultAddress, 'metavaultAddress');
  remember(c.buffer.address, 'buffer.address');
  for (const [i, ark] of c.arks.entries()) {
    remember(ark.address, `arks[${i}].address`);
  }
}

function validateRecovery(c: RawConfig): void {
  if (c.recovery !== undefined) {
    requireObject(c.recovery, 'recovery');
  }
  c.recovery ??= {};

  if (c.recovery.dedupWindowMs !== undefined) {
    requireSafeInteger(c.recovery.dedupWindowMs, 'recovery.dedupWindowMs', { min: 1 });
  }
  // Slippage is DEX execution slippage (quoted price vs executed price). Should be tight;
  // 5% is already extreme for routine swaps. Cap at 10% for edge-case illiquidity.
  if (c.recovery.maxSlippageBps !== undefined) {
    requireSafeInteger(
      c.recovery.maxSlippageBps,
      'recovery.maxSlippageBps',
      { min: 0, max: 1000 },
      { detail: 'must be an integer in [0, 1000]' },
    );
  }
  // Value-loss is vault-debt vs swap output. Allow up to 50% for degraded market
  // conditions, but anything beyond that is an obvious misconfiguration.
  if (c.recovery.maxValueLossBps !== undefined) {
    requireSafeInteger(
      c.recovery.maxValueLossBps,
      'recovery.maxValueLossBps',
      { min: 0, max: 5000 },
      { detail: 'must be an integer in [0, 5000]' },
    );
  }
  // minLpMintedBps caps the health check at <10000: a bucket's round-trip quote is always
  // <= deposit (accrued interest aside), so 10000 (100%) is mathematically unachievable
  // and would halt every refill. Reject at load time to avoid the foot-gun.
  if (c.recovery.minLpMintedBps !== undefined) {
    requireSafeInteger(
      c.recovery.minLpMintedBps,
      'recovery.minLpMintedBps',
      { min: 0, max: 9999 },
      { detail: 'must be an integer in [0, 9999]' },
    );
  }
  if (c.recovery.swapDeadlineSec !== undefined) {
    requireSafeInteger(
      c.recovery.swapDeadlineSec,
      'recovery.swapDeadlineSec',
      { min: 60, max: 3600 },
      { detail: 'must be an integer in [60, 3600] seconds' },
    );
  }
  if (c.recovery.minRecoveryValueWad !== undefined) {
    requireNonNegativeBigIntString(c.recovery.minRecoveryValueWad, 'recovery.minRecoveryValueWad');
  }

  c.recovery.dedupWindowMs ??= DEFAULT_RECOVERY_DEDUP_WINDOW_MS;
  c.recovery.maxSlippageBps ??= DEFAULT_RECOVERY_MAX_SLIPPAGE_BPS;
  c.recovery.maxValueLossBps ??= DEFAULT_RECOVERY_MAX_VALUE_LOSS_BPS;
  c.recovery.minLpMintedBps ??= DEFAULT_RECOVERY_MIN_LP_MINTED_BPS;
  c.recovery.swapDeadlineSec ??= DEFAULT_RECOVERY_SWAP_DEADLINE_SEC;
  c.recovery.minRecoveryValueWad ??= DEFAULT_RECOVERY_MIN_VALUE_WAD;

  for (const [i, ark] of c.arks.entries()) {
    const r = ark.recovery;
    if (r == null) continue;
    const at = `arks[${i}].recovery`;
    requireObject(r, at);
    if (r.enabled !== undefined) {
      requireBoolean(r.enabled, `${at}.enabled`);
    }
    if (r.maxSlippageBps != null) {
      requireSafeInteger(
        r.maxSlippageBps,
        `${at}.maxSlippageBps`,
        { min: 0, max: 1000 },
        { detail: 'must be an integer in [0, 1000]' },
      );
    }
    if (r.maxValueLossBps != null) {
      requireSafeInteger(
        r.maxValueLossBps,
        `${at}.maxValueLossBps`,
        { min: 0, max: 5000 },
        { detail: 'must be an integer in [0, 5000]' },
      );
    }
    if (r.refillBucketOverride != null) {
      requireNonNegativeBigIntString(r.refillBucketOverride, `${at}.refillBucketOverride`);
      if (BigInt(r.refillBucketOverride) > AJNA_MAX_FENWICK_INDEX) {
        throwConfigError(
          `${at}.refillBucketOverride must be a valid Ajna bucket index (0-${AJNA_MAX_FENWICK_INDEX})`,
        );
      }
    }
    if (r.minRecoveryValueWad != null) {
      requireNonNegativeBigIntString(r.minRecoveryValueWad, `${at}.minRecoveryValueWad`);
    }
  }
}

// ============= Primitive Validators =============

function requireObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throwConfigError(`${path} must be an object`);
  }
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throwConfigError(`${path} must be a non-empty string`);
  }
}

function requireBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throwConfigError(`${path} must be a boolean`);
  }
}

function requireSafeInteger(
  value: unknown,
  path: string,
  bounds: { min?: number; max?: number } = {},
  options: { detail?: string } = {},
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throwConfigError(`${path} ${options.detail ?? 'must be an integer'} (got ${describe(value)})`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throwConfigError(`${path} ${options.detail ?? `must be >= ${bounds.min}`} (got ${value})`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throwConfigError(`${path} ${options.detail ?? `must be <= ${bounds.max}`} (got ${value})`);
  }
}

function requireAllocationPercent(value: unknown, path: string): asserts value is number {
  requireSafeInteger(
    value,
    path,
    { min: 0, max: 100 },
    {
      detail: 'must be an integer in [0, 100]',
    },
  );
}

function requireAddress(value: unknown, path: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) {
    throwConfigError(
      `${path} must be a valid 0x-prefixed 20-byte address (got ${describe(value)})`,
    );
  }
  return value as Address;
}

function normalizeOptionalAddress(value: unknown, path: string): string {
  if (value === undefined || value === null || value === '') return '';
  return requireAddress(value, path);
}

function requireNonNegativeBigIntString(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throwConfigError(`${path} must be a numeric string`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throwConfigError(`${path} must parse as a bigint (got ${describe(value)})`);
  }
  if (parsed < 0n) {
    throwConfigError(`${path} must be non-negative (got ${value})`);
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function throwConfigError(message: string): never {
  throw new Error(`config.json: ${message}`);
}

function loadRawConfig(path: string): RawConfig {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf-8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        `Configuration file not found at ${path}. Set CONFIG_PATH or place config.json in the working directory.`,
      );
    }
    throw error;
  }

  try {
    return JSON.parse(contents) as RawConfig;
  } catch (cause) {
    throw new Error(`config.json at ${path} is not valid JSON`, { cause });
  }
}
