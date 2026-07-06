import { config, resolveArkSettings } from '../utils/config.ts';
import { createVault } from '../ark/vault.ts';
import { isArkHalted } from './arkKeeper.ts';
import { RunAbortError } from './runAbort.ts';
import { evaluateRates } from '../metavault/utils/evaluateRates.ts';
import {
  getExpectedSupplyAssets,
  getSupplyCap,
  getTotalExpectedSupplyAssets,
  reallocate,
} from '../metavault/metavault.ts';
import {
  _buildFinalAllocations,
  _effectiveWithdrawal,
  _findUnpreparedArkWithdrawal,
  _isRateReallocationRequired,
  _rebalanceBuffer,
  _reallocateForRates,
  _validateAllocations,
  type Ark,
  type ArkAllocation,
  type BufferAllocation,
} from '../metavault/planner.ts';
import { poolBalanceCapAsset } from '../ajna/utils/poolBalanceCap.ts';
import { poolHasBadDebt, SubgraphUnavailableError } from '../subgraph/poolHealth.ts';
import { ChainTimeUnavailableError } from '../utils/chainTime.ts';
import { log } from '../utils/logger.ts';
import { handleTransaction, getGasWithBuffer } from '../utils/transaction.ts';
import { selectBuckets, type BucketMove } from '../ark/utils/selectBuckets.ts';
import { toWad, toWadTokenUnit } from '../utils/decimalConversion.ts';
import { type Address } from 'viem';

type RuntimeVault = ReturnType<typeof createVault>;

// ============= Main Run Function =============

export async function metavaultRun() {
  try {
    const haltedArks = _getHaltedArks();
    if (haltedArks.length > 0) {
      return log.warn(
        { event: 'halted_arks_detected', arks: haltedArks },
        'skipping run: one or more arks are halted',
      );
    }

    const pausedArks = await _getPausedArks();
    if (pausedArks.length > 0) {
      return log.warn(
        { event: 'paused_arks_detected', arks: pausedArks },
        'skipping run: one or more arks are paused',
      );
    }

    const strategyAddresses = [config.buffer.address, ...config.arks.map((ark) => ark.address)];
    const totalAssets = (await getTotalExpectedSupplyAssets(strategyAddresses)) as bigint;
    const arkAllocations = await _buildArkAllocations();
    const bufferAllocation = await _buildBufferAllocation();

    _rebalanceBuffer(
      arkAllocations,
      bufferAllocation,
      totalAssets,
      BigInt(config.arkGlobal.minMoveAmount),
    );

    const arks = _toArks(arkAllocations);
    const evaluations = evaluateRates(arks);

    if (_isRateReallocationRequired(evaluations)) {
      _reallocateForRates(arkAllocations, evaluations, totalAssets);
    }

    const validationError = _validateAllocations(arkAllocations, bufferAllocation, totalAssets);
    if (validationError) return abortRun(validationError);

    const preview = _buildFinalAllocations(arkAllocations, bufferAllocation);
    if (typeof preview === 'string') return abortRun(preview);

    if (preview.length === 0) {
      return log.info(
        { event: 'no_metavault_reallocation_needed' },
        'no metavault reallocation needed',
      );
    }

    const preparedArks = await _executeMoveToBufferCalls(arkAllocations);

    await _refreshRealInitialAssets(arkAllocations, bufferAllocation);

    const allocations = _buildFinalAllocations(arkAllocations, bufferAllocation);
    if (typeof allocations === 'string') return abortRun(allocations);

    const unpreparedArk = _findUnpreparedArkWithdrawal(allocations, arkAllocations, preparedArks);
    if (unpreparedArk) {
      return abortRun(`ark ${unpreparedArk} has a withdrawal target without a prepared buffer`);
    }

    const reallocateTx = await handleTransaction(reallocate(allocations, config.defaultGas), {
      action: 'reallocate',
    });
    if (!reallocateTx.status) return abortRun('reallocate failed');

    log.info({ event: 'metavault_run_complete', allocations }, 'metavault run complete');
  } catch (e) {
    if (e instanceof SubgraphUnavailableError) {
      log.error(
        { event: 'metavault_run_aborted', reason: 'subgraph unavailable', err: e },
        'metavault run aborted: subgraph unavailable',
      );
      return;
    }
    if (e instanceof ChainTimeUnavailableError) {
      log.error(
        { event: 'metavault_run_aborted', reason: 'chain time unavailable', err: e },
        'metavault run aborted: chain time unavailable',
      );
      return;
    }
    if (!(e instanceof RunAbortError)) throw e;
  }
}

// ============= Initialization =============

async function _buildArkAllocations(): Promise<ArkAllocation<RuntimeVault>[]> {
  const allocations: ArkAllocation<RuntimeVault>[] = [];

  for (const arkConfig of config.arks) {
    const vault = createVault(arkConfig.address);
    const settings = resolveArkSettings(arkConfig);
    const [balance, supplyCap, rate, badDebt] = await Promise.all([
      getExpectedSupplyAssets(arkConfig.address) as Promise<bigint>,
      getSupplyCap(arkConfig.address),
      vault.getBorrowFeeRate() as Promise<bigint>,
      poolHasBadDebt(vault, settings.maxAuctionAge),
    ]);
    const cappedBalance = await poolBalanceCapAsset(balance, vault);

    allocations.push({
      id: arkConfig.address,
      assets: cappedBalance,
      initialAssets: cappedBalance,
      realInitialAssets: balance,
      supplyCap,
      vault,
      min: arkConfig.allocation.min,
      max: arkConfig.allocation.max,
      rate,
      minMoveAmount: settings.minMoveAmount,
      hasBadDebt: badDebt,
    });
  }

  return allocations;
}

async function _buildBufferAllocation(): Promise<BufferAllocation> {
  const [balance, supplyCap] = (await Promise.all([
    getExpectedSupplyAssets(config.buffer.address),
    getSupplyCap(config.buffer.address),
  ])) as [bigint, bigint];

  return {
    id: config.buffer.address,
    assets: balance,
    initialAssets: balance,
    realInitialAssets: balance,
    supplyCap,
    allocation: config.buffer.allocation,
  };
}

// ============= MoveToBuffer Execution =============

async function _executeMoveToBufferCalls(
  arks: ArkAllocation<RuntimeVault>[],
): Promise<Set<Address>> {
  const plans: Array<{ ark: ArkAllocation<RuntimeVault>; plan: BucketMove[] }> = [];
  const preparedArks = new Set<Address>();

  for (const ark of arks) {
    if (ark.assets >= ark.initialAssets) continue;

    const decrease = ark.initialAssets - ark.assets;
    if (_effectiveWithdrawal(ark.realInitialAssets, decrease) === 0n) continue;

    const assetDecimals = (await ark.vault.getAssetDecimals()) as number;
    const amountToMoveWad = toWad(decrease, assetDecimals);
    const assetUnitWad = toWadTokenUnit(assetDecimals);
    const bucketPlan = (await selectBuckets(ark.vault, amountToMoveWad)).filter(
      ({ amount }) => amount >= assetUnitWad,
    );

    const plannedCoverage = bucketPlan.reduce((sum, p) => sum + p.amount, 0n);
    if (plannedCoverage < amountToMoveWad) {
      return abortRun(
        `bucket plan for ark ${ark.id} covers ${plannedCoverage} of planned decrease ${amountToMoveWad}`,
      );
    }

    plans.push({ ark, plan: bucketPlan });
  }

  for (const { ark, plan } of plans) {
    for (const { bucket, amount } of plan) {
      const drainTx = await handleTransaction(ark.vault.drain(bucket), {
        action: 'drain',
        bucket,
        ark: ark.id,
      });
      if (!drainTx.status) return abortRun(`drain failed for ark ${ark.id}`);

      const gas = await getGasWithBuffer('vault', 'moveToBuffer', [bucket, amount], ark.id);
      const moveTx = await handleTransaction(ark.vault.moveToBuffer(bucket, amount, gas), {
        action: 'moveToBuffer',
        from: bucket,
        amount,
        ark: ark.id,
      });

      if (!moveTx.status) return abortRun(`moveToBuffer failed for ark ${ark.id}`);
    }
    preparedArks.add(ark.id);
  }

  return preparedArks;
}

async function _refreshRealInitialAssets(
  arks: ArkAllocation<RuntimeVault>[],
  buffer: BufferAllocation,
): Promise<void> {
  const ids = [...arks.map((ark) => ark.id), buffer.id];
  const [balances, supplyCaps] = (await Promise.all([
    Promise.all(ids.map((id) => getExpectedSupplyAssets(id))),
    Promise.all(ids.map((id) => getSupplyCap(id))),
  ])) as [bigint[], bigint[]];

  arks.forEach((ark, i) => {
    ark.realInitialAssets = balances[i]!;
    ark.supplyCap = supplyCaps[i]!;
  });
  buffer.realInitialAssets = balances[balances.length - 1]!;
  buffer.supplyCap = supplyCaps[supplyCaps.length - 1]!;
}

// ============= Helpers =============

function abortRun(reason: string): never {
  log.error({ event: 'metavault_run_aborted', reason }, `metavault run aborted: ${reason}`);
  throw new RunAbortError(reason);
}

function _toArks(allocations: ArkAllocation<RuntimeVault>[]): Ark<RuntimeVault>[] {
  return allocations.map((a) => ({
    vault: a.vault,
    min: a.min,
    max: a.max,
    rate: a.rate,
  }));
}

async function _getPausedArks(): Promise<Address[]> {
  const paused: Address[] = [];
  for (const arkConfig of config.arks) {
    const vault = createVault(arkConfig.address);
    if (await vault.isPaused()) {
      paused.push(arkConfig.address);
    }
  }
  return paused;
}

function _getHaltedArks(): Address[] {
  return config.arks.filter((a) => isArkHalted(a.address)).map((a) => a.address);
}
