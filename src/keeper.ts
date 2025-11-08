import { env } from './utils/env';
import { log } from './utils/logger';
import { toWad } from './utils/decimalConversion';
import { handleTransaction } from './utils/transaction';
import { getPrice } from './oracle/price';
import { poolHasBadDebt } from './subgraph/poolHealth';
import { getBufferTotal } from './vault/buffer';
import { getHtp, getIndexToPrice, getLup, getPriceToIndex, getQtValue } from './ajna/poolInfoUtils';
import { getBufferRatio, getMinBucketIndex } from './vault/vaultAuth';
import {
  getAssetDecimals,
  getBuckets,
  getTotalAssets,
  isPaused,
  move,
  moveFromBuffer,
  moveToBuffer,
  drain,
  getDustThreshold,
} from './vault/vault';
import { getBankruptcyTime, getBucketLps, updateInterest } from './ajna/pool';

type KeeperRunData = {
  buckets: readonly bigint[];
  bufferTotal: bigint;
  bufferTarget: bigint;
  lup: BucketPrice;
  htp: BucketPrice;
  price: bigint;
  optimalBucket: bigint;
  minAmount: bigint;
};

type BucketPrice = {
  price: bigint;
  index: bigint;
};

type MoveOperation = {
  from: bigint | 'Buffer';
  to: bigint | 'Buffer';
  amount: bigint;
  bucketIndex?: number;
};

export async function run() {
  if (await isPaused()) return;
  if (await poolHasBadDebt()) return;

  await updateInterest();
  const data = await _getKeeperData();
  await drain(data.optimalBucket);

  if (!(await isOptimalBucketInRange(data))) return;
  if (await isOptimalBucketDusty(data)) return;
  if (await isOptimalBucketRecentlyBankrupt(data)) return;

  await rebalanceBuckets(data);
  await rebalanceBuffer(data);
  await logFinalState(data);
}

// ============= Core Rebalancing Functions =============

async function rebalanceBuckets(data: KeeperRunData): Promise<void> {
  let bufferNeeded = calculateBufferDeficit(data);

  for (let i = 0; i < data.buckets.length; i++) {
    const bucket = data.buckets[i]!;
    await drain(bucket);

    if (await shouldSkipBucket(bucket, data)) continue;

    const bucketValue = await getQtValue(bucket);
    const operations = planBucketOperations(bucket, bucketValue, bufferNeeded, data, i);

    for (const op of operations) {
      await executeMoveOperation(op);
    }

    bufferNeeded = operations.reduce(
      (needed, op) => (op.to === 'Buffer' ? needed - op.amount : needed),
      bufferNeeded,
    );
  }
}

async function rebalanceBuffer(data: KeeperRunData): Promise<void> {
  const newBufferTotal = await getBufferTotal();
  const difference = newBufferTotal - data.bufferTarget;

  if (Math.abs(Number(difference)) < data.minAmount) return;

  if (difference > 0n) {
    await moveExcessFromBuffer(difference, data.optimalBucket);
  } else {
    await fillBufferDeficit(-difference, data);
  }

  await verifyBufferTarget(data.bufferTarget);
}

// ============= Operation Planning =============

function planBucketOperations(
  bucket: bigint,
  bucketValue: bigint,
  bufferNeeded: bigint,
  data: KeeperRunData,
  bucketIndex: number,
): MoveOperation[] {
  const operations: MoveOperation[] = [];

  if (bufferNeeded < data.minAmount) {
    operations.push({
      from: bucket,
      to: data.optimalBucket,
      amount: bucketValue,
      bucketIndex,
    });
  } else if (bufferNeeded >= bucketValue) {
    operations.push({
      from: bucket,
      to: 'Buffer',
      amount: bucketValue,
      bucketIndex,
    });
  } else {
    operations.push({
      from: bucket,
      to: 'Buffer',
      amount: bufferNeeded,
      bucketIndex,
    });
    operations.push({
      from: bucket,
      to: data.optimalBucket,
      amount: bucketValue - bufferNeeded,
      bucketIndex,
    });
  }

  return operations;
}

// ============= Move Execution =============

async function executeMoveOperation(op: MoveOperation): Promise<void> {
  if (op.from === 'Buffer') {
    await handleTransaction(moveFromBuffer(op.to as bigint, op.amount), {
      action: 'moveFromBuffer',
      to: op.to,
      amount: op.amount,
    });
  } else if (op.to === 'Buffer') {
    await handleTransaction(moveToBuffer(op.from, op.amount), {
      action: 'moveToBuffer',
      from: op.from,
      amount: op.amount,
    });
  } else {
    await handleTransaction(move(op.from, op.to, op.amount), {
      action: 'move',
      from: op.from,
      to: op.to,
      amount: op.amount,
    });
  }
}

async function moveExcessFromBuffer(amount: bigint, targetBucket: bigint): Promise<void> {
  await drain(targetBucket);
  await handleTransaction(moveFromBuffer(targetBucket, amount), {
    action: 'moveFromBuffer',
    to: targetBucket,
    amount: amount,
  });
}

async function fillBufferDeficit(needed: bigint, data: KeeperRunData): Promise<void> {
  let remaining = needed;

  for (let i = 0; i < data.buckets.length && remaining > data.minAmount; i++) {
    const bucket = data.buckets[i]!;
    await drain(bucket);
    const bucketValue = await getQtValue(bucket);

    if (bucketValue < data.minAmount) continue;

    const amountToMove = bucketValue >= remaining ? remaining : bucketValue;

    await handleTransaction(moveToBuffer(bucket, amountToMove), {
      action: 'moveToBuffer',
      from: bucket,
      amount: amountToMove,
    });

    remaining -= amountToMove;
  }
}

// ============= Validation Functions =============

async function shouldSkipBucket(bucket: bigint, data: KeeperRunData): Promise<boolean> {
  if (bucket === data.optimalBucket) return true;

  const bucketValue = await getQtValue(bucket);
  if (bucketValue < env.MIN_MOVE_AMOUNT) return true;

  const bucketPrice = await getIndexToPrice(bucket);
  return await isBucketInRange(bucketPrice, data);
}

export async function isBucketInRange(bucketPrice: bigint, data: KeeperRunData): Promise<boolean> {
  const minBucketIndex = await getMinBucketIndex();
  let minBucketPrice: bigint;
  if (minBucketIndex !== 0n) {
    minBucketPrice = await getIndexToPrice(minBucketIndex);
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
  const optimalBucketPrice = await getIndexToPrice(data.optimalBucket);
  return await isBucketInRange(optimalBucketPrice, data);
}

async function isOptimalBucketDusty(data: KeeperRunData): Promise<boolean> {
  const bucketLps = await getBucketLps(data.optimalBucket);
  const dustThreshold = await getDustThreshold();
  return bucketLps !== 0n && bucketLps < dustThreshold;
}

async function isOptimalBucketRecentlyBankrupt(data: KeeperRunData): Promise<boolean> {
  const bankruptcyTimestamp = await getBankruptcyTime(data.optimalBucket);

  if (env.MIN_TIME_SINCE_BANKRUPTCY === 0n) return bankruptcyTimestamp > 0n;

  return (
    bankruptcyTimestamp > 0n &&
    BigInt(Math.floor(Date.now() / 1000)) - bankruptcyTimestamp < env.MIN_TIME_SINCE_BANKRUPTCY
  );
}

function calculateBufferDeficit(data: KeeperRunData): bigint {
  return data.bufferTarget > data.bufferTotal ? data.bufferTarget - data.bufferTotal : 0n;
}

async function verifyBufferTarget(target: bigint): Promise<void> {
  const actual = await getBufferTotal();
  if (actual !== target) {
    log.warn(
      { event: 'buffer_imbalance' },
      `Buffer total (${actual}) does not equal Buffer target (${target})`,
    );
  }
}

// ============= Data Fetching =============

export async function _getKeeperData(): Promise<KeeperRunData> {
  const [buckets, bufferTotal, lup, htp, price, bufferTarget] = await Promise.all([
    getBuckets(),
    getBufferTotal(),
    getLup(),
    getHtp(),
    getPrice(),
    _calculateBufferTarget(),
  ]);

  const [lupIndex, htpIndex, optimalBucket] = await Promise.all([
    getPriceToIndex(lup),
    getPriceToIndex(htp),
    _calculateOptimalBucket(price),
  ]);

  return {
    buckets,
    bufferTotal,
    bufferTarget: bufferTarget,
    lup: { price: lup, index: lupIndex },
    htp: { price: htp, index: htpIndex },
    price: BigInt(price),
    optimalBucket,
    minAmount: env.MIN_MOVE_AMOUNT,
  };
}

export async function _calculateOptimalBucket(price: bigint): Promise<bigint> {
  const currentPriceIndex = await getPriceToIndex(price);
  return currentPriceIndex + env.OPTIMAL_BUCKET_DIFF;
}

export async function _calculateBufferTarget(): Promise<bigint> {
  const [bufferRatio, totalAssets, assetDecimals] = await Promise.all([
    getBufferRatio(),
    getTotalAssets(),
    getAssetDecimals(),
  ]);

  return (toWad(totalAssets, assetDecimals) * bufferRatio) / 10000n;
}

// ============= Logging =============

async function logFinalState(data: KeeperRunData): Promise<void> {
  const finalBufferTotal = await getBufferTotal();

  log.info(
    { event: 'keeper_run_succeeded' },
    `Keeper run complete.
    Buffer total: ${finalBufferTotal}
    Buffer target: ${data.bufferTarget}
    Quote token price: ${data.price}
    Optimal bucket: ${data.optimalBucket}`,
  );
}
