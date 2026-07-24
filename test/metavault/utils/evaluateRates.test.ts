import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { evaluateRates } from '../../../src/metavault/utils/evaluateRates';
import { type Ark } from '../../../src/metavault/planner';
import { type Address } from 'viem';
import { type createVault } from '../../../src/ark/vault';

const configMock = { minRateDiff: 10 };

vi.mock('../../../src/utils/config', () => ({
  get config() {
    return configMock;
  },
}));

const ADDR_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as Address;
const ADDR_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as Address;
const ADDR_C = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' as Address;

function makeArk(address: Address, rate: bigint): Ark {
  return {
    vault: { getAddress: () => address } as ReturnType<typeof createVault>,
    min: undefined,
    max: undefined,
    rate,
  };
}

describe('evaluateRates', () => {
  it('returns empty array for no arks', () => {
    expect(evaluateRates([])).toEqual([]);
  });

  it('returns no targets for a single ark', () => {
    const result = evaluateRates([makeArk(ADDR_A, 100n)]);
    expect(result[0]!.targets).toEqual([]);
  });

  it('returns no targets when rates are equal', () => {
    const result = evaluateRates([makeArk(ADDR_A, 100n), makeArk(ADDR_B, 100n)]);
    expect(result[0]!.targets).toEqual([]);
    expect(result[1]!.targets).toEqual([]);
  });

  it('returns no targets when rate difference is below minRateDiff', () => {
    // B is 9% higher than A — below the 10% threshold
    const result = evaluateRates([makeArk(ADDR_A, 100n), makeArk(ADDR_B, 109n)]);
    expect(result[0]!.targets).toEqual([]);
  });

  it('identifies a target when rate difference exactly meets minRateDiff', () => {
    // B is exactly 10% higher than A
    const result = evaluateRates([makeArk(ADDR_A, 100n), makeArk(ADDR_B, 110n)]);
    expect(result[0]!.targets).toEqual([ADDR_B]);
  });

  it('identifies a target when rate difference exceeds minRateDiff', () => {
    const result = evaluateRates([makeArk(ADDR_A, 100n), makeArk(ADDR_B, 120n)]);
    expect(result[0]!.targets).toEqual([ADDR_B]);
    expect(result[1]!.targets).toEqual([]);
  });

  it('does not consider an ark a target for itself', () => {
    const result = evaluateRates([makeArk(ADDR_A, 100n), makeArk(ADDR_B, 120n)]);
    expect(result[1]!.targets).not.toContain(ADDR_B);
  });

  it('sorts multiple targets by rate descending', () => {
    // B is 30% higher than A, C is 15% higher — both exceed threshold, B should be first
    const result = evaluateRates([
      makeArk(ADDR_A, 100n),
      makeArk(ADDR_B, 130n),
      makeArk(ADDR_C, 115n),
    ]);
    expect(result[0]!.targets).toEqual([ADDR_B, ADDR_C]);
  });

  it('allows the same target to appear for multiple origins', () => {
    // Both A and B are more than 10% below C
    const result = evaluateRates([
      makeArk(ADDR_A, 100n),
      makeArk(ADDR_B, 105n),
      makeArk(ADDR_C, 130n),
    ]);
    expect(result[0]!.targets).toContain(ADDR_C);
    expect(result[1]!.targets).toContain(ADDR_C);
  });

  it('assigns the correct address to each evaluation', () => {
    const result = evaluateRates([makeArk(ADDR_A, 100n), makeArk(ADDR_B, 100n)]);
    expect(result[0]!.address).toBe(ADDR_A);
    expect(result[1]!.address).toBe(ADDR_B);
  });

  it('returns no targets when all rates are zero', () => {
    const result = evaluateRates([makeArk(ADDR_A, 0n), makeArk(ADDR_B, 0n), makeArk(ADDR_C, 0n)]);
    expect(result[0]!.targets).toEqual([]);
    expect(result[1]!.targets).toEqual([]);
    expect(result[2]!.targets).toEqual([]);
  });

  it('returns no targets for zero-rate origin against another zero-rate ark', () => {
    const result = evaluateRates([makeArk(ADDR_A, 0n), makeArk(ADDR_B, 0n)]);
    expect(result[0]!.targets).toEqual([]);
    expect(result[1]!.targets).toEqual([]);
  });

  it('still identifies a positive-rate target for a zero-rate origin', () => {
    const result = evaluateRates([makeArk(ADDR_A, 0n), makeArk(ADDR_B, 100n)]);
    expect(result[0]!.targets).toEqual([ADDR_B]);
    expect(result[1]!.targets).toEqual([]);
  });

  describe('with minRateDiff = 0', () => {
    const originalMinRateDiff = configMock.minRateDiff;

    beforeEach(() => {
      configMock.minRateDiff = 0;
    });

    afterEach(() => {
      configMock.minRateDiff = originalMinRateDiff;
    });

    it('returns no targets when equal-rate peers would otherwise tie', () => {
      const result = evaluateRates([makeArk(ADDR_A, 100n), makeArk(ADDR_B, 100n)]);
      expect(result[0]!.targets).toEqual([]);
      expect(result[1]!.targets).toEqual([]);
    });

    it('returns no targets when all rates are zero', () => {
      const result = evaluateRates([makeArk(ADDR_A, 0n), makeArk(ADDR_B, 0n)]);
      expect(result[0]!.targets).toEqual([]);
      expect(result[1]!.targets).toEqual([]);
    });

    it('identifies any strictly higher target', () => {
      const result = evaluateRates([makeArk(ADDR_A, 100n), makeArk(ADDR_B, 101n)]);
      expect(result[0]!.targets).toEqual([ADDR_B]);
      expect(result[1]!.targets).toEqual([]);
    });
  });
});
