import { config } from '../../utils/config.ts';
import { type Ark } from '../planner.ts';
import { type Address } from 'viem';

export type ArkEvaluation = {
  address: Address;
  targets: Address[];
};

export function evaluateRates(arks: Ark[]): ArkEvaluation[] {
  return arks.map((ark) => {
    const targets = arks
      .filter((other) => other !== ark && _rateExceedsMin(other.rate, ark.rate))
      .sort((a, b) => (a.rate > b.rate ? -1 : 1))
      .map((other) => other.vault.getAddress())
      .filter((address): address is Address => address !== undefined);

    return {
      address: ark.vault.getAddress() as Address,
      targets,
    };
  });
}

function _rateExceedsMin(targetRate: bigint, originRate: bigint): boolean {
  if (targetRate <= originRate) return false;
  return targetRate * 100n >= originRate * BigInt(100 + config.minRateDiff);
}
