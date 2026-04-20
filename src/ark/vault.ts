/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Address } from 'viem';
import { contract } from '../utils/contract.ts';

const buffer = (bufferAddress: Address) => contract('buffer', bufferAddress);

export function createVault(address: Address, vaultAuthAddress?: Address) {
  const vault = contract('vault', address);
  const vaultAuth = vaultAuthAddress
    ? contract('vaultAuth', vaultAuthAddress)
    : contract('vaultAuth', address);

  let _poolInfoUtilsFn: (() => any) | undefined;
  let _poolFn: (() => any) | undefined;
  let _poolAddr: Address | undefined;

  const getPoolInfoUtils = async () => {
    if (!_poolInfoUtilsFn) {
      const addr = (await vault().read.info()) as Address;
      _poolInfoUtilsFn = contract('poolInfoUtils', addr);
    }
    return _poolInfoUtilsFn();
  };

  const getPool = async () => {
    if (!_poolFn) {
      _poolAddr = (await vault().read.pool()) as Address;
      _poolFn = contract('pool', _poolAddr);
    }
    return _poolFn();
  };

  const getPoolAddr = async (): Promise<Address> => {
    if (!_poolAddr) await getPool();
    return _poolAddr!;
  };

  return {
    // vault
    getAddress: () => address,
    getBuckets: () => vault().read.getBuckets(),
    getAssetDecimals: () => vault().read.assetDecimals(),
    getTotalAssets: () => vault().read.totalAssets(),
    getTotalSupply: async () => BigInt(await vault().read.totalSupply()),
    getBalanceOf: async (account: Address) => BigInt(await vault().read.balanceOf([account])),
    convertToAssets: async (shares: bigint) => BigInt(await vault().read.convertToAssets([shares])),
    getPoolInfoUtilsAddress: () => vault().read.info(),
    getBufferAddress: () => vault().read.buffer(),
    getPoolAddress: getPoolAddr,
    isPaused: () => vault().read.paused(),
    getBufferTotal: async () => {
      const bufferAddress = (await vault().read.buffer()) as Address;
      return buffer(bufferAddress)().read.total();
    },
    lpToValue: async (bucket: bigint) => BigInt(await vault().read.lpToValue(bucket)),
    getDustThreshold: async function () {
      const assetDecimals = await this.getAssetDecimals();
      const sixDecimalThreshold = 10n ** 6n + 1n;
      const otherDecimalThreshold = 10n ** 18n / 10n ** BigInt(assetDecimals);
      return sixDecimalThreshold > otherDecimalThreshold
        ? sixDecimalThreshold
        : otherDecimalThreshold;
    },
    move: (from: bigint, to: bigint, amount: bigint, gas: bigint) =>
      vault().write.move([from, to, amount], { gas }),
    moveFromBuffer: (to: bigint, amount: bigint, gas: bigint) =>
      vault().write.moveFromBuffer([to, amount], { gas }),
    moveToBuffer: (from: bigint, amount: bigint, gas: bigint) =>
      vault().write.moveToBuffer([from, amount], { gas }),
    drain: (index: bigint) => vault().write.drain(index),

    // vault — recovery
    recoverCollateral: (indexes: bigint[], amts: bigint[], gas: bigint) =>
      vault().write.recoverCollateral([indexes, amts], { gas }),
    returnQuoteToken: (toIndex: bigint, amt: bigint, gas: bigint) =>
      vault().write.returnQuoteToken([toIndex, amt], { gas }),
    getRemovedCollateralValue: async (): Promise<bigint> =>
      BigInt((await vault().read.removedCollateralValue()) as any),
    getLpDust: async (): Promise<bigint> => BigInt((await vault().read.LP_DUST()) as any),
    getAuthAddress: async (): Promise<Address> => (await vault().read.AUTH()) as Address,

    // vaultAuth
    getBufferRatio: () => vaultAuth().read.bufferRatio(),
    getMinBucketIndex: () => vaultAuth().read.minBucketIndex(),
    getSwapper: async (): Promise<Address> => (await vaultAuth().read.swapper()) as Address,
    isAuthPaused: async (): Promise<boolean> => (await vaultAuth().read.paused()) as boolean,

    // poolInfoUtils
    getPriceToIndex: async (price: bigint) => (await getPoolInfoUtils()).read.priceToIndex([price]),
    getIndexToPrice: async (index: bigint) => (await getPoolInfoUtils()).read.indexToPrice([index]),
    getHtp: async () => (await getPoolInfoUtils()).read.htp([await getPoolAddr()]),
    getLup: async () => (await getPoolInfoUtils()).read.lup([await getPoolAddr()]),
    getAuctionStatus: async (borrower: Address) =>
      (await getPoolInfoUtils()).read.auctionStatus(await getPoolAddr(), borrower),
    getBorrowFeeRate: async () =>
      (await getPoolInfoUtils()).read.borrowFeeRate(await getPoolAddr()),
    lpToCollateral: async (bucket: bigint, lps: bigint): Promise<bigint> =>
      BigInt(
        (await (await getPoolInfoUtils()).read.lpToCollateral([await getPoolAddr(), lps, bucket])) as any,
      ),
    lpToQuoteTokens: async (bucket: bigint, lps: bigint): Promise<bigint> =>
      BigInt(
        (await (await getPoolInfoUtils()).read.lpToQuoteTokens([await getPoolAddr(), lps, bucket])) as any,
      ),

    // pool
    getBucketInfo: async (index: bigint) => (await getPool()).read.bucketInfo([index]),
    getCollateralAddress: async (): Promise<Address> =>
      (await (await getPool()).read.collateralAddress()) as Address,
    getVaultLps: async (bucket: bigint): Promise<bigint> => {
      const info = await (await getPool()).read.lenderInfo([bucket, address]);
      return BigInt((info as any)[0]);
    },
    getBankruptcyTime: async (index: bigint) => {
      const bucketInfo = await (await getPool()).read.bucketInfo([index]);
      return (bucketInfo as any)[2];
    },
    getBucketLps: async (index: bigint) => {
      const bucketInfo = await (await getPool()).read.bucketInfo([index]);
      return (bucketInfo as any)[0];
    },
    updateInterest: async (gas: bigint) => (await getPool()).write.updateInterest({ gas }),
    getTotalT0DebtInAuction: async () => (await getPool()).read.totalT0DebtInAuction(),
    getInflatorInfo: async () => (await getPool()).read.inflatorInfo(),
    getDepositIndex: async (debt: bigint) => (await getPool()).read.depositIndex(debt),
    isBucketDebtLocked: async (index: bigint): Promise<boolean> => {
      const t0DebtInAuction = (await (await getPool()).read.totalT0DebtInAuction()) as bigint;
      if (t0DebtInAuction === 0n) return false;
      const inflatorInfo = await (await getPool()).read.inflatorInfo();
      const wad = 10n ** 18n;
      const debt = (t0DebtInAuction * (inflatorInfo as any)[0] + wad / 2n) / wad;
      const indexOfSum = (await (await getPool()).read.depositIndex(debt)) as bigint;
      return index <= indexOfSum;
    },
  };
}
