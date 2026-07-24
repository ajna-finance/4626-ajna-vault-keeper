import { contract } from '../utils/contract.ts';
import { type Address } from 'viem';
import { type MarketAllocation } from './planner.ts';

export type { MarketAllocation } from './planner.ts';

const metavault = contract('metavault');

export const getExpectedSupplyAssets = async (id: Address) => {
  const config = await getConfig(id);
  if (config.balance === 0n) return 0n;
  return metavault().read.expectedSupplyAssets(id);
};

export const getTotalExpectedSupplyAssets = async (ids: Address[]) => {
  let totalAssets = 0n;

  for (let i = 0; i < ids.length; i++) {
    const assets = await getExpectedSupplyAssets(ids[i] as Address);
    totalAssets += assets;
  }

  return totalAssets;
};

export const getConfig = (id: Address) => metavault().read.config(id);

export const getSupplyCap = async (id: Address) => {
  const config = await getConfig(id);
  return config.cap;
};

export const reallocate = (allocations: MarketAllocation[], gas: bigint) =>
  metavault().write.reallocate([allocations], { gas });
