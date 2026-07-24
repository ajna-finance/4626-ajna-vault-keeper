import { type ResolvedArkSettings } from '../utils/config.ts';
import { config } from '../utils/config.ts';
import { log } from '../utils/logger.ts';
import { toWad, toWadTokenUnit } from '../utils/decimalConversion.ts';
import { poolBalanceCapWad } from '../ajna/utils/poolBalanceCap.ts';
import { getGasWithBuffer, handleTransaction, type TransactionData } from '../utils/transaction.ts';
import { getPrice } from '../oracle/price.ts';
import { poolHasBadDebt } from '../ajna/poolHealth.ts';
import { createVault } from '../ark/vault.ts';
import { getChainTime, ChainTimeUnavailableError } from '../utils/chainTime.ts';
import { AJNA_MAX_FENWICK_INDEX } from '../ajna/constants.ts';
import { RunAbortError } from './runAbort.ts';
import { type Address } from 'viem';

const haltedArks = new Set<Address>();
let vault: ReturnType<typeof createVault>;
let _settings: ResolvedArkSettings;
let _moveStats: { attempted: number; succeeded: number } = { attempted: 0, succeeded: 0 };

// ============= Types =============

type KeeperRunData = {
  buckets: readonly bigint[];
  bufferTotal: bigint;
  bufferTarget: bigint;
  lup: PriceData;
  htp: PriceData;
  price: bigint;
  optimalBucket: bigint;
  minAmount: bigint;
  assetUnitWad: bigint;
};

type PriceData = {
  price: bigint;
};

type MoveOperation = {
  from: bigint;
  to: bigint | 'Buffer';
  amount: bigint;
};

// ============= Main Run Function =============

export async function arkRun(
  address: Address,
  vaultAuthAddress: Address,
  settings: ResolvedArkSettings,
) {
  vault = createVault(address, vaultAuthAddress);
  _settings = settings;
  _moveStats = { attempted: 0, succeeded: 0 };

  try {
    if (isCurrentArkHalted()) return abortRun('keeper halted');
    if (await vault.isPaused()) return abortRun('vault is currently paused');
    if (await poolHasBadDebt(vault, _settings.maxAuctionAge)) return abortRun('pool has bad debt');

    const gas = await getGasWithBuffer('pool', 'updateInterest', [], await vault.getPoolAddress());
    const vaultAddress = vault.getAddress();
    const updateInterestTx = await handleTransaction(vault.updateInterest(gas), {
      action: 'updateInterest',
      ark: vaultAddress,
    });
    if (!updateInterestTx.status) abortRun(`updateInterest failed for ark ${vaultAddress}`);

    const data = await _getKeeperData();
    const drainTx = await handleTransaction(vault.drain(data.optimalBucket), {
      action: 'drain',
      bucket: data.optimalBucket,
      ark: vaultAddress,
    });
    if (!drainTx.status) return abortRun(`drain failed for ark ${vaultAddress}`);

    if (!(await isOptimalBucketInRange(data)))
      return abortRun('optimal bucket is not in interest-earning range');
    if (await isOptimalBucketDusty(data)) return abortRun('optimal bucket is dusty');

    const nowSec = await getChainTime();
    if (await isOptimalBucketRecentlyBankrupt(data, nowSec))
      return abortRun('optimal bucket was recently bankrupt');
    if (await vault.isBucketDebtLocked(data.optimalBucket))
      return abortRun('optimal bucket debt is locked due to pending auction');
    if (await optimalBucketHasCollateral(data)) return abortRun('optimal bucket has collateral');

    await rebalanceBuckets(data);
    await rebalanceBuffer(data);
    await logFinalState(data);
  } catch (e) {
    const ark = vault.getAddress();
    if (e instanceof ChainTimeUnavailableError) {
      log.error(
        { event: 'ark_run_aborted', ark, reason: 'chain time unavailable', err: e },
        `ark run aborted for ark ${ark}: chain time unavailable`,
      );
      return;
    }
    if (!(e instanceof RunAbortError)) throw e;
  }
}

// ============= Core Rebalancing Functions =============

async function rebalanceBuckets(data: KeeperRunData): Promise<void> {
  let bufferNeeded = await _calculateBufferDeficit(data);

  for (let i = 0; i < data.buckets.length; i++) {
    if (isCurrentArkHalted()) return;

    const bucket = data.buckets[i]!;
    const vaultAddress = vault.getAddress();
    const drainTx = await handleTransaction(vault.drain(bucket), {
      action: 'drain',
      bucket,
      ark: vaultAddress,
    });
    if (!drainTx.status) abortRun(`drain failed for ark ${vaultAddress}`);

    const bucketValue = await vault.lpToValue(bucket);
    if (await shouldSkipBucket(bucket, bucketValue, data)) continue;

    const movableToBuffer = await poolBalanceCapWad(bucketValue, vault);
    const operations = planBucketOperations(
      bucket,
      bucketValue,
      movableToBuffer,
      bufferNeeded,
      data,
    );

    for (const op of operations) {
      const txData = await executeMoveOperation(op, data);

      if (op.to === 'Buffer' && txData?.status) {
        bufferNeeded = await _calculateBufferDeficit(data);
      }
    }
  }
}

async function rebalanceBuffer(data: KeeperRunData): Promise<void> {
  if (isCurrentArkHalted()) return;

  await _refreshBufferValues(data);

  const difference = data.bufferTotal - data.bufferTarget;

  if (difference > 0n) {
    const surplus = await _calculateBufferSurplus(data);
    if (surplus <= _settings.bufferPadding + data.minAmount) return;

    const amount = surplus - _settings.bufferPadding;
    await moveExcessFromBuffer(amount, data.optimalBucket, data);
  } else {
    const deficit = -difference;
    if (deficit <= _settings.bufferPadding + data.minAmount) return;

    const amount = await poolBalanceCapWad(-difference - _settings.bufferPadding, vault);
    await fillBufferDeficit(amount, data);
  }
}

// ============= Operation Planning =============

function planBucketOperations(
  bucket: bigint,
  amountToMove: bigint,
  movableToBuffer: bigint,
  bufferNeeded: bigint,
  data: KeeperRunData,
): MoveOperation[] {
  const operations: MoveOperation[] = [];
  const bufferCapacity = movableToBuffer < amountToMove ? movableToBuffer : amountToMove;
  const bufferAmount = bufferNeeded < bufferCapacity ? bufferNeeded : bufferCapacity;

  if (bufferNeeded <= data.minAmount || bufferAmount < data.assetUnitWad) {
    operations.push({
      from: bucket,
      to: data.optimalBucket,
      amount: amountToMove,
    });
  } else if (bufferAmount === amountToMove) {
    operations.push({
      from: bucket,
      to: 'Buffer',
      amount: amountToMove,
    });
  } else {
    operations.push({
      from: bucket,
      to: 'Buffer',
      amount: bufferAmount,
    });
    operations.push({
      from: bucket,
      to: data.optimalBucket,
      amount: amountToMove - bufferAmount,
    });
  }

  return operations;
}

// ============= Move Execution =============

async function executeMoveOperation(
  op: MoveOperation,
  data: KeeperRunData,
): Promise<TransactionData | undefined> {
  if (isCurrentArkHalted()) return;
  if (op.to === 'Buffer') {
    return executeBufferTransfer('moveToBuffer', op.from, op.amount, data);
  }

  const gas = await getGasWithBuffer(
    'vault',
    'move',
    [op.from, op.to, op.amount],
    vault.getAddress(),
  );
  return _executeMoveTransaction(vault.move(op.from, op.to, op.amount, gas), {
    action: 'move',
    from: op.from,
    to: op.to,
    amount: op.amount,
    ark: vault.getAddress(),
  });
}

async function executeBufferTransfer(
  kind: 'moveToBuffer' | 'moveFromBuffer',
  bucket: bigint,
  amount: bigint,
  data: KeeperRunData,
): Promise<TransactionData | undefined> {
  if (isCurrentArkHalted()) return;
  if (amount < data.assetUnitWad) return;

  const ark = vault.getAddress();
  const gas = await getGasWithBuffer('vault', kind, [bucket, amount], ark);
  const tx =
    kind === 'moveToBuffer'
      ? vault.moveToBuffer(bucket, amount, gas)
      : vault.moveFromBuffer(bucket, amount, gas);
  const context =
    kind === 'moveToBuffer'
      ? { action: kind, from: bucket, amount, ark }
      : { action: kind, to: bucket, amount, ark };

  return _executeMoveTransaction(tx, context);
}

async function _executeMoveTransaction(
  ...args: Parameters<typeof handleTransaction>
): Promise<TransactionData> {
  const result = await handleTransaction(...args);
  _moveStats.attempted++;
  if (result.status) _moveStats.succeeded++;
  return result;
}

async function moveExcessFromBuffer(
  amount: bigint,
  targetBucket: bigint,
  data: KeeperRunData,
): Promise<void> {
  if (isCurrentArkHalted()) return;
  if (amount < data.assetUnitWad) return;
  const vaultAddress = vault.getAddress();

  const drainTx = await handleTransaction(vault.drain(targetBucket), {
    action: 'drain',
    bucket: targetBucket,
    ark: vaultAddress,
  });
  if (!drainTx.status) abortRun(`drain failed for ark ${vaultAddress}`);

  await executeBufferTransfer('moveFromBuffer', targetBucket, amount, data);
}

async function fillBufferDeficit(needed: bigint, data: KeeperRunData): Promise<void> {
  if (isCurrentArkHalted()) return;
  let remaining = needed;

  for (let i = 0; i < data.buckets.length && remaining > data.minAmount; i++) {
    if (isCurrentArkHalted()) return;
    const vaultAddress = vault.getAddress();

    const bucket = data.buckets[i]!;
    const drainTx = await handleTransaction(vault.drain(bucket), {
      action: 'drain',
      bucket,
      ark: vaultAddress,
    });
    if (!drainTx.status) abortRun(`drain failed for ark ${vaultAddress}`);

    const bucketValue = await vault.lpToValue(bucket);

    if (bucketValue < data.minAmount) continue;

    const amountToMove = await poolBalanceCapWad(
      bucketValue >= remaining ? remaining : bucketValue,
      vault,
    );

    const txData = await executeBufferTransfer('moveToBuffer', bucket, amountToMove, data);

    if (txData?.status) remaining -= txData.assets;
  }
}

// ============= Validation =============

async function shouldSkipBucket(
  bucket: bigint,
  amountToMove: bigint,
  data: KeeperRunData,
): Promise<boolean> {
  if (amountToMove <= 0n) return true;
  if (bucket === data.optimalBucket) return true;
  if (amountToMove < _settings.minMoveAmount) return true;

  const bucketPrice = await vault.getIndexToPrice(bucket);
  return await isBucketInRange(bucketPrice, data);
}

export async function isBucketInRange(bucketPrice: bigint, data: KeeperRunData): Promise<boolean> {
  const minBucketIndex = await vault.getMinBucketIndex();
  let minBucketPrice: bigint;
  if (minBucketIndex !== 0n) {
    minBucketPrice = await vault.getIndexToPrice(minBucketIndex);
  }

  const minThresholdToEarn = data.htp.price <= data.lup.price ? data.htp.price : data.lup.price;
  const maxThresholdToEarn =
    minBucketIndex === 0n
      ? data.price
      : data.price <= minBucketPrice!
        ? data.price
        : minBucketPrice!;

  return bucketPrice >= minThresholdToEarn && bucketPrice <= maxThresholdToEarn;
}

export async function isOptimalBucketInRange(data: KeeperRunData): Promise<boolean> {
  const optimalBucketPrice = await vault.getIndexToPrice(data.optimalBucket);
  return await isBucketInRange(optimalBucketPrice, data);
}

async function isOptimalBucketDusty(data: KeeperRunData): Promise<boolean> {
  const bucketLps = await vault.getBucketLps(data.optimalBucket);
  const dustThreshold = await vault.getDustThreshold();
  return bucketLps !== 0n && bucketLps < dustThreshold;
}

async function isOptimalBucketRecentlyBankrupt(
  data: KeeperRunData,
  nowSec: bigint,
): Promise<boolean> {
  const bankruptcyTimestamp = await vault.getBankruptcyTime(data.optimalBucket);

  if (_settings.minTimeSinceBankruptcy === 0n) return bankruptcyTimestamp > 0n;
  if (bankruptcyTimestamp === 0n) return false;

  return nowSec - bankruptcyTimestamp < _settings.minTimeSinceBankruptcy;
}

async function optimalBucketHasCollateral(data: KeeperRunData): Promise<boolean> {
  const bucketInfo = await vault.getBucketInfo(data.optimalBucket);
  const collateral = bucketInfo[1];

  return collateral > 0n;
}

// ============= Data Fetching =============

export async function _getKeeperData(): Promise<KeeperRunData> {
  const [initialBuckets, bufferTotal, lup, htp, price] = await Promise.all([
    vault.getBuckets(),
    vault.getBufferTotal(),
    vault.getLup(),
    vault.getHtp(),
    getPrice(_settings.oracle),
  ]);

  for (let i = 0; i < initialBuckets.length; i++) {
    const vaultAddress = vault.getAddress();
    const drainTx = await handleTransaction(vault.drain(initialBuckets[i]), {
      action: 'drain',
      bucket: initialBuckets[i],
      ark: vaultAddress,
    });

    if (!drainTx.status) return abortRun(`drain failed for ark ${vaultAddress}`);
  }

  const [optimalBucket, buckets, bufferTarget, assetDecimals] = await Promise.all([
    _calculateOptimalBucket(price),
    vault.getBuckets(),
    _calculateBufferTarget(),
    vault.getAssetDecimals(),
  ]);

  buckets.sort((a: bigint, b: bigint) => (a > b ? 1 : -1));

  return {
    buckets,
    bufferTotal,
    bufferTarget,
    lup: { price: lup },
    htp: { price: htp },
    price: BigInt(price),
    optimalBucket,
    minAmount: _settings.minMoveAmount,
    assetUnitWad: toWadTokenUnit(assetDecimals),
  };
}

export async function _calculateOptimalBucket(price: bigint): Promise<bigint> {
  const currentPriceIndex = await vault.getPriceToIndex(price);
  const optimalBucket = currentPriceIndex + _settings.optimalBucketDiff;
  if (optimalBucket === 0n || optimalBucket > AJNA_MAX_FENWICK_INDEX) {
    return abortRun('optimal bucket is outside Ajna bucket range');
  }
  return optimalBucket;
}

export async function _calculateBufferTarget(): Promise<bigint> {
  const [bufferRatio, totalAssets, assetDecimals] = await Promise.all([
    vault.getBufferRatio(),
    vault.getTotalAssets(),
    vault.getAssetDecimals(),
  ]);

  return (toWad(totalAssets, assetDecimals) * bufferRatio) / 10000n;
}

async function _calculateBufferDeficit(data: KeeperRunData): Promise<bigint> {
  await _refreshBufferValues(data);
  const deficit = data.bufferTarget - data.bufferTotal;
  if (data.bufferTotal >= data.bufferTarget) return 0n;

  return deficit > _settings.bufferPadding ? deficit - _settings.bufferPadding : 0n;
}

async function _calculateBufferSurplus(data: KeeperRunData): Promise<bigint> {
  if (data.bufferTotal <= data.bufferTarget) return 0n;

  const bufferRatio = await vault.getBufferRatio();
  if (bufferRatio !== 0n) return data.bufferTotal - data.bufferTarget;

  const reservedBuffer = await _calculateReservedExternalBuffer();
  if (data.bufferTotal <= reservedBuffer) return 0n;

  return data.bufferTotal - reservedBuffer;
}

async function _calculateReservedExternalBuffer(): Promise<bigint> {
  if (!config.metavaultAddress) return 0n;

  const [totalSupply, metavaultShares] = await Promise.all([
    vault.getTotalSupply(),
    vault.getBalanceOf(config.metavaultAddress),
  ]);
  const externalShares = totalSupply > metavaultShares ? totalSupply - metavaultShares : 0n;
  if (externalShares === 0n) return 0n;

  const [externalAssets, assetDecimals] = await Promise.all([
    vault.convertToAssets(externalShares),
    vault.getAssetDecimals(),
  ]);

  return toWad(externalAssets, assetDecimals);
}

async function _refreshBufferValues(data: KeeperRunData) {
  [data.bufferTotal, data.bufferTarget] = await Promise.all([
    vault.getBufferTotal(),
    _calculateBufferTarget(),
  ]);
}

// ============= Helpers =============

export function initArkKeeper(
  address: Address,
  vaultAuthAddress: Address,
  settings: ResolvedArkSettings,
) {
  vault = createVault(address, vaultAuthAddress);
  _settings = settings;
}

export function isArkHalted(address: Address): boolean {
  return haltedArks.has(address.toLowerCase() as Address);
}

export function haltKeeper(address?: Address) {
  const raw = address ?? vault?.getAddress?.();
  if (!raw) return;
  const ark = raw.toLowerCase() as Address;
  if (haltedArks.has(ark)) return;

  haltedArks.add(ark);
  log.warn(
    { event: 'ark_run_halted', ark },
    `ark run halting due to LUPBelowHTP error for ark ${ark}`,
  );
}

function isCurrentArkHalted(): boolean {
  return isArkHalted(vault.getAddress());
}

// ============= Logging =============

function abortRun(reason: string): never {
  log.error(
    { event: 'ark_run_aborted', ark: vault.getAddress(), reason },
    `ark run aborted for ark ${vault.getAddress()}`,
  );
  throw new RunAbortError(reason);
}

async function logFinalState(data: KeeperRunData): Promise<void> {
  const finalBufferTotal = await vault.getBufferTotal();
  const { attempted, succeeded } = _moveStats;
  const hasFailures = attempted > succeeded;
  const event = hasFailures ? 'ark_run_partially_complete' : 'ark_run_complete';
  const ark = vault.getAddress();
  const message = hasFailures
    ? `ark run partially complete for ark ${ark} (${succeeded}/${attempted} moves succeeded)`
    : `ark run complete for ark ${ark}`;

  log.info(
    {
      event,
      ark,
      bufferTotal: finalBufferTotal,
      bufferTarget: data.bufferTarget,
      quoteTokenPrice: data.price,
      optimalBucket: data.optimalBucket,
      movesAttempted: attempted,
      movesSucceeded: succeeded,
    },
    message,
  );
}
