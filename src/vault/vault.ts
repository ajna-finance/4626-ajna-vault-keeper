import { contract } from '../utils/contract';

const vault = contract('vault');

export const getBuckets = () => vault().read.getBuckets();

export const getAssetDecimals = () => vault().read.assetDecimals();

export const getTotalAssets = () => vault().read.totalAssets();

export const getPoolInfoUtilsAddress = () => vault().read.INFO();

export const getBufferAddress = () => vault().read.BUFFER();

export const getPoolAddress = () => vault().read.POOL();

export const isPaused = () => vault().read.paused();

export const getLps = (bucket: bigint) => vault().read.lpToValue(bucket);

export const getDustThreshold = async () => {
  const assetDecimals = await getAssetDecimals();
  const sixDecimalThreshold = 10n ** 6n + 1n;
  const otherDecimalThreshold = 10n ** 18n / 10n ** BigInt(assetDecimals);
  return sixDecimalThreshold > otherDecimalThreshold ? sixDecimalThreshold : otherDecimalThreshold;
};

export const move = (from: bigint, to: bigint, amount: bigint) =>
  vault().write.move([from, to, amount]);

export const moveFromBuffer = (to: bigint, amount: bigint) =>
  vault().write.moveFromBuffer([to, amount]);

export const moveToBuffer = (from: bigint, amount: bigint) =>
  vault().write.moveToBuffer([from, amount]);

export const drain = (index: bigint) => vault().write.drain(index);
