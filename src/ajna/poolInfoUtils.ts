import { getPoolAddress } from '../vault/vault';
import { contract } from '../utils/contract';
import type { Address } from 'viem';

const poolInfoUtils = contract('poolInfoUtils');

export const getPriceToIndex = (price: bigint) => poolInfoUtils().read.priceToIndex([price]);

export const getIndexToPrice = (index: bigint) => poolInfoUtils().read.indexToPrice([index]);

export const getHtp = async () => {
  const poolAddress = await getPoolAddress();
  return poolInfoUtils().read.htp([poolAddress]);
};

export const getLup = async () => {
  const poolAddress = await getPoolAddress();
  return poolInfoUtils().read.lup([poolAddress]);
};

export const getAuctionStatus = async (borrower: Address) => {
  const poolAddress = await getPoolAddress();
  return poolInfoUtils().read.auctionStatus(poolAddress, borrower);
};
