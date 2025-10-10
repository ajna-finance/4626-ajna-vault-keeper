import { contract } from '../utils/contract';

const pool = contract('pool');

export const getBucketInfo = (index: bigint) => pool().read.bucketInfo([index]);

export const getBankruptcyTime = async (index: bigint) => {
  const bucketInfo = await getBucketInfo(index);
  return await bucketInfo[2];
};

export const getBucketLps = async (index: bigint) => {
  const bucketInfo = await getBucketInfo(index);
  return await bucketInfo[0];
};

export const updateInterest = () => pool().write.updateInterest();
