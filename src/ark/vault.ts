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

    // vaultAuth
    getBufferRatio: () => vaultAuth().read.bufferRatio(),
    getMinBucketIndex: () => vaultAuth().read.minBucketIndex(),

    // poolInfoUtils
    getPriceToIndex: async (price: bigint) => (await getPoolInfoUtils()).read.priceToIndex([price]),
    getIndexToPrice: async (index: bigint) => (await getPoolInfoUtils()).read.indexToPrice([index]),
    getHtp: async () => (await getPoolInfoUtils()).read.htp([await getPoolAddr()]),
    getLup: async () => (await getPoolInfoUtils()).read.lup([await getPoolAddr()]),
    getAuctionStatus: async (borrower: Address) =>
      (await getPoolInfoUtils()).read.auctionStatus(await getPoolAddr(), borrower),
    getBorrowFeeRate: async () =>
      (await getPoolInfoUtils()).read.borrowFeeRate(await getPoolAddr()),

    // pool
    getBucketInfo: async (index: bigint) => (await getPool()).read.bucketInfo([index]),
    getBankruptcyTime: async (index: bigint) => {
      const bucketInfo = await (await getPool()).read.bucketInfo([index]);
      return (bucketInfo as any)[2];
    },
    getBucketLps: async (index: bigint) => {
      const bucketInfo = await (await getPool()).read.bucketInfo([index]);
      return (bucketInfo as any)[0];
    },
    getVaultBucketLps: async (index: bigint) => {
      const lenderInfo = await (await getPool()).read.lenderInfo([index, address]);
      return BigInt((lenderInfo as any)[0]);
    },
    getBucketQuoteDeposit: async (index: bigint) => {
      const bucketInfo = await (await getPool()).read.bucketInfo([index]);
      return BigInt((bucketInfo as any)[3]);
    },
    getAuthAddress: () => vault().read.AUTH() as Promise<Address>,
    getCollateralAddress: async () =>
      (await getPool()).read.collateralAddress() as Promise<Address>,
    getPoolEscrowedQuote: async () => {
      const reservesInfo = await (await getPool()).read.reservesInfo();
      return BigInt((reservesInfo as any)[0]) + BigInt((reservesInfo as any)[1]);
    },
    getTotalAuctionsInPool: async () => BigInt(await (await getPool()).read.totalAuctionsInPool()),
    getAuctionNext: async (borrower: Address) => {
      const auctionInfo = await (await getPool()).read.auctionInfo([borrower]);
      return {
        head: (auctionInfo as any)[7] as Address,
        next: (auctionInfo as any)[8] as Address,
        kickTime: BigInt((auctionInfo as any)[3]),
      };
    },
    updateInterest: async (gas: bigint) => (await getPool()).write.updateInterest({ gas }),
    getTotalT0DebtInAuction: async () => (await getPool()).read.totalT0DebtInAuction(),
    getInflatorInfo: async () => (await getPool()).read.inflatorInfo(),
    getDepositIndex: async (debt: bigint) => (await getPool()).read.depositIndex(debt),
    getAuctionDebtLockedIndex: async (): Promise<bigint | null> => {
      const t0DebtInAuction = (await (await getPool()).read.totalT0DebtInAuction()) as bigint;
      if (t0DebtInAuction === 0n) return null;
      const inflatorInfo = await (await getPool()).read.inflatorInfo();
      const wad = 10n ** 18n;
      const debt = (t0DebtInAuction * (inflatorInfo as any)[0] + wad / 2n) / wad;
      return BigInt(await (await getPool()).read.depositIndex(debt));
    },
    isBucketDebtLocked: async function (index: bigint): Promise<boolean> {
      const lockedIndex = await this.getAuctionDebtLockedIndex();
      return lockedIndex !== null && index <= lockedIndex;
    },
  };
}
