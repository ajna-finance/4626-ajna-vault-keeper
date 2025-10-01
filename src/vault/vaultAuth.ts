import { contract } from '../utils/contract.ts';

const vaultAuth = contract('vaultAuth');

export const getBufferRatio = () => vaultAuth().read.bufferRatio();

export const getMinBucketIndex = () => vaultAuth().read.minBucketIndex();
