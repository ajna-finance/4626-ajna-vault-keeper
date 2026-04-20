import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import type { Address } from 'viem';
import { toAsset } from './decimalConversion.ts';

// ============= Raw JSON Types =============

type ArkRecoveryConfig = {
  enabled?: boolean;
  refillBucketOverride?: string;
  maxSlippageBps?: number;
  maxValueLossBps?: number;
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
  };

  arks: ArkConfig[];
  buffer: {
    address: Address;
    allocation: number;
  };
  minRateDiff: number;
};

// ============= Parse & Validate =============

export const DEFAULT_ONCHAIN_MAX_STALENESS = 86400;
export const DEFAULT_REMOTE_SIGNER_REQUEST_TIMEOUT_MS = 30000;

const CONFIG_PATH = process.env.CONFIG_PATH
  ? resolve(process.env.CONFIG_PATH)
  : join(process.cwd(), 'config.json');

let raw: RawConfig;

try {
  raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
} catch (error) {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    throw new Error(
      `Configuration file not found at ${CONFIG_PATH}. Set CONFIG_PATH or place config.json in the working directory.`,
    );
  }

  throw error;
}

for (const [i, ark] of raw.arks.entries()) {
  if (ark.allocation.max === 0)
    throw new Error(`config.json: arks[${i}].allocation.max must not be 0`);
  if (ark.allocation.min > ark.allocation.max)
    throw new Error(
      `config.json: arks[${i}].allocation.min (${ark.allocation.min}) must not exceed max (${ark.allocation.max})`,
    );
}

if (raw.arks.length > 0 && raw.buffer.allocation > 0) {
  const maxSum = raw.arks.reduce((sum, ark) => sum + ark.allocation.max, 0);
  if (maxSum + raw.buffer.allocation !== 100) {
    throw new Error(
      `config.json: sum of ark max allocations (${maxSum}) + buffer allocation (${raw.buffer.allocation}) must equal 100`,
    );
  }
}

if (raw.oracle.fixedPrice != null) {
  if (typeof raw.oracle.fixedPrice !== 'string') {
    throw new Error(
      'config.json: oracle.fixedPrice must be a string decimal to avoid precision loss',
    );
  }
  if (toAsset(raw.oracle.fixedPrice, 18) <= 0n) {
    throw new Error('config.json: oracle.fixedPrice must be a positive decimal value');
  }
}

if (!raw.oracle.onchainPrimary && raw.oracle.fixedPrice == null) {
  if (!raw.oracle.apiUrl)
    throw new Error(
      'config.json: oracle.apiUrl is required when onchainPrimary is false and fixedPrice is not set',
    );
}

const hasOnchainOracle = Boolean(raw.oracle.onchainAddress);

if (raw.oracle.onchainPrimary && !hasOnchainOracle) {
  throw new Error('config.json: oracle.onchainAddress is required when onchainPrimary is true');
}

if (raw.oracle.onchainMaxStaleness === undefined) {
  raw.oracle.onchainMaxStaleness = hasOnchainOracle ? DEFAULT_ONCHAIN_MAX_STALENESS : null;
}

if (
  raw.oracle.onchainMaxStaleness != null &&
  (!Number.isInteger(raw.oracle.onchainMaxStaleness) || raw.oracle.onchainMaxStaleness <= 0)
) {
  throw new Error('config.json: oracle.onchainMaxStaleness must be a positive integer or null');
}

if (raw.remoteSigner !== undefined) {
  if (typeof raw.remoteSigner !== 'object' || raw.remoteSigner === null) {
    throw new Error('config.json: remoteSigner must be an object when provided');
  }
  if (raw.remoteSigner.requestTimeoutMs !== undefined) {
    const value = raw.remoteSigner.requestTimeoutMs;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error('config.json: remoteSigner.requestTimeoutMs must be a positive integer');
    }
    if (value > raw.keeper.intervalMs) {
      throw new Error(
        `config.json: remoteSigner.requestTimeoutMs (${value}) must not exceed keeper.intervalMs (${raw.keeper.intervalMs})`,
      );
    }
  }
}

raw.remoteSigner ??= {};
raw.remoteSigner.requestTimeoutMs ??= DEFAULT_REMOTE_SIGNER_REQUEST_TIMEOUT_MS;

raw.keeper.exitOnSubgraphFailure ??= true;
raw.oracle.futureSkewTolerance ??= 120;
raw.arkGlobal.bufferPadding ??= '100000000000000';
raw.arkGlobal.minMoveAmount ??= '1000001';
raw.arkGlobal.minTimeSinceBankruptcy ??= 259200;
raw.arkGlobal.maxAuctionAge ??= 259200;
raw.transaction.gasBuffer =
  !raw.transaction.gasBuffer || BigInt(raw.transaction.gasBuffer) === 0n
    ? 50
    : raw.transaction.gasBuffer;
raw.transaction.defaultGas ??= 5000000;

if (!raw.arkGlobal.optimalBucketDiff) {
  const missing = raw.arks
    .map((ark, i) => (ark.optimalBucketDiff == null ? i : null))
    .filter((i) => i !== null);
  if (missing.length > 0) {
    throw new Error(
      `config.json: optimalBucketDiff must be set globally in arkGlobal or individually for every ark (missing on arks: ${missing.join(', ')})`,
    );
  }
}

if (!raw.minRateDiff) raw.minRateDiff = 10;
if (!raw.quoteTokenAddress) throw new Error('config.json: quoteTokenAddress is required');

raw.recovery ??= {};
raw.recovery.dedupWindowMs ??= 3_600_000;
raw.recovery.maxSlippageBps ??= 50;
raw.recovery.maxValueLossBps ??= 100;
raw.recovery.minLpMintedBps ??= 9900;

const isBps = (n: number) => Number.isInteger(n) && n >= 0 && n <= 10000;
if (!isBps(raw.recovery.maxSlippageBps))
  throw new Error(`config.json: recovery.maxSlippageBps must be an integer 0-10000`);
if (!isBps(raw.recovery.maxValueLossBps))
  throw new Error(`config.json: recovery.maxValueLossBps must be an integer 0-10000`);
if (!isBps(raw.recovery.minLpMintedBps))
  throw new Error(`config.json: recovery.minLpMintedBps must be an integer 0-10000`);

for (const [i, ark] of raw.arks.entries()) {
  const r = ark.recovery;
  if (r == null) continue;
  if (r.maxSlippageBps != null && !isBps(r.maxSlippageBps))
    throw new Error(`config.json: arks[${i}].recovery.maxSlippageBps must be an integer 0-10000`);
  if (r.maxValueLossBps != null && !isBps(r.maxValueLossBps))
    throw new Error(`config.json: arks[${i}].recovery.maxValueLossBps must be an integer 0-10000`);
}

// ============= Export =============

export type ResolvedArkSettings = {
  optimalBucketDiff: bigint;
  bufferPadding: bigint;
  minMoveAmount: bigint;
  minTimeSinceBankruptcy: bigint;
  maxAuctionAge: number;
};

export type ResolvedRecoverySettings = {
  enabled: boolean;
  refillBucketOverride?: bigint;
  maxSlippageBps: number;
  maxValueLossBps: number;
  minLpMintedBps: number;
  minTimeSinceBankruptcy: bigint;
  dedupWindowMs: number;
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
    dedupWindowMs: g.dedupWindowMs!,
  };
  if (r.refillBucketOverride != null) {
    resolved.refillBucketOverride = BigInt(r.refillBucketOverride);
  }
  return resolved;
}

export const config = {
  ...raw,
  keeper: raw.keeper as Required<RawConfig['keeper']>,
  oracle: raw.oracle as Required<RawConfig['oracle']>,
  arkGlobal: raw.arkGlobal as Required<RawConfig['arkGlobal']>,
  transaction: raw.transaction as Required<RawConfig['transaction']>,
  recovery: raw.recovery as Required<NonNullable<RawConfig['recovery']>>,
  remoteSigner: raw.remoteSigner as Required<NonNullable<RawConfig['remoteSigner']>>,
  quoteTokenAddress: raw.quoteTokenAddress.toLowerCase() as Address,
  metavaultAddress: (raw.metavaultAddress || undefined) as Address | undefined,
  defaultGas: BigInt(raw.transaction.defaultGas!),
  gasBuffer: BigInt(raw.transaction.gasBuffer!),
};
