import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('../../../src/utils/config', () => ({
  config: { minRateDiff: 10 },
}));

import { evaluateRates } from '../../../src/metavault/utils/evaluateRates';
import { type Ark } from '../../../src/metavault/planner';
import { type Address } from 'viem';
import { type createVault } from '../../../src/ark/vault';

function addressAt(index: number): Address {
  return `0x${(index + 1).toString(16).padStart(40, '0')}` as Address;
}

function makeArk(address: Address, rate: bigint): Ark {
  return {
    vault: { getAddress: () => address } as ReturnType<typeof createVault>,
    min: undefined,
    max: undefined,
    rate,
  };
}

describe('evaluateRates property tests', () => {
  it('always produces the correct target set without self-targeting and with descending rates', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 10_000n }), { minLength: 1, maxLength: 8 }),
        (rates) => {
          const arks = rates.map((rate, index) => makeArk(addressAt(index), rate));
          const evaluations = evaluateRates(arks);

          expect(evaluations).toHaveLength(arks.length);

          for (let i = 0; i < arks.length; i++) {
            const ark = arks[i]!;
            const evaluation = evaluations[i]!;
            const expectedTargets = arks
              .filter(
                (other) =>
                  other.vault.getAddress() !== ark.vault.getAddress() &&
                  other.rate > ark.rate &&
                  other.rate * 100n >= ark.rate * 110n,
              )
              .map((other) => other.vault.getAddress());
            const targetRates = evaluation.targets.map(
              (target) =>
                arks.find((arkCandidate) => arkCandidate.vault.getAddress() === target)!.rate,
            );

            expect(evaluation.address).toBe(ark.vault.getAddress());
            expect(new Set(evaluation.targets).size).toBe(evaluation.targets.length);
            expect(evaluation.targets).not.toContain(ark.vault.getAddress());
            expect(new Set(evaluation.targets)).toEqual(new Set(expectedTargets));

            for (let j = 1; j < targetRates.length; j++) {
              expect(targetRates[j - 1]!).toBeGreaterThanOrEqual(targetRates[j]!);
            }
          }
        },
      ),
      { numRuns: 250 },
    );
  });
});
