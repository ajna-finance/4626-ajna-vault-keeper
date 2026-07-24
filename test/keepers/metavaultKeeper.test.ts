import { describe, it, expect, vi } from 'vitest';
import {
  _isRateReallocationRequired,
  _validateAllocations,
  _rebalanceBuffer,
  _reallocateForRates,
  _buildFinalAllocations,
  type ArkAllocation,
  type BufferAllocation,
  type MarketAllocation,
} from '../../src/metavault/planner';

import { evaluateRates, type ArkEvaluation } from '../../src/metavault/utils/evaluateRates';
import { type createVault } from '../../src/ark/vault';
import { type Address, maxUint256 } from 'viem';
import { accrualPad, simulateEulerAccounting } from '../helpers/eulerModel';

vi.mock('../../src/utils/config', () => ({
  config: {
    minRateDiff: 10,
    keeper: { logLevel: 'warn', haltIfLupBelowHtp: true },
    oracle: {
      onchainPrimary: false,
      onchainMaxStaleness: null,
      fixedPrice: null,
      futureSkewTolerance: 120,
    },
    arkGlobal: { optimalBucketDiff: 1, maxAuctionAge: 259200, minMoveAmount: '1000001' },
    transaction: { confirmations: 1 },
    defaultGas: 3_000_000n,
    gasBuffer: 50n,
    chainId: 1,
  },
  resolveArkSettings: () => ({
    optimalBucketDiff: 1n,
    bufferPadding: 100000000000000n,
    minMoveAmount: 1_000_001n,
    minTimeSinceBankruptcy: 259200n,
    maxAuctionAge: 259200,
  }),
}));

const ADDR_A = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' as Address;
const ADDR_B = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' as Address;
const ADDR_C = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' as Address;
const ADDR_BUF = '0xdDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd' as Address;

// Scale factor so all move amounts exceed MIN_MOVE_AMOUNT (1_000_001 default)
const S = 1_000_000n;

type Vault = ReturnType<typeof createVault>;
const stubVault = {} as Vault;

function makeArk(overrides: Partial<ArkAllocation> & { id: Address }): ArkAllocation {
  const assets = overrides.assets ?? 0n;
  const initialAssets = overrides.initialAssets ?? assets;
  const realInitialAssets = overrides.realInitialAssets ?? initialAssets;
  return {
    vault: stubVault,
    min: 5,
    max: 20,
    rate: 100n,
    minMoveAmount: 1_000_001n,
    hasBadDebt: false,
    supplyCap: maxUint256,
    ...overrides,
    assets,
    initialAssets,
    realInitialAssets,
  };
}

function makeBuffer(overrides?: Partial<BufferAllocation>): BufferAllocation {
  const assets = overrides?.assets ?? 400n * S;
  const initialAssets = overrides?.initialAssets ?? assets;
  const realInitialAssets = overrides?.realInitialAssets ?? initialAssets;
  return {
    id: ADDR_BUF,
    allocation: 40,
    supplyCap: maxUint256,
    ...overrides,
    assets,
    initialAssets,
    realInitialAssets,
  };
}

// ============= _isRateReallocationRequired =============

describe('_isRateReallocationRequired', () => {
  it('returns false for an empty evaluations array', () => {
    expect(_isRateReallocationRequired([])).toBe(false);
  });

  it('returns false when no ark has any targets', () => {
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [] },
      { address: ADDR_B, targets: [] },
    ];
    expect(_isRateReallocationRequired(evaluations)).toBe(false);
  });

  it('returns true when any ark has at least one target', () => {
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];
    expect(_isRateReallocationRequired(evaluations)).toBe(true);
  });

  it('returns true when all arks have targets', () => {
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [ADDR_A] },
    ];
    expect(_isRateReallocationRequired(evaluations)).toBe(true);
  });
});

// ============= _rebalanceBuffer =============

describe('_rebalanceBuffer', () => {
  // totalAssets = 1000n * S for clean percentage math

  it('does nothing when buffer is exactly at target', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 200n * S, rate: 100n })];
    const buffer = makeBuffer({ assets: 400n * S });

    _rebalanceBuffer(arks, buffer, 1000n * S);

    expect(arks[0]!.assets).toBe(200n * S);
    expect(buffer.assets).toBe(400n * S);
  });

  describe('buffer deficit (fillBuffer)', () => {
    it('fills buffer from lowest-rate ark', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 200n * S, rate: 200n }),
        makeArk({ id: ADDR_B, assets: 200n * S, rate: 100n }),
      ];
      const buffer = makeBuffer({ assets: 350n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Buffer deficit = 50 * S
      // Lowest rate is B (100). B has 200*S, min = 50*S (5%), available = 150*S
      // Deduct 50*S from B
      expect(arks[1]!.assets).toBe(150n * S); // B reduced
      expect(arks[0]!.assets).toBe(200n * S); // A untouched
      expect(buffer.assets).toBe(400n * S);
    });

    it('fills the buffer when the deficit is exactly MIN_MOVE_AMOUNT', () => {
      const arks = [makeArk({ id: ADDR_A, assets: 200n * S, rate: 100n })];
      const buffer = makeBuffer({ assets: 400n * S - 1_000_001n });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      expect(arks[0]!.assets).toBe(200n * S - 1_000_001n);
      expect(buffer.assets).toBe(400n * S);
    });

    it('fills from multiple arks when lowest-rate ark hits min', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 200n * S, rate: 200n }),
        makeArk({ id: ADDR_B, assets: 70n * S, rate: 100n }),
      ];
      const buffer = makeBuffer({ assets: 350n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Buffer deficit = 50*S
      // B (lowest rate): 70*S - 50*S (min) = 20*S available, deduct 20*S
      // A (next lowest): 200*S - 50*S (min) = 150*S available, deduct remaining 30*S
      expect(arks[1]!.assets).toBe(50n * S); // B at min
      expect(arks[0]!.assets).toBe(170n * S); // A lost 30*S
      expect(buffer.assets).toBe(400n * S);
    });

    it('skips arks already at their minimum', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 200n * S, rate: 200n }),
        makeArk({ id: ADDR_B, assets: 50n * S, rate: 100n }), // already at min (5% of 1000*S)
      ];
      const buffer = makeBuffer({ assets: 380n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Buffer deficit = 20*S
      // B at min, skip. A: 200*S - 50*S = 150*S available, deduct 20*S
      expect(arks[1]!.assets).toBe(50n * S);
      expect(arks[0]!.assets).toBe(180n * S);
      expect(buffer.assets).toBe(400n * S);
    });

    it('fills from three arks in rate order (lowest first)', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 70n * S, rate: 300n }),
        makeArk({ id: ADDR_B, assets: 70n * S, rate: 100n }),
        makeArk({ id: ADDR_C, assets: 70n * S, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 340n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Buffer deficit = 60*S
      // Rate order: B(100), C(200), A(300)
      // B: 70*S - 50*S = 20*S available, deduct 20*S
      // C: 70*S - 50*S = 20*S available, deduct 20*S
      // A: 70*S - 50*S = 20*S available, deduct 20*S
      expect(arks[1]!.assets).toBe(50n * S);
      expect(arks[2]!.assets).toBe(50n * S);
      expect(arks[0]!.assets).toBe(50n * S);
      expect(buffer.assets).toBe(400n * S);
    });

    it('pulls below ark minimums when buffer target not met (buffer precedence)', () => {
      // All ARKs at their min after first pass, but buffer still short
      const arks = [
        makeArk({ id: ADDR_A, assets: 60n * S, rate: 200n }), // min = 50*S
        makeArk({ id: ADDR_B, assets: 60n * S, rate: 100n }), // min = 50*S
      ];
      const buffer = makeBuffer({ assets: 330n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Buffer deficit = 70*S
      // First pass: B(100) available = 10*S, deduct 10*S; A(200) available = 10*S, deduct 10*S
      // Deficit remaining = 50*S
      // Second pass (below mins): B has 50*S, deduct 50*S; A untouched
      expect(arks[1]!.assets).toBe(0n);
      expect(arks[0]!.assets).toBe(50n * S);
      expect(buffer.assets).toBe(400n * S);
    });

    it('pulls below minimums from multiple arks in rate order', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 55n * S, rate: 300n }), // min = 50*S
        makeArk({ id: ADDR_B, assets: 55n * S, rate: 100n }), // min = 50*S
        makeArk({ id: ADDR_C, assets: 55n * S, rate: 200n }), // min = 50*S
      ];
      const buffer = makeBuffer({ assets: 305n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Buffer deficit = 95*S
      // First pass: B(100) 5*S, C(200) 5*S, A(300) 5*S → deficit = 80*S
      // Second pass: B(100) has 50*S, deduct 50*S → deficit = 30*S
      //              C(200) has 50*S, deduct 30*S → deficit = 0
      expect(arks[1]!.assets).toBe(0n); // B fully drained
      expect(arks[2]!.assets).toBe(20n * S); // C partially drained
      expect(arks[0]!.assets).toBe(50n * S); // A untouched in second pass
      expect(buffer.assets).toBe(400n * S);
    });

    it('skips deduction when amount is below MIN_MOVE_AMOUNT', () => {
      // Ark B has only 1*S above its min — below MIN_MOVE_AMOUNT (1_000_001)
      const arks = [
        makeArk({ id: ADDR_A, assets: 200n * S, rate: 200n }),
        makeArk({ id: ADDR_B, assets: 51n * S, rate: 100n }), // available = 51*S - 50*S = 1*S < MIN_MOVE_AMOUNT
      ];
      const buffer = makeBuffer({ assets: 399n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // B's deduction (1*S) is below MIN_MOVE_AMOUNT, so it's skipped.
      // A's deduction (1*S of the remaining deficit) is also below MIN_MOVE_AMOUNT.
      expect(arks[1]!.assets).toBe(51n * S); // B unchanged
      expect(arks[0]!.assets).toBe(200n * S); // A unchanged
      expect(buffer.assets).toBe(399n * S); // buffer unchanged
    });

    it('limits buffer fills by the buffer supply cap', () => {
      const arks = [makeArk({ id: ADDR_A, assets: 200n * S, rate: 100n })];
      const buffer = makeBuffer({
        assets: 350n * S,
        initialAssets: 350n * S,
        realInitialAssets: 350n * S,
        supplyCap: 370n * S,
      });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      expect(arks[0]!.assets).toBe(180n * S);
      expect(buffer.assets).toBe(370n * S);
    });
  });

  describe('buffer excess (drainBuffer)', () => {
    it('drains excess to highest-rate ark', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 100n * S, rate: 100n }),
        makeArk({ id: ADDR_B, assets: 100n * S, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 450n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Excess = 50*S
      // Highest rate is B(200). B: max = 200*S (20%), capacity = 100*S, add 50*S
      expect(arks[1]!.assets).toBe(150n * S); // B increased
      expect(arks[0]!.assets).toBe(100n * S); // A untouched
      expect(buffer.assets).toBe(400n * S);
    });

    it('drains the buffer when the excess is exactly MIN_MOVE_AMOUNT', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 100n * S, rate: 100n }),
        makeArk({ id: ADDR_B, assets: 100n * S, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 400n * S + 1_000_001n });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      expect(arks[1]!.assets).toBe(100n * S + 1_000_001n);
      expect(arks[0]!.assets).toBe(100n * S);
      expect(buffer.assets).toBe(400n * S);
    });

    it('drains to multiple arks when highest-rate hits max', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 100n * S, rate: 100n }),
        makeArk({ id: ADDR_B, assets: 190n * S, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 450n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Excess = 50*S
      // B (highest rate): max 200*S, capacity = 10*S, add 10*S
      // A (next highest): max 200*S, capacity = 100*S, add 40*S
      expect(arks[1]!.assets).toBe(200n * S); // B at max
      expect(arks[0]!.assets).toBe(140n * S);
      expect(buffer.assets).toBe(400n * S);
    });

    it('excess stays in buffer when all arks hit max', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 200n * S, rate: 100n }),
        makeArk({ id: ADDR_B, assets: 200n * S, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 500n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Excess = 100*S, but both arks are already at max (200*S = 20%)
      expect(arks[0]!.assets).toBe(200n * S);
      expect(arks[1]!.assets).toBe(200n * S);
      expect(buffer.assets).toBe(500n * S); // excess stays
    });

    it('drains to three arks in rate order (highest first)', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 180n * S, rate: 300n }),
        makeArk({ id: ADDR_B, assets: 180n * S, rate: 100n }),
        makeArk({ id: ADDR_C, assets: 180n * S, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 460n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Excess = 60*S
      // Rate order (desc): A(300), C(200), B(100)
      // A: max 200*S, capacity = 20*S, add 20*S
      // C: max 200*S, capacity = 20*S, add 20*S
      // B: max 200*S, capacity = 20*S, add 20*S
      expect(arks[0]!.assets).toBe(200n * S);
      expect(arks[2]!.assets).toBe(200n * S);
      expect(arks[1]!.assets).toBe(200n * S);
      expect(buffer.assets).toBe(400n * S);
    });

    it('skips arks with bad debt when draining buffer', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 100n * S, rate: 100n }),
        makeArk({ id: ADDR_B, assets: 100n * S, rate: 200n, hasBadDebt: true }),
      ];
      const buffer = makeBuffer({ assets: 450n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // B has highest rate but bad debt — skipped. Excess goes to A.
      expect(arks[1]!.assets).toBe(100n * S); // B unchanged
      expect(arks[0]!.assets).toBe(150n * S); // A receives excess
      expect(buffer.assets).toBe(400n * S);
    });

    it('skips addition when amount is below MIN_MOVE_AMOUNT', () => {
      // Ark B has only 1*S capacity — below MIN_MOVE_AMOUNT (1_000_001)
      const arks = [
        makeArk({ id: ADDR_A, assets: 100n * S, rate: 100n }),
        makeArk({ id: ADDR_B, assets: 199n * S, rate: 200n }), // capacity = 200*S - 199*S = 1*S < MIN_MOVE_AMOUNT
      ];
      const buffer = makeBuffer({ assets: 401n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // B's addition (1*S) is below MIN_MOVE_AMOUNT, so it's skipped.
      // A's addition (1*S of remaining excess) is also below MIN_MOVE_AMOUNT.
      expect(arks[1]!.assets).toBe(199n * S); // B unchanged
      expect(arks[0]!.assets).toBe(100n * S); // A unchanged
      expect(buffer.assets).toBe(401n * S); // buffer unchanged
    });

    it('limits buffer drains by the target ark supply cap', () => {
      const arks = [
        makeArk({
          id: ADDR_A,
          assets: 100n * S,
          initialAssets: 100n * S,
          realInitialAssets: 100n * S,
          rate: 200n,
          supplyCap: 120n * S,
        }),
      ];
      const buffer = makeBuffer({ assets: 450n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      expect(arks[0]!.assets).toBe(120n * S);
      expect(buffer.assets).toBe(430n * S);
    });
  });
});

// ============= _reallocateForRates =============

describe('_reallocateForRates', () => {
  it('moves from lowest-rate to highest-rate ark', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 150n * S, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    // A: 150*S - 50*S (min) = 100*S available. B: 200*S (max) - 150*S = 50*S capacity
    // Move min(100*S, 50*S) = 50*S
    expect(arks[0]!.assets).toBe(100n * S);
    expect(arks[1]!.assets).toBe(200n * S);
  });

  it('respects min allocation for source ark', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 80n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 100n * S, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    // A: 80*S - 50*S = 30*S available. B: 200*S - 100*S = 100*S capacity. Move 30*S
    expect(arks[0]!.assets).toBe(50n * S); // at min
    expect(arks[1]!.assets).toBe(130n * S);
  });

  it('respects max allocation for target ark', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 180n * S, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    // A: 200*S - 50*S = 150*S available. B: 200*S - 180*S = 20*S capacity. Move 20*S
    expect(arks[0]!.assets).toBe(180n * S);
    expect(arks[1]!.assets).toBe(200n * S); // at max
  });

  it('does nothing when source is already at min', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 50n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 100n * S, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    expect(arks[0]!.assets).toBe(50n * S);
    expect(arks[1]!.assets).toBe(100n * S);
  });

  it('does nothing when target is already at max', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 200n * S, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    expect(arks[0]!.assets).toBe(150n * S);
    expect(arks[1]!.assets).toBe(200n * S);
  });

  it('does not supply a target whose real balance exceeds max even when its pool-capped balance is low', () => {
    // B lends into an illiquid pool: only 20*S of its quote is currently withdrawable
    // (its pool-capped working balance), but it really holds 250*S, already over its
    // 20% (200*S) max. It must receive nothing despite the low working balance.
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n * S, min: 5, max: 20, rate: 100n }),
      makeArk({
        id: ADDR_B,
        assets: 20n * S,
        initialAssets: 20n * S,
        realInitialAssets: 250n * S,
        min: 5,
        max: 20,
        rate: 200n,
      }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    expect(arks[0]!.assets).toBe(200n * S);
    expect(arks[1]!.assets).toBe(20n * S);
  });

  it('processes arks lowest to highest rate', () => {
    // A(rate=100) should be processed before C(rate=200)
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 100n * S, min: 5, max: 20, rate: 300n }),
      makeArk({ id: ADDR_C, assets: 150n * S, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
      { address: ADDR_C, targets: [ADDR_B] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    // A (rate 100, processed first): available = 150*S-50*S = 100*S. B capacity = 200*S-100*S = 100*S. Move 100*S
    // After A: A=50*S, B=200*S
    // C (rate 200, processed second): available = 150*S-50*S = 100*S. B capacity = 200*S-200*S = 0. No move
    expect(arks[0]!.assets).toBe(50n * S); // A drained to min
    expect(arks[1]!.assets).toBe(200n * S); // B at max
    expect(arks[2]!.assets).toBe(150n * S); // C unchanged
  });

  it('moves to next target when first target hits max', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 180n * S, min: 5, max: 20, rate: 300n }),
      makeArk({ id: ADDR_C, assets: 100n * S, min: 5, max: 20, rate: 250n }),
    ];
    // A targets B first, then C (sorted by rate desc in evaluateRates)
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B, ADDR_C] },
      { address: ADDR_B, targets: [] },
      { address: ADDR_C, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    // A: available = 150*S-50*S = 100*S
    // B: capacity = 200*S-180*S = 20*S. Move 20*S to B. A=130*S, available=80*S
    // C: capacity = 200*S-100*S = 100*S. Move 80*S to C. A=50*S, C=180*S
    expect(arks[0]!.assets).toBe(50n * S);
    expect(arks[1]!.assets).toBe(200n * S);
    expect(arks[2]!.assets).toBe(180n * S);
  });

  it('routes the exact amount to the next-best target when the top-rate target has bad debt', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 190n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 150n * S, min: 5, max: 20, rate: 400n, hasBadDebt: true }),
      makeArk({ id: ADDR_C, assets: 120n * S, min: 5, max: 20, rate: 300n }),
    ];
    const evaluations = evaluateRates(
      arks.map((ark) => ({
        vault: { getAddress: () => ark.id } as Vault,
        min: ark.min,
        max: ark.max,
        rate: ark.rate,
      })),
    );

    expect(evaluations.find((evaluation) => evaluation.address === ADDR_A)?.targets).toEqual([
      ADDR_B,
      ADDR_C,
    ]);

    _reallocateForRates(arks, evaluations, 1000n * S);

    expect(arks[0]!.assets).toBe(110n * S);
    expect(arks[1]!.assets).toBe(150n * S);
    expect(arks[2]!.assets).toBe(200n * S);
  });

  it('does nothing when evaluations have no targets', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n * S, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 150n * S, rate: 100n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    expect(arks[0]!.assets).toBe(150n * S);
    expect(arks[1]!.assets).toBe(150n * S);
  });

  it('skips target arks with bad debt', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 100n * S, min: 5, max: 20, rate: 200n, hasBadDebt: true }),
      makeArk({ id: ADDR_C, assets: 100n * S, min: 5, max: 20, rate: 300n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_C, ADDR_B] },
      { address: ADDR_B, targets: [] },
      { address: ADDR_C, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    // B has bad debt — skipped as target. A moves to C only.
    expect(arks[1]!.assets).toBe(100n * S); // B unchanged
    expect(arks[0]!.assets).toBe(50n * S); // A drained to min
    expect(arks[2]!.assets).toBe(200n * S); // C at max
  });

  it('skips move when amount is below MIN_MOVE_AMOUNT', () => {
    // A has 1*S above min, B has 1*S capacity — both below MIN_MOVE_AMOUNT
    const arks = [
      makeArk({ id: ADDR_A, assets: 51n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 199n * S, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    // A's available = 51*S - 50*S = 1*S, B's capacity = 200*S - 199*S = 1*S
    // Move amount = min(1*S, 1*S) = 1*S < MIN_MOVE_AMOUNT — skipped
    expect(arks[0]!.assets).toBe(51n * S);
    expect(arks[1]!.assets).toBe(199n * S);
  });

  it('limits target moves by the target ark supply cap', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n * S, min: 5, max: 20, rate: 100n }),
      makeArk({
        id: ADDR_B,
        assets: 100n * S,
        initialAssets: 100n * S,
        realInitialAssets: 100n * S,
        min: 5,
        max: 20,
        rate: 200n,
        supplyCap: 130n * S,
      }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    expect(arks[0]!.assets).toBe(170n * S);
    expect(arks[1]!.assets).toBe(130n * S);
  });
});

// ============= _validateAllocations =============

describe('_validateAllocations', () => {
  const totalAssets = 1000n * S;

  it('passes when all arks within range and buffer at target', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 100n * S, min: 5, max: 20 }),
      makeArk({ id: ADDR_B, assets: 150n * S, min: 5, max: 20 }),
    ];
    const buffer = makeBuffer({ assets: 400n * S, allocation: 40 });

    expect(_validateAllocations(arks, buffer, totalAssets)).toBeNull();
  });

  it('returns error when ark is below min and buffer is not at target', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 30n * S, min: 5, max: 20 }), // 30*S < 50*S (5%)
    ];
    const buffer = makeBuffer({ assets: 350n * S }); // below 40% target

    expect(_validateAllocations(arks, buffer, totalAssets)).toContain('below min');
  });

  it('allows ark below min when buffer is at target (buffer precedence)', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 30n * S, min: 5, max: 20 }), // below 5% min
    ];
    const buffer = makeBuffer({ assets: 400n * S }); // at 40% target

    expect(_validateAllocations(arks, buffer, totalAssets)).toBeNull();
  });

  it('returns error when planned supply pushes an ark above max', () => {
    const arks = [
      // starts at 50*S, plan supplies up to 250*S: 250*S > 200*S (20%)
      makeArk({ id: ADDR_A, assets: 250n * S, initialAssets: 50n * S, min: 5, max: 20 }),
    ];
    const buffer = makeBuffer({ assets: 400n * S });

    expect(_validateAllocations(arks, buffer, totalAssets)).toContain('above max');
  });

  it('does not flag a pre-existing over-max ark the plan did not supply into', () => {
    // An ark can drift over its max externally (interest accrual or a direct deposit).
    // The keeper cannot reduce an illiquid position here, so it must not wedge the whole
    // reallocation; only a plan that actively supplies past max is a validation failure.
    const arks = [
      makeArk({ id: ADDR_A, assets: 250n * S, initialAssets: 250n * S, min: 5, max: 20 }),
    ];
    const buffer = makeBuffer({ assets: 400n * S });

    expect(_validateAllocations(arks, buffer, totalAssets)).toBeNull();
  });

  it('returns error when planned supply exceeds the live supply cap', () => {
    const arks = [
      makeArk({
        id: ADDR_A,
        assets: 125n * S,
        initialAssets: 100n * S,
        realInitialAssets: 100n * S,
        supplyCap: 120n * S,
      }),
    ];
    const buffer = makeBuffer({ assets: 400n * S });

    expect(_validateAllocations(arks, buffer, totalAssets)).toContain('exceeds supply cap');
  });

  it('passes when arks at exact min and max boundaries', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 50n * S, min: 5, max: 20 }), // exactly at min
      makeArk({ id: ADDR_B, assets: 200n * S, min: 5, max: 20 }), // exactly at max
    ];
    const buffer = makeBuffer({ assets: 400n * S });

    expect(_validateAllocations(arks, buffer, totalAssets)).toBeNull();
  });

  it('returns the exact buffer-target mismatch error when not all arks are at max', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 100n * S, min: 5, max: 20 })];
    const buffer = makeBuffer({ assets: 350n * S, allocation: 40 }); // 350*S !== 400*S

    expect(_validateAllocations(arks, buffer, totalAssets)).toBe(
      `Buffer allocation ${350n * S} does not equal target ${400n * S}`,
    );
  });

  it('passes when all arks at max and buffer above target', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n * S, min: 5, max: 20 }),
      makeArk({ id: ADDR_B, assets: 200n * S, min: 5, max: 20 }),
    ];
    const buffer = makeBuffer({ assets: 500n * S, allocation: 40 }); // 500*S > 400*S

    expect(_validateAllocations(arks, buffer, totalAssets)).toBeNull();
  });

  it('passes when all arks at max and buffer exactly at target', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 200n * S, min: 5, max: 20 })];
    const buffer = makeBuffer({ assets: 400n * S, allocation: 40 });

    expect(_validateAllocations(arks, buffer, totalAssets)).toBeNull();
  });

  it('returns error when all arks at max but buffer below target', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n * S, min: 5, max: 20 }),
      makeArk({ id: ADDR_B, assets: 200n * S, min: 5, max: 20 }),
    ];
    const buffer = makeBuffer({ assets: 350n * S, allocation: 40 }); // 350*S < 400*S

    expect(_validateAllocations(arks, buffer, totalAssets)).toContain('below target');
  });
});

// ============= _buildFinalAllocations =============

describe('_buildFinalAllocations', () => {
  it('returns empty array when no allocations changed', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 100n * S, initialAssets: 100n * S }),
      makeArk({ id: ADDR_B, assets: 200n * S, initialAssets: 200n * S }),
    ];
    const buffer = makeBuffer({ assets: 400n * S, initialAssets: 400n * S });

    const result = _buildFinalAllocations(arks, buffer);
    expect(result).toEqual([]);
  });

  it('places decreasing allocations before increasing', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n * S, initialAssets: 300n * S }), // decreasing
      makeArk({ id: ADDR_B, assets: 200n * S, initialAssets: 100n * S }), // increasing
    ];
    const buffer = makeBuffer({ assets: 400n * S, initialAssets: 400n * S });

    const result = _buildFinalAllocations(arks, buffer) as MarketAllocation[];

    expect(result[0]!.id).toBe(ADDR_A); // decreasing first
    expect(result[0]!.assets).toBe(200n * S + accrualPad(300n * S, 100n * S));
    expect(result[1]!.id).toBe(ADDR_B); // increasing last
  });

  it('sets maxUint256 on the last increasing allocation', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n * S, initialAssets: 300n * S }),
      makeArk({ id: ADDR_B, assets: 200n * S, initialAssets: 100n * S }),
    ];
    const buffer = makeBuffer({ assets: 400n * S, initialAssets: 400n * S });

    const result = _buildFinalAllocations(arks, buffer) as MarketAllocation[];

    expect(result[result.length - 1]!.assets).toBe(maxUint256);
  });

  it('caps exact increasing legs to the effective padded withdrawal', () => {
    const arks = [
      makeArk({
        id: ADDR_A,
        assets: 80n * S,
        initialAssets: 100n * S,
        realInitialAssets: 20_000n * S,
      }),
      makeArk({ id: ADDR_B, assets: 115n * S, initialAssets: 100n * S }),
      makeArk({ id: ADDR_C, assets: 105n * S, initialAssets: 100n * S }),
    ];
    const buffer = makeBuffer({ assets: 400n * S, initialAssets: 400n * S });

    const result = _buildFinalAllocations(arks, buffer) as MarketAllocation[];

    expect(result).toEqual([
      { id: ADDR_A, assets: 19_990n * S },
      { id: ADDR_B, assets: 110n * S },
      { id: ADDR_C, assets: maxUint256 },
    ]);
    expect(
      simulateEulerAccounting(result, [
        ...arks.map((ark) => ({ id: ark.id, realInitialAssets: ark.realInitialAssets })),
        { id: buffer.id, realInitialAssets: buffer.realInitialAssets },
      ]),
    ).toEqual({ totalWithdrawn: 10n * S, totalSupplied: 10n * S });
  });

  it('handles multiple decreasing and multiple increasing entries', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 80n * S, initialAssets: 150n * S }), // decreasing (-70)
      makeArk({ id: ADDR_B, assets: 250n * S, initialAssets: 200n * S }), // increasing (+50)
      makeArk({ id: ADDR_C, assets: 230n * S, initialAssets: 160n * S }), // increasing (+70)
    ];
    const buffer = makeBuffer({ assets: 350n * S, initialAssets: 400n * S }); // decreasing (-50)

    // totalWithdrawn = 70 + 50 = 120, totalSupplied = 50 + 70 = 120
    const result = _buildFinalAllocations(arks, buffer) as MarketAllocation[];

    const decreasingIds = result.slice(0, 2).map((a) => a.id);
    expect(decreasingIds).toContain(ADDR_A);
    expect(decreasingIds).toContain(ADDR_BUF);

    // Increasing: B, C — last two, final one has maxUint256
    expect(result.length).toBe(4);
    expect(result[3]!.assets).toBe(maxUint256);
  });

  it('excludes unchanged allocations', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 100n * S, initialAssets: 100n * S }), // unchanged
      makeArk({ id: ADDR_B, assets: 350n * S, initialAssets: 200n * S }), // increasing
    ];
    const buffer = makeBuffer({ assets: 350n * S, initialAssets: 500n * S }); // decreasing

    // sum(dec assets) = 350*S, sum(inc assets) = 350*S
    const result = _buildFinalAllocations(arks, buffer) as MarketAllocation[];

    expect(result.length).toBe(2);
    expect(result[0]!.id).toBe(ADDR_BUF); // decreasing
    expect(result[0]!.assets).toBe(350n * S + accrualPad(500n * S, 150n * S));
    expect(result[1]!.id).toBe(ADDR_B); // increasing (maxUint256)
    expect(result[1]!.assets).toBe(maxUint256);
  });

  it('returns error when only decreasing entries exist with no increasing', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 80n * S, initialAssets: 100n * S })];
    const buffer = makeBuffer({ assets: 380n * S, initialAssets: 400n * S });

    expect(_buildFinalAllocations(arks, buffer)).toContain('inconsistent reallocation');
  });

  it('returns error when only increasing entries exist with no decreasing', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 120n * S, initialAssets: 100n * S })];
    const buffer = makeBuffer({ assets: 420n * S, initialAssets: 400n * S });

    expect(_buildFinalAllocations(arks, buffer)).toContain('inconsistent reallocation');
  });

  it('returns error when increasing and decreasing deltas are mismatched', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 80n * S, initialAssets: 100n * S }), // withdrawn: 20
    ];
    const buffer = makeBuffer({ assets: 450n * S, initialAssets: 400n * S }); // supplied: 50

    // totalWithdrawn = 20, totalSupplied = 50 — not equal
    expect(_buildFinalAllocations(arks, buffer)).toContain('inconsistent reallocation');
  });

  it('buffer can be the last increasing entry and receive maxUint256', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 350n * S, initialAssets: 500n * S }), // decreasing
    ];
    const buffer = makeBuffer({ assets: 350n * S, initialAssets: 200n * S }); // increasing

    // sum(dec assets) = 350*S, sum(inc assets) = 350*S
    const result = _buildFinalAllocations(arks, buffer) as MarketAllocation[];

    expect(result[0]!.id).toBe(ADDR_A);
    expect(result[0]!.assets).toBe(350n * S + accrualPad(500n * S, 150n * S));
    expect(result[1]!.id).toBe(ADDR_BUF);
    expect(result[1]!.assets).toBe(maxUint256);
  });

  // Regression: when an ARK's real Euler supply exceeds its capped initialAssets (illiquid pool),
  // the submitted target must anchor to realInitialAssets, not the working assets value. Sending
  // the raw `assets` would cause Euler to attempt withdrawing the entire illiquid portion.
  it('anchors decreasing targets to realInitialAssets when an ARK is pool-capped', () => {
    const arks = [
      makeArk({
        id: ADDR_A,
        assets: 80n * S,
        initialAssets: 100n * S, // capped liquid balance
        realInitialAssets: 1000n * S, // real Euler supply
      }),
    ];
    const buffer = makeBuffer({
      assets: 420n * S,
      initialAssets: 400n * S,
      realInitialAssets: 400n * S,
    });

    const result = _buildFinalAllocations(arks, buffer) as MarketAllocation[];

    expect(result).toHaveLength(2);
    // realInit (1000) − decrease (20) + clamped accrualPad(1000, 20)
    expect(result[0]).toEqual({ id: ADDR_A, assets: 980n * S + accrualPad(1000n * S, 20n * S) });
    expect(result[1]).toEqual({ id: ADDR_BUF, assets: maxUint256 });
  });

  it('anchors increasing targets to realInitialAssets when paired with a pool-capped decrease', () => {
    const arks = [
      makeArk({
        id: ADDR_A,
        assets: 80n * S,
        initialAssets: 100n * S,
        realInitialAssets: 1000n * S, // illiquid
      }),
      makeArk({
        id: ADDR_B,
        assets: 240n * S,
        initialAssets: 220n * S,
        realInitialAssets: 220n * S, // fully liquid
      }),
    ];
    const buffer = makeBuffer({
      assets: 400n * S,
      initialAssets: 400n * S,
      realInitialAssets: 400n * S,
    });

    const result = _buildFinalAllocations(arks, buffer) as MarketAllocation[];

    // Decreasing ARK_A: 1000 − 20 + clamped accrualPad(1000, 20) for accrual safety.
    // Increasing ARK_B as last entry → maxUint256.
    expect(result).toEqual([
      { id: ADDR_A, assets: 980n * S + accrualPad(1000n * S, 20n * S) },
      { id: ADDR_B, assets: maxUint256 },
    ]);
  });

  // Regression: realInitialAssets can shrink between snapshot and refresh (a co-allocator moved
  // capital out, share dilution, strategy disabled). Without the guard, the subtraction in
  // finalTarget throws an uncaught BigInt underflow and bypasses RunAbortError, leaving any
  // already-executed drains stranded.
  it('returns an abort string when refreshed realInitialAssets is below the planned decrease', () => {
    const arks = [
      makeArk({
        id: ADDR_A,
        assets: 80n * S,
        initialAssets: 200n * S, // planner planned to decrease A by 120*S
        realInitialAssets: 50n * S, // refresh showed less than the planned decrease
      }),
    ];
    const buffer = makeBuffer({
      assets: 520n * S,
      initialAssets: 400n * S,
      realInitialAssets: 400n * S,
    });

    const result = _buildFinalAllocations(arks, buffer);

    expect(typeof result).toBe('string');
    expect(result).toContain('below planned decrease');
    expect(result).toContain(ADDR_A);
  });

  it('returns an abort string when the accrual pad absorbs every planned withdrawal', () => {
    const arks = [
      makeArk({
        id: ADDR_A,
        assets: 80n * S,
        initialAssets: 100n * S,
        realInitialAssets: 100_000n * S,
      }),
    ];
    const buffer = makeBuffer({
      assets: 420n * S,
      initialAssets: 400n * S,
      realInitialAssets: 400n * S,
    });

    const result = _buildFinalAllocations(arks, buffer);

    expect(typeof result).toBe('string');
    expect(result).toContain('accrual pad absorbs planned withdrawals');
  });

  it('returns an abort string when refreshed balances leave insufficient supply cap', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 80n * S, initialAssets: 100n * S }),
      makeArk({
        id: ADDR_B,
        assets: 120n * S,
        initialAssets: 100n * S,
        realInitialAssets: 115n * S,
        supplyCap: 118n * S,
      }),
    ];
    const buffer = makeBuffer({ assets: 400n * S, initialAssets: 400n * S });

    const result = _buildFinalAllocations(arks, buffer);

    expect(typeof result).toBe('string');
    expect(result).toContain('supply cap exceeded');
    expect(result).toContain(ADDR_B);
  });

  it('preserves the totalWithdrawn = totalSupplied invariant when targets shift to real domain', () => {
    // Use realInitialAssets ≠ initialAssets for the decreasing ARK to ensure the invariant check
    // operates in the planner's domain (deltas) rather than the real-domain finalTargets.
    const arks = [
      makeArk({
        id: ADDR_A,
        assets: 80n * S,
        initialAssets: 100n * S,
        realInitialAssets: 1000n * S,
      }),
    ];
    const buffer = makeBuffer({
      assets: 420n * S,
      initialAssets: 400n * S,
      realInitialAssets: 400n * S,
    });

    // delta_A = −20, delta_buffer = +20 → invariant holds even though A's finalTarget jumps to 980.
    expect(_buildFinalAllocations(arks, buffer)).not.toEqual(
      expect.stringContaining('inconsistent reallocation'),
    );
  });
});
