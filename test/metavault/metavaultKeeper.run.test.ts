import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maxUint256, type Address } from 'viem';
import { accrualPad } from '../helpers/eulerModel';

const BUFFER = '0x00000000000000000000000000000000000000ff' as Address;
const ARK_A = '0x00000000000000000000000000000000000000a1' as Address;
const ARK_B = '0x00000000000000000000000000000000000000b2' as Address;
const S = 1_000_000n;
const TX_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;

type ArkConfig = {
  address: Address;
  allocation: { min: number; max: number };
};

function buildVaultFixture(
  address: Address,
  {
    paused = false,
    rate = 100n,
    assetDecimals = 18,
  }: { paused?: boolean; rate?: bigint; assetDecimals?: number } = {},
) {
  return {
    getAddress: () => address,
    isPaused: vi.fn().mockResolvedValue(paused),
    getBorrowFeeRate: vi.fn().mockResolvedValue(rate),
    getAssetDecimals: vi.fn().mockResolvedValue(assetDecimals),
    drain: vi.fn().mockResolvedValue(TX_HASH),
    moveToBuffer: vi.fn().mockResolvedValue(TX_HASH),
  };
}

function resetMetavaultKeeperModules() {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/ark/vault.ts');
  vi.doUnmock('../../src/keepers/arkKeeper.ts');
  vi.doUnmock('../../src/metavault/metavault.ts');
  vi.doUnmock('../../src/metavault/utils/evaluateRates.ts');
  vi.doUnmock('../../src/ajna/poolHealth.ts');
  vi.doUnmock('../../src/ark/utils/selectBuckets.ts');
  vi.doUnmock('../../src/utils/transaction.ts');
  vi.doUnmock('../../src/ajna/utils/poolBalanceCap.ts');
  vi.doUnmock('../../src/utils/logger.ts');
}

beforeEach(() => {
  resetMetavaultKeeperModules();
});

afterEach(() => {
  resetMetavaultKeeperModules();
});

async function setupMetavaultRunTest({
  arkConfigs = [
    { address: ARK_A, allocation: { min: 5, max: 20 } },
    { address: ARK_B, allocation: { min: 5, max: 60 } },
  ],
  balances = {
    [BUFFER]: 400n * S,
    [ARK_A]: 100n * S,
    [ARK_B]: 500n * S,
  } as Partial<Record<Address, bigint>>,
  totalAssets = 1000n * S,
  vaults,
  evaluations = [],
  bucketPlan = [],
  poolBalanceCaps = {},
  supplyCaps = {},
  accrued = {},
  poolHasBadDebt = vi.fn().mockResolvedValue(false),
  haltedArks = [],
  minMoveAmount = '1000001',
}: {
  arkConfigs?: ArkConfig[];
  balances?: Partial<Record<Address, bigint>>;
  totalAssets?: bigint;
  vaults?: Partial<Record<Address, ReturnType<typeof buildVaultFixture>>>;
  evaluations?: Array<{ address: Address; targets: Address[] }>;
  bucketPlan?: Array<{ bucket: bigint; amount: bigint }>;
  poolBalanceCaps?: Partial<Record<Address, bigint>>;
  supplyCaps?: Partial<Record<Address, bigint>>;
  accrued?: Partial<Record<Address, bigint>>;
  poolHasBadDebt?: (vault: { getAddress: () => Address }) => Promise<boolean>;
  haltedArks?: Address[];
  minMoveAmount?: string;
} = {}) {
  const vaultFixtures = {
    [ARK_A]: buildVaultFixture(ARK_A, { rate: 100n }),
    [ARK_B]: buildVaultFixture(ARK_B, { rate: 200n }),
    ...(vaults ?? {}),
  } as Record<Address, ReturnType<typeof buildVaultFixture>>;

  const balanceMap = {
    [BUFFER]: 400n * S,
    [ARK_A]: 100n * S,
    [ARK_B]: 500n * S,
    ...balances,
  } as Record<Address, bigint>;

  const callCounts: Record<Address, number> = {};
  const getExpectedSupplyAssets = vi.fn(async (address: Address) => {
    callCounts[address] = (callCounts[address] ?? 0) + 1;
    const base = balanceMap[address] ?? 0n;
    const accrual = accrued[address];
    return callCounts[address]! > 1 && accrual !== undefined ? base + accrual : base;
  });
  const getSupplyCap = vi.fn(async (address: Address) => supplyCaps[address] ?? maxUint256);
  const getTotalExpectedSupplyAssets = vi.fn().mockResolvedValue(totalAssets);
  const reallocate = vi.fn().mockReturnValue({ kind: 'reallocate' });
  const evaluateRates = vi.fn().mockReturnValue(evaluations);
  const selectBuckets = vi.fn().mockResolvedValue(bucketPlan);
  const handleTransaction = vi.fn(async (_tx: unknown, ctx?: Record<string, unknown>) => ({
    status: true,
    assets: (ctx?.amount as bigint) ?? 0n,
  }));
  const getGasWithBuffer = vi.fn().mockResolvedValue(77n);
  const poolBalanceCapAsset = vi.fn(
    async (amount: bigint, vault: { getAddress: () => Address }) => {
      return poolBalanceCaps[vault.getAddress()] ?? amount;
    },
  );
  const log = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  vi.doMock('../../src/utils/config.ts', () => ({
    config: {
      minRateDiff: 10,
      keeper: { logLevel: 'warn', haltIfLupBelowHtp: true },
      oracle: {
        onchainPrimary: false,
        onchainMaxStaleness: null,
        fixedPrice: null,
        futureSkewTolerance: 120,
      },
      arkGlobal: { optimalBucketDiff: 1, maxAuctionAge: 259200, minMoveAmount },
      transaction: { confirmations: 1 },
      defaultGas: 3_000_000n,
      gasBuffer: 50n,
      chainId: 1,
      buffer: { address: BUFFER, allocation: 40 },
      arks: arkConfigs,
    },
    resolveArkSettings: () => ({
      optimalBucketDiff: 1n,
      bufferPadding: 0n,
      minMoveAmount: BigInt(minMoveAmount),
      minTimeSinceBankruptcy: 0n,
      maxAuctionAge: 0,
    }),
  }));
  vi.doMock('../../src/ark/vault.ts', () => ({
    createVault: vi.fn((address: Address) => {
      const fixture = vaultFixtures[address];
      if (!fixture) throw new Error(`Missing vault fixture for ${address}`);
      return fixture;
    }),
  }));
  const haltedSet = new Set<Address>(haltedArks);
  const isArkHalted = vi.fn((address: Address) => haltedSet.has(address));
  vi.doMock('../../src/keepers/arkKeeper.ts', () => ({
    isArkHalted,
  }));
  vi.doMock('../../src/metavault/metavault.ts', () => ({
    getExpectedSupplyAssets,
    getSupplyCap,
    getTotalExpectedSupplyAssets,
    reallocate,
  }));
  vi.doMock('../../src/metavault/utils/evaluateRates.ts', () => ({
    evaluateRates,
  }));
  vi.doMock('../../src/ajna/poolHealth.ts', () => ({
    poolHasBadDebt,
  }));
  vi.doMock('../../src/ark/utils/selectBuckets.ts', () => ({
    selectBuckets,
  }));
  vi.doMock('../../src/utils/transaction.ts', () => ({
    handleTransaction,
    getGasWithBuffer,
  }));
  vi.doMock('../../src/ajna/utils/poolBalanceCap.ts', () => ({
    poolBalanceCapAsset,
  }));
  vi.doMock('../../src/utils/logger.ts', () => ({ log }));

  const { metavaultRun } = await import('../../src/keepers/metavaultKeeper.ts');

  return {
    metavaultRun,
    vaults: vaultFixtures,
    getExpectedSupplyAssets,
    getSupplyCap,
    getTotalExpectedSupplyAssets,
    reallocate,
    selectBuckets,
    handleTransaction,
    getGasWithBuffer,
    poolHasBadDebt,
    isArkHalted,
    log,
  };
}

describe('metavaultRun orchestration', () => {
  // Regression (DIFFERENTIAL_REVIEW_REPORT #12): an ark halted by a previous LUPBelowHTP
  // transaction failure (via haltKeeper() in transaction.ts) must be treated like a paused ark
  // at the start of the next metavault run. Including a halted ark in allocation planning
  // produces a target that contradicts the intended configuration — the same correctness
  // argument that justifies the existing pause short-circuit.
  it('suppresses transaction-producing paths when any configured ark is halted', async () => {
    const liveVaultA = buildVaultFixture(ARK_A, { rate: 100n });
    const liveVaultB = buildVaultFixture(ARK_B, { rate: 300n });

    const {
      metavaultRun,
      getTotalExpectedSupplyAssets,
      reallocate,
      selectBuckets,
      handleTransaction,
      isArkHalted,
      log,
    } = await setupMetavaultRunTest({
      balances: {
        [BUFFER]: 400n * S,
        [ARK_A]: 300n * S,
        [ARK_B]: 300n * S,
      },
      evaluations: [
        { address: ARK_A, targets: [ARK_B] },
        { address: ARK_B, targets: [] },
      ],
      bucketPlan: [{ bucket: 4150n, amount: 100n * S }],
      vaults: {
        [ARK_A]: liveVaultA,
        [ARK_B]: liveVaultB,
      },
      haltedArks: [ARK_A],
    });

    await metavaultRun();

    expect(isArkHalted).toHaveBeenCalledWith(ARK_A);
    expect(isArkHalted).toHaveBeenCalledWith(ARK_B);
    expect(getTotalExpectedSupplyAssets).not.toHaveBeenCalled();
    expect(selectBuckets).not.toHaveBeenCalled();
    expect(reallocate).not.toHaveBeenCalled();
    expect(handleTransaction).not.toHaveBeenCalled();
    // The halt check is a pure, in-memory short-circuit. It must run before the paused-arks
    // probe so we never burn an RPC on isPaused() when planning is already known to be unsafe.
    expect(liveVaultA.isPaused).not.toHaveBeenCalled();
    expect(liveVaultB.isPaused).not.toHaveBeenCalled();
    expect(liveVaultA.getBorrowFeeRate).not.toHaveBeenCalled();
    expect(liveVaultB.getBorrowFeeRate).not.toHaveBeenCalled();
    expect(liveVaultA.drain).not.toHaveBeenCalled();
    expect(liveVaultA.moveToBuffer).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'halted_arks_detected', arks: [ARK_A] }),
      expect.stringContaining('halted'),
    );
  });

  it('suppresses transaction-producing paths when any configured ark is paused', async () => {
    const pausedVault = buildVaultFixture(ARK_A, { paused: true, rate: 100n });
    const liveVault = buildVaultFixture(ARK_B, { rate: 300n });

    const {
      metavaultRun,
      getTotalExpectedSupplyAssets,
      reallocate,
      selectBuckets,
      handleTransaction,
    } = await setupMetavaultRunTest({
      balances: {
        [BUFFER]: 400n * S,
        [ARK_A]: 300n * S,
        [ARK_B]: 300n * S,
      },
      evaluations: [
        { address: ARK_A, targets: [ARK_B] },
        { address: ARK_B, targets: [] },
      ],
      bucketPlan: [{ bucket: 4150n, amount: 100n * S }],
      vaults: {
        [ARK_A]: pausedVault,
        [ARK_B]: liveVault,
      },
    });

    await metavaultRun();

    expect(getTotalExpectedSupplyAssets).not.toHaveBeenCalled();
    expect(selectBuckets).not.toHaveBeenCalled();
    expect(reallocate).not.toHaveBeenCalled();
    expect(handleTransaction).not.toHaveBeenCalled();
    expect(pausedVault.getBorrowFeeRate).not.toHaveBeenCalled();
    expect(pausedVault.drain).not.toHaveBeenCalled();
    expect(pausedVault.moveToBuffer).not.toHaveBeenCalled();
    expect(liveVault.getBorrowFeeRate).not.toHaveBeenCalled();
    expect(liveVault.drain).not.toHaveBeenCalled();
    expect(liveVault.moveToBuffer).not.toHaveBeenCalled();
  });

  it('drains the selected bucket and moves the exact decreased amount back to the buffer', async () => {
    const { metavaultRun, vaults, selectBuckets, handleTransaction, getGasWithBuffer, reallocate } =
      await setupMetavaultRunTest({
        balances: {
          [BUFFER]: 400n * S,
          [ARK_A]: 300n * S,
          [ARK_B]: 300n * S,
        },
        evaluations: [],
        bucketPlan: [{ bucket: 4150n, amount: 100n * S }],
      });

    const arkA = vaults[ARK_A]!;
    const arkB = vaults[ARK_B]!;

    await metavaultRun();

    expect(selectBuckets).toHaveBeenCalledOnce();
    expect(selectBuckets).toHaveBeenCalledWith(arkA, 100n * S);
    expect(arkA.drain).toHaveBeenCalledOnce();
    expect(arkA.drain).toHaveBeenCalledWith(4150n);
    expect(getGasWithBuffer).toHaveBeenCalledWith(
      'vault',
      'moveToBuffer',
      [4150n, 100n * S],
      ARK_A,
    );
    expect(arkA.moveToBuffer).toHaveBeenCalledOnce();
    expect(arkA.moveToBuffer).toHaveBeenCalledWith(4150n, 100n * S, 77n);
    expect(arkB.drain).not.toHaveBeenCalled();
    expect(arkB.moveToBuffer).not.toHaveBeenCalled();
    expect(reallocate).toHaveBeenCalledOnce();
    expect(reallocate).toHaveBeenCalledWith(
      [
        { id: ARK_A, assets: 200n * S + accrualPad(300n * S, 100n * S) },
        { id: ARK_B, assets: maxUint256 },
      ],
      3_000_000n,
    );
    expect(handleTransaction).toHaveBeenCalledTimes(3);
  });

  // Regression (PR19-D07): Ajna removeQuoteToken removes up to the requested amount, so a
  // confirmed moveToBuffer can deliver less than planned (escrowed cash, collateral in the
  // bucket, or another lender shrinking the position). The run must reconcile the decoded
  // receipt amounts and abort before reallocate when the buffer is underprepared.
  it('aborts before reallocate when moveToBuffer receipts cover less than the planned decrease', async () => {
    const { metavaultRun, handleTransaction, reallocate, log } = await setupMetavaultRunTest({
      balances: {
        [BUFFER]: 400n * S,
        [ARK_A]: 300n * S,
        [ARK_B]: 300n * S,
      },
      evaluations: [],
      bucketPlan: [{ bucket: 4150n, amount: 100n * S }],
    });

    handleTransaction.mockImplementation(async (_tx: unknown, ctx?: Record<string, unknown>) => {
      if (ctx?.action === 'moveToBuffer') return { status: true, assets: 60n * S };
      return { status: true, assets: (ctx?.amount as bigint) ?? 0n };
    });

    await metavaultRun();

    expect(reallocate).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'metavault_run_aborted',
        reason: expect.stringContaining('moveToBuffer receipts for ark'),
      }),
      expect.stringContaining('cover'),
    );
  });

  it('uses live supply caps to limit target increases during a buffer drain', async () => {
    const { metavaultRun, getSupplyCap, reallocate, selectBuckets, handleTransaction, log } =
      await setupMetavaultRunTest({
        balances: {
          [BUFFER]: 450n * S,
          [ARK_A]: 70n * S,
          [ARK_B]: 480n * S,
        },
        supplyCaps: {
          [ARK_B]: 500n * S,
        },
      });

    await metavaultRun();

    expect(getSupplyCap).toHaveBeenCalledWith(BUFFER);
    expect(getSupplyCap).toHaveBeenCalledWith(ARK_A);
    expect(getSupplyCap).toHaveBeenCalledWith(ARK_B);
    expect(selectBuckets).not.toHaveBeenCalled();
    expect(reallocate).toHaveBeenCalledWith(
      [
        { id: BUFFER, assets: 400n * S + accrualPad(450n * S, 50n * S) },
        { id: ARK_A, assets: 100n * S },
        { id: ARK_B, assets: maxUint256 },
      ],
      3_000_000n,
    );
    expect(handleTransaction).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('does not pre-move an ark whose planned decrease is fully absorbed by the accrual pad', async () => {
    const { metavaultRun, vaults, selectBuckets, reallocate } = await setupMetavaultRunTest({
      balances: {
        [BUFFER]: 280n * S,
        [ARK_A]: 100_000n * S,
        [ARK_B]: 620n * S,
      },
      poolBalanceCaps: {
        [ARK_A]: 100n * S,
      },
      bucketPlan: [{ bucket: 4150n, amount: 70n * S }],
    });

    await metavaultRun();

    expect(selectBuckets).toHaveBeenCalledOnce();
    expect(selectBuckets).toHaveBeenCalledWith(vaults[ARK_B]!, 70n * S);
    expect(vaults[ARK_A]!.drain).not.toHaveBeenCalled();
    expect(vaults[ARK_A]!.moveToBuffer).not.toHaveBeenCalled();
    expect(vaults[ARK_B]!.drain).toHaveBeenCalledOnce();
    expect(vaults[ARK_B]!.moveToBuffer).toHaveBeenCalledOnce();
    expect(reallocate).toHaveBeenCalledWith(
      [
        { id: ARK_B, assets: 550n * S + accrualPad(620n * S, 70n * S) },
        { id: BUFFER, assets: maxUint256 },
      ],
      3_000_000n,
    );
  });

  it('treats unchanged target allocations as a no-op and skips reallocate', async () => {
    const { metavaultRun, reallocate, selectBuckets, handleTransaction } =
      await setupMetavaultRunTest({
        balances: {
          [BUFFER]: 400n * S,
          [ARK_A]: 150n * S,
          [ARK_B]: 450n * S,
        },
        evaluations: [],
      });

    await metavaultRun();

    expect(selectBuckets).not.toHaveBeenCalled();
    expect(reallocate).not.toHaveBeenCalled();
    expect(handleTransaction).not.toHaveBeenCalled();
  });

  it('aborts the run when a drain in _executeMoveToBufferCalls fails', async () => {
    const { metavaultRun, vaults, reallocate, handleTransaction } = await setupMetavaultRunTest({
      balances: {
        [BUFFER]: 400n * S,
        [ARK_A]: 300n * S,
        [ARK_B]: 300n * S,
      },
      bucketPlan: [{ bucket: 4150n, amount: 100n * S }],
      evaluations: [],
    });

    handleTransaction.mockImplementation(async (_tx: unknown, ctx?: Record<string, unknown>) => {
      if (ctx?.action === 'drain') return { status: false, assets: 0n };
      return { status: true, assets: (ctx?.amount as bigint) ?? 0n };
    });

    await metavaultRun();

    expect(vaults[ARK_A]!.drain).toHaveBeenCalledOnce();
    expect(vaults[ARK_A]!.moveToBuffer).not.toHaveBeenCalled();
    expect(reallocate).not.toHaveBeenCalled();
  });

  // Regression: a pool-capped ARK can have a real Euler supply much larger than the planner's
  // working balance. The submitted reallocate() target must be derived from the real supply, not
  // the cap, otherwise Euler tries to withdraw the entire illiquid portion.
  it('uses real Euler supply (not pool-capped balance) when building decreasing reallocate targets', async () => {
    const { metavaultRun, vaults, selectBuckets, reallocate } = await setupMetavaultRunTest({
      arkConfigs: [{ address: ARK_A, allocation: { min: 5, max: 60 } }],
      balances: {
        [BUFFER]: 500n * S,
        [ARK_A]: 1000n * S,
      },
      totalAssets: 1500n * S,
      poolBalanceCaps: {
        [ARK_A]: 200n * S,
      },
      bucketPlan: [{ bucket: 4150n, amount: 100n * S }],
      evaluations: [],
    });

    await metavaultRun();

    expect(selectBuckets).toHaveBeenCalledWith(vaults[ARK_A]!, 100n * S);
    expect(vaults[ARK_A]!.drain).toHaveBeenCalledOnce();
    expect(vaults[ARK_A]!.moveToBuffer).toHaveBeenCalledOnce();
    expect(reallocate).toHaveBeenCalledOnce();
    expect(reallocate).toHaveBeenCalledWith(
      [
        // realInitialAssets (1000) − plannedDecrease (100) + clamped accrualPad(1000, 100)
        { id: ARK_A, assets: 900n * S + accrualPad(1000n * S, 100n * S) },
        { id: BUFFER, assets: maxUint256 },
      ],
      3_000_000n,
    );
  });

  // Regression: interest can accrue between the keeper snapshot and reallocate(), and `drain`
  // explicitly claims pending interest. The refresh before reallocate keeps the submitted target
  // anchored to the current real balance so the withdrawal equals what was prepared.
  it('refreshes real Euler supply before reallocate so accrued interest does not underfund withdrawal', async () => {
    const { metavaultRun, reallocate, getExpectedSupplyAssets } = await setupMetavaultRunTest({
      balances: {
        [BUFFER]: 400n * S,
        [ARK_A]: 300n * S,
        [ARK_B]: 300n * S,
      },
      accrued: {
        [ARK_A]: 5n * S, // ARK_A real grows by 5*S between snapshot and refresh
      },
      bucketPlan: [{ bucket: 4150n, amount: 100n * S }],
      evaluations: [],
    });

    await metavaultRun();

    // ARK_A is read twice: once during _buildArkAllocations, again during _refreshRealInitialAssets.
    const arkACalls = getExpectedSupplyAssets.mock.calls.filter(([addr]) => addr === ARK_A).length;
    expect(arkACalls).toBe(2);

    expect(reallocate).toHaveBeenCalledOnce();
    expect(reallocate).toHaveBeenCalledWith(
      [
        // refreshed real (305) − plannedDecrease (100) + clamped accrualPad(305, 100)
        { id: ARK_A, assets: 205n * S + accrualPad(305n * S, 100n * S) },
        { id: ARK_B, assets: maxUint256 },
      ],
      3_000_000n,
    );
  });

  // Regression: selectBuckets() may return a partial plan (e.g. no bucket is large enough, dust
  // skips reduce coverage). The keeper must abort before issuing any drain or moveToBuffer so the
  // ARK's internal buffer is never partially funded and reallocate() never sees a short ARK.
  it('aborts before any pre-move when the bucket plan does not cover the planned decrease', async () => {
    const { metavaultRun, vaults, selectBuckets, handleTransaction, reallocate } =
      await setupMetavaultRunTest({
        balances: {
          [BUFFER]: 400n * S,
          [ARK_A]: 300n * S,
          [ARK_B]: 300n * S,
        },
        bucketPlan: [{ bucket: 4150n, amount: 30n * S }], // only 30*S vs planned 100*S
        evaluations: [],
      });

    await metavaultRun();

    expect(selectBuckets).toHaveBeenCalledOnce();
    expect(vaults[ARK_A]!.drain).not.toHaveBeenCalled();
    expect(vaults[ARK_A]!.moveToBuffer).not.toHaveBeenCalled();
    expect(handleTransaction).not.toHaveBeenCalled();
    expect(reallocate).not.toHaveBeenCalled();
  });

  // Regression: amountToMove from previewRedeem is in asset decimals, but selectBuckets compares
  // against lpToValue() (WAD) and moveToBuffer's contract function expects _wad. For a 6-decimal
  // quote token (e.g. USDC), the keeper must convert at the boundary or it under-counts every
  // move by 10^12 and effectively no-ops.
  it('converts amountToMove to WAD when the ARK quote token is not 18 decimals', async () => {
    const SIX_DEC = 10n ** 6n; // 1 token in asset decimals
    const WAD = 10n ** 18n;
    const arkA = buildVaultFixture(ARK_A, { rate: 100n, assetDecimals: 6 });
    const arkB = buildVaultFixture(ARK_B, { rate: 200n, assetDecimals: 6 });

    const { metavaultRun, selectBuckets, reallocate } = await setupMetavaultRunTest({
      balances: {
        [BUFFER]: 400n * SIX_DEC,
        [ARK_A]: 300n * SIX_DEC,
        [ARK_B]: 300n * SIX_DEC,
      },
      totalAssets: 1000n * SIX_DEC,
      // selectBuckets is mocked to return whatever the test provides; the production
      // implementation returns lpToValue() amounts which are WAD.
      bucketPlan: [{ bucket: 4150n, amount: 100n * WAD }],
      evaluations: [],
      vaults: { [ARK_A]: arkA, [ARK_B]: arkB },
    });

    await metavaultRun();

    // ARK_A's planned decrease is 100 tokens = 100*1e6 in asset decimals → 100*1e18 in WAD.
    expect(selectBuckets).toHaveBeenCalledWith(arkA, 100n * WAD);
    expect(arkA.moveToBuffer).toHaveBeenCalledWith(4150n, 100n * WAD, 77n);
    expect(reallocate).toHaveBeenCalledOnce();
    // Reallocate targets are still asset-denominated (Euler reads previewRedeem in asset
    // decimals). realInitialAssets (300*1e6) − planned decrease (100*1e6) + clamped pad
    // (min(300*1e6 * 5/10000, 100*1e6) = 150_000) = 200_150_000.
    expect(reallocate).toHaveBeenCalledWith(
      [
        { id: ARK_A, assets: 200_150_000n },
        { id: ARK_B, assets: maxUint256 },
      ],
      3_000_000n,
    );
  });

  // Regression (PR19-D04): arkGlobal.minMoveAmount is documented and configured in WAD, but the
  // planner compares it against Euler balances denominated in native asset decimals. For a
  // 6-decimal asset, a 1-token threshold (1e18 WAD) was previously interpreted as 1e12 tokens,
  // suppressing the buffer fill entirely and aborting the run on buffer-below-target validation.
  it('converts a WAD minMoveAmount to asset decimals so valid 6-decimal moves are not suppressed', async () => {
    const SIX_DEC = 10n ** 6n;
    const WAD = 10n ** 18n;
    const arkA = buildVaultFixture(ARK_A, { rate: 100n, assetDecimals: 6 });
    const arkB = buildVaultFixture(ARK_B, { rate: 200n, assetDecimals: 6 });

    const { metavaultRun, selectBuckets, reallocate, log } = await setupMetavaultRunTest({
      minMoveAmount: WAD.toString(),
      balances: {
        [BUFFER]: 350n * SIX_DEC,
        [ARK_A]: 200n * SIX_DEC,
        [ARK_B]: 450n * SIX_DEC,
      },
      totalAssets: 1000n * SIX_DEC,
      bucketPlan: [{ bucket: 4150n, amount: 50n * WAD }],
      evaluations: [],
      vaults: { [ARK_A]: arkA, [ARK_B]: arkB },
    });

    await metavaultRun();

    // The 50-token buffer deficit is sourced from the lowest-rate ark (ARK_A). The converted
    // threshold is 1 token (1e6), so the 50e6 deduction must not be gated.
    expect(selectBuckets).toHaveBeenCalledWith(arkA, 50n * WAD);
    expect(reallocate).toHaveBeenCalledOnce();
    expect(reallocate).toHaveBeenCalledWith(
      [
        { id: ARK_A, assets: 150n * SIX_DEC + accrualPad(200n * SIX_DEC, 50n * SIX_DEC) },
        { id: BUFFER, assets: maxUint256 },
      ],
      3_000_000n,
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('does not count sub-token-unit WAD bucket legs as metavault pre-move coverage', async () => {
    const SIX_DEC = 10n ** 6n;
    const WAD = 10n ** 18n;
    const TOKEN_UNIT_WAD = 10n ** 12n;
    const arkA = buildVaultFixture(ARK_A, { rate: 100n, assetDecimals: 6 });
    const arkB = buildVaultFixture(ARK_B, { rate: 200n, assetDecimals: 6 });
    const subTokenLeg = TOKEN_UNIT_WAD - 1n;

    const { metavaultRun, selectBuckets, handleTransaction, reallocate } =
      await setupMetavaultRunTest({
        balances: {
          [BUFFER]: 400n * SIX_DEC,
          [ARK_A]: 300n * SIX_DEC,
          [ARK_B]: 300n * SIX_DEC,
        },
        totalAssets: 1000n * SIX_DEC,
        bucketPlan: [
          { bucket: 4149n, amount: subTokenLeg },
          { bucket: 4150n, amount: 100n * WAD - subTokenLeg },
        ],
        evaluations: [],
        vaults: { [ARK_A]: arkA, [ARK_B]: arkB },
      });

    await metavaultRun();

    expect(selectBuckets).toHaveBeenCalledWith(arkA, 100n * WAD);
    expect(arkA.drain).not.toHaveBeenCalled();
    expect(arkA.moveToBuffer).not.toHaveBeenCalled();
    expect(handleTransaction).not.toHaveBeenCalled();
    expect(reallocate).not.toHaveBeenCalled();
  });

  // Regression: _executeMoveToBufferCalls validates all decreasing ARKs' bucket plans in pass 1
  // before any drain/moveToBuffer fires in pass 2. A future refactor that interleaves
  // drain+moveToBuffer with the per-ARK coverage check would let an earlier ARK fully execute its
  // pre-moves and then strand them when a later ARK's plan is short — exactly the multi-ARK
  // partial-pre-move issue this refactor closes.
  it('aborts both ARKs even when only the second has insufficient bucket coverage', async () => {
    const { metavaultRun, vaults, selectBuckets, handleTransaction, reallocate } =
      await setupMetavaultRunTest({
        arkConfigs: [
          { address: ARK_A, allocation: { min: 5, max: 20 } },
          { address: ARK_B, allocation: { min: 5, max: 60 } },
        ],
        balances: {
          [BUFFER]: 100n * S,
          [ARK_A]: 300n * S,
          [ARK_B]: 700n * S,
        },
        totalAssets: 1100n * S,
        evaluations: [],
      });

    // ARK_A's plan fully covers its 245*S planned decrease; ARK_B's plan only covers 30*S of its
    // 95*S planned decrease. Validate-all-then-execute must abort before ARK_A's drain fires.
    selectBuckets.mockImplementation(
      async (vault: { getAddress: () => Address }, amount: bigint) => {
        if (vault.getAddress() === ARK_A) return [{ bucket: 4150n, amount }];
        return [{ bucket: 4151n, amount: 30n * S }];
      },
    );

    await metavaultRun();

    // Pass 1 must reach both ARKs.
    expect(selectBuckets).toHaveBeenCalledTimes(2);
    // Pass 2 (state changes) must never run for either ARK.
    expect(vaults[ARK_A]!.drain).not.toHaveBeenCalled();
    expect(vaults[ARK_A]!.moveToBuffer).not.toHaveBeenCalled();
    expect(vaults[ARK_B]!.drain).not.toHaveBeenCalled();
    expect(vaults[ARK_B]!.moveToBuffer).not.toHaveBeenCalled();
    expect(handleTransaction).not.toHaveBeenCalled();
    expect(reallocate).not.toHaveBeenCalled();
  });

  // Regression: _validateAllocations and the consistency portion of _buildFinalAllocations must
  // run before _executeMoveToBufferCalls. Otherwise an invalid plan can fire drain/moveToBuffer
  // and strand assets in the ARK buffer before the keeper discovers it cannot submit a valid
  // reallocate() — leaving operator state inconsistent with onchain state and producing the
  // scheduler-undo path described in DIFFERENTIAL_REVIEW_REPORT issue #3.
  //
  // Scenario: BUFFER far below target with both ARKs near their minimums. _rebalanceBuffer drains
  // both ARKs to zero in the below-min pass, but the buffer deficit (~150*S) is larger than the
  // arks' combined available capital, so the run lands with ARK_A and ARK_B below their 5% min
  // *and* BUFFER below its 40% target. That trips _validateAllocations' "below min" branch
  // (which gates on !bufferAtTarget). bucketPlan is set wide enough that, without the ordering
  // guarantee, _executeMoveToBufferCalls would happily run drain+moveToBuffer for ARK_A.
  it('skips pre-moves when _validateAllocations rejects the plan before any drain or moveToBuffer fires', async () => {
    const { metavaultRun, vaults, selectBuckets, handleTransaction, reallocate } =
      await setupMetavaultRunTest({
        balances: {
          [BUFFER]: 100n * S,
          [ARK_A]: 100n * S,
          [ARK_B]: 50n * S,
        },
        bucketPlan: [{ bucket: 4150n, amount: 100n * S }],
        evaluations: [],
      });

    await metavaultRun();

    expect(selectBuckets).not.toHaveBeenCalled();
    expect(vaults[ARK_A]!.drain).not.toHaveBeenCalled();
    expect(vaults[ARK_A]!.moveToBuffer).not.toHaveBeenCalled();
    expect(vaults[ARK_B]!.drain).not.toHaveBeenCalled();
    expect(vaults[ARK_B]!.moveToBuffer).not.toHaveBeenCalled();
    expect(handleTransaction).not.toHaveBeenCalled();
    expect(reallocate).not.toHaveBeenCalled();
  });

  // Regression: _refreshRealInitialAssets is only meaningful when it can update the targets that
  // reallocate() will submit. With validation and the consistency preview moved before
  // _executeMoveToBufferCalls, the no-op short-circuit (preview.length === 0) must skip the
  // refresh entirely — there is nothing to refresh for, and an extra RPC pass is wasted work that
  // could mask bugs in the snapshot read pattern.
  it('does not refresh balances when no allocation deltas exist', async () => {
    const { metavaultRun, getExpectedSupplyAssets } = await setupMetavaultRunTest({
      balances: {
        [BUFFER]: 400n * S,
        [ARK_A]: 150n * S,
        [ARK_B]: 450n * S,
      },
      evaluations: [],
    });

    await metavaultRun();

    // Each of BUFFER, ARK_A, ARK_B is read exactly once during _buildArkAllocations /
    // _buildBufferAllocation. The refresh (a second read for each) must not fire.
    const callsPer = (addr: Address) =>
      getExpectedSupplyAssets.mock.calls.filter(([a]) => a === addr).length;
    expect(callsPer(BUFFER)).toBe(1);
    expect(callsPer(ARK_A)).toBe(1);
    expect(callsPer(ARK_B)).toBe(1);
  });

  // Regression (DIFFERENTIAL_REVIEW_REPORT #11): a failed bad-debt read must halt the entire
  // metavault run, not silently degrade to "all arks have bad debt". The previous behavior
  // conflated a failed read with confirmed bad debt: inbound allocation to those arks was
  // blocked, but the keeper still pre-moved and submitted reallocate(), operating on stale
  // risk data while the bad-debt check was unavailable.
  it('aborts the run without pre-moves or reallocate when poolHasBadDebt fails closed', async () => {
    const badDebtReadFailure = new Error('auction enumeration failed');
    const poolHasBadDebt = vi.fn(async () => {
      throw badDebtReadFailure;
    });

    const { metavaultRun, vaults, selectBuckets, handleTransaction, reallocate } =
      await setupMetavaultRunTest({
        balances: {
          [BUFFER]: 400n * S,
          [ARK_A]: 300n * S,
          [ARK_B]: 300n * S,
        },
        bucketPlan: [{ bucket: 4150n, amount: 100n * S }],
        evaluations: [],
        poolHasBadDebt,
      });

    await expect(metavaultRun()).rejects.toThrow(badDebtReadFailure);

    expect(poolHasBadDebt).toHaveBeenCalled();
    expect(selectBuckets).not.toHaveBeenCalled();
    expect(vaults[ARK_A]!.drain).not.toHaveBeenCalled();
    expect(vaults[ARK_A]!.moveToBuffer).not.toHaveBeenCalled();
    expect(vaults[ARK_B]!.drain).not.toHaveBeenCalled();
    expect(vaults[ARK_B]!.moveToBuffer).not.toHaveBeenCalled();
    expect(handleTransaction).not.toHaveBeenCalled();
    expect(reallocate).not.toHaveBeenCalled();
  });

  // Regression: a confirmed per-ark bad-debt flag (the bad-debt read succeeds and reports bad
  // debt for one ark) must NOT short-circuit the whole run — the keeper continues planning
  // and can still allocate around the affected ark. This pairs with the abort-on-failed-read
  // test above to lock in the distinction between "ark has bad debt" and "we cannot determine
  // bad debt because the read failed."
  it('does not abort the run when poolHasBadDebt returns true for a single ark', async () => {
    const poolHasBadDebt = vi.fn(
      async (vault: { getAddress: () => Address }) => vault.getAddress() === ARK_A,
    );

    const { metavaultRun, log } = await setupMetavaultRunTest({
      bucketPlan: [{ bucket: 4150n, amount: 100n * S }],
      evaluations: [],
      poolHasBadDebt,
    });

    await metavaultRun();

    expect(poolHasBadDebt).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'metavault_run_aborted' }),
      expect.anything(),
    );
  });
});
