import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { isAddress, type Address } from 'viem';
import { toAsset } from './decimalConversion.ts';

// ============= Raw JSON Types =============

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
  collateralTokenAddress?: string;
  onchainCollateralAddress?: string;
  fixedPrice?: string;
};

type RawConfig = {
  chainId: number;
  quoteTokenAddress: string;
  collateralTokenAddress?: string;
  metavaultAddress?: string;

  keeper: {
    intervalMs: number;
    logLevel?: string;
    haltIfLupBelowHtp: boolean;
  };

  oracle: {
    apiUrl?: string;
    onchainPrimary: boolean;
    onchainCollateralAddress?: string;
    onchainQuoteAddress?: string;
    onchainMaxStaleness?: number | null;
    offchainMaxStaleness?: number;
    fixedPrice: string | null;
    futureSkewTolerance?: number;
    requestTimeoutMs?: number;
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
export const DEFAULT_ORACLE_REQUEST_TIMEOUT_MS = 10000;
export const DEFAULT_FUTURE_SKEW_TOLERANCE = 120;
const DEFAULT_BUFFER_PADDING = '100000000000000';
const DEFAULT_MIN_MOVE_AMOUNT = '1000001';
const DEFAULT_MIN_TIME_SINCE_BANKRUPTCY = 259200;
const DEFAULT_MAX_AUCTION_AGE = 259200;
const DEFAULT_GAS_BUFFER = 50;
const DEFAULT_GAS = 5000000;
const DEFAULT_MIN_RATE_DIFF = 10;

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

const collateralTokenAddress = normalizeOptionalAddress(
  raw.collateralTokenAddress,
  'collateralTokenAddress',
);
raw.collateralTokenAddress = collateralTokenAddress;

const metavaultAddress = normalizeOptionalAddress(raw.metavaultAddress, 'metavaultAddress');
raw.metavaultAddress = metavaultAddress;

validateKeeper(raw);
validateOracle(raw);
validateArkGlobal(raw);
validateTransaction(raw);
validateRemoteSigner(raw);
validateBuffer(raw);
validateArks(raw);
validateOraclePerArk(raw);
validateAllocationSum(raw);
validateNoDuplicateAddresses(raw);

if (raw.minRateDiff !== undefined) {
  requireSafeInteger(raw.minRateDiff, 'minRateDiff', { min: 0 });
}
raw.minRateDiff ??= DEFAULT_MIN_RATE_DIFF;

// ============= Public API =============

export type ResolvedArkOracle = {
  collateralTokenAddress: Address | undefined;
  onchainCollateralAddress: Address | undefined;
  fixedPrice: string | null;
};

export type ResolvedArkSettings = {
  optimalBucketDiff: bigint;
  bufferPadding: bigint;
  minMoveAmount: bigint;
  minTimeSinceBankruptcy: bigint;
  maxAuctionAge: number;
  oracle?: ResolvedArkOracle;
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
    oracle: {
      collateralTokenAddress: (ark.collateralTokenAddress ??
        (raw.collateralTokenAddress || undefined)) as Address | undefined,
      onchainCollateralAddress: (ark.onchainCollateralAddress ??
        raw.oracle.onchainCollateralAddress) as Address | undefined,
      fixedPrice: ark.fixedPrice ?? raw.oracle.fixedPrice,
    },
  };
}

type ResolvedOracleConfig = Omit<
  RawConfig['oracle'],
  'onchainMaxStaleness' | 'offchainMaxStaleness' | 'futureSkewTolerance' | 'requestTimeoutMs'
> & {
  onchainMaxStaleness: number | null;
  offchainMaxStaleness: number;
  futureSkewTolerance: number;
  requestTimeoutMs: number;
};

export const config = {
  ...raw,
  keeper: raw.keeper as Required<RawConfig['keeper']>,
  oracle: raw.oracle as ResolvedOracleConfig,
  arkGlobal: raw.arkGlobal as Required<RawConfig['arkGlobal']>,
  transaction: raw.transaction as Required<RawConfig['transaction']>,
  remoteSigner: raw.remoteSigner as Required<NonNullable<RawConfig['remoteSigner']>>,
  quoteTokenAddress: quoteTokenAddress.toLowerCase() as Address,
  collateralTokenAddress: (collateralTokenAddress
    ? collateralTokenAddress.toLowerCase()
    : undefined) as Address | undefined,
  metavaultAddress: (metavaultAddress || undefined) as Address | undefined,
  defaultGas: BigInt(raw.transaction.defaultGas!),
  gasBuffer: BigInt(raw.transaction.gasBuffer!),
};

// ============= Section Validators =============

function validateKeeper(c: RawConfig): void {
  requireObject(c.keeper, 'keeper');
  requireSafeInteger(c.keeper.intervalMs, 'keeper.intervalMs', { min: 1, max: 2147483647 });
  requireBoolean(c.keeper.haltIfLupBelowHtp, 'keeper.haltIfLupBelowHtp');

  if (c.keeper.logLevel !== undefined) {
    requireString(c.keeper.logLevel, 'keeper.logLevel');
    if (!(PINO_LOG_LEVELS as readonly string[]).includes(c.keeper.logLevel)) {
      throwConfigError(
        `keeper.logLevel must be one of ${PINO_LOG_LEVELS.join(', ')} (got '${c.keeper.logLevel}')`,
      );
    }
  }
}

function validateOracle(c: RawConfig): void {
  requireObject(c.oracle, 'oracle');
  requireBoolean(c.oracle.onchainPrimary, 'oracle.onchainPrimary');

  if (c.oracle.apiUrl !== undefined) requireString(c.oracle.apiUrl, 'oracle.apiUrl');

  if (c.oracle.onchainCollateralAddress !== undefined) {
    requireAddress(c.oracle.onchainCollateralAddress, 'oracle.onchainCollateralAddress');
  }
  if (c.oracle.onchainQuoteAddress !== undefined) {
    requireAddress(c.oracle.onchainQuoteAddress, 'oracle.onchainQuoteAddress');
  }
  const anyArkOnchainFeed =
    Array.isArray(c.arks) &&
    c.arks.some((ark) => (ark as { onchainCollateralAddress?: unknown })?.onchainCollateralAddress);
  const anyOnchainCollateralFeed = Boolean(c.oracle.onchainCollateralAddress) || anyArkOnchainFeed;
  if (anyOnchainCollateralFeed !== Boolean(c.oracle.onchainQuoteAddress)) {
    throwConfigError(
      'oracle.onchainQuoteAddress and an onchain collateral feed (oracle.onchainCollateralAddress or arks[].onchainCollateralAddress) must be set together',
    );
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

  const hasOnchainOracle = Boolean(anyOnchainCollateralFeed && c.oracle.onchainQuoteAddress);
  if (c.oracle.onchainPrimary && !c.oracle.onchainQuoteAddress) {
    throwConfigError(
      'oracle.onchainQuoteAddress and a collateral feed for every ark are required when onchainPrimary is true',
    );
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

  if (c.oracle.requestTimeoutMs !== undefined) {
    requireSafeInteger(
      c.oracle.requestTimeoutMs,
      'oracle.requestTimeoutMs',
      { min: 1 },
      { detail: 'must be a positive integer' },
    );
    if (c.oracle.requestTimeoutMs > c.keeper.intervalMs) {
      throwConfigError(
        `oracle.requestTimeoutMs (${c.oracle.requestTimeoutMs}) must not exceed keeper.intervalMs (${c.keeper.intervalMs})`,
      );
    }
  }
  c.oracle.requestTimeoutMs ??= DEFAULT_ORACLE_REQUEST_TIMEOUT_MS;
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
    if (ark.collateralTokenAddress !== undefined) {
      requireAddress(ark.collateralTokenAddress, `${at}.collateralTokenAddress`);
    }
    if (ark.onchainCollateralAddress !== undefined) {
      requireAddress(ark.onchainCollateralAddress, `${at}.onchainCollateralAddress`);
    }
    if (ark.fixedPrice !== undefined) {
      if (typeof ark.fixedPrice !== 'string') {
        throwConfigError(`${at}.fixedPrice must be a string decimal to avoid precision loss`);
      }
      if (toAsset(ark.fixedPrice, 18) <= 0n) {
        throwConfigError(`${at}.fixedPrice must be a positive decimal value`);
      }
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

function validateOraclePerArk(c: RawConfig): void {
  for (const [i, ark] of c.arks.entries()) {
    const at = `arks[${i}]`;
    if ((ark.fixedPrice ?? c.oracle.fixedPrice) != null) continue;
    if (c.oracle.apiUrl && !(ark.collateralTokenAddress ?? c.collateralTokenAddress)) {
      throwConfigError(
        `${at}.collateralTokenAddress is required when oracle.apiUrl is set and no global collateralTokenAddress is configured`,
      );
    }
    if (
      c.oracle.onchainPrimary &&
      !(ark.onchainCollateralAddress ?? c.oracle.onchainCollateralAddress)
    ) {
      throwConfigError(
        `${at}.onchainCollateralAddress is required when oracle.onchainPrimary is true and no global oracle.onchainCollateralAddress is configured`,
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
