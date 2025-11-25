import { contract } from '../../src/utils/contract.ts';
import type { Address } from 'viem';

const vaultAuth = contract('vaultAuth');
const chronicle = contract('chronicle');
const poolInfoUtils = contract('poolInfoUtils');
const vault = contract('vault');
const pool = contract('pool');

export const setBufferRatio = (ratio: bigint) => vaultAuth().write.setBufferRatio([ratio]);
export const setMinBucketIndex = (index: bigint) => vaultAuth().write.setMinBucketIndex([index]);

export const setPaused = (status: boolean) => vault().write.setPaused(status);

const _setPrice = (price: bigint) => chronicle().write.setPrice(price);

export const setBankruptcyTime = (timestamp: bigint) => pool().write.setBankruptcyTime(timestamp);
export const setLps = (lps: bigint) => pool().write.setLps(lps);

export const setAuctionStatus = (
  borrower: Address,
  kickTime: bigint,
  collateral: bigint,
  debt: bigint,
) => poolInfoUtils().write.setAuctionStatus(borrower, kickTime, collateral, debt);
const _setLup = (lup: bigint) => poolInfoUtils().write.setLup(lup);
const _setHtp = (htp: bigint) => poolInfoUtils().write.setHtp(htp);

const _addBucket = (index: bigint, price: bigint, amount: bigint) =>
  vault().write.addBucket(index, price, amount);

export function useMocks() {
  process.env.USE_MOCKS = 'true';
}

export function useRealContracts() {
  process.env.USE_MOCKS = 'false';
}

export async function setMockState() {
  await _setPrice(999870478245824934n);
  await _setLup(995024875621890556n);
  await _setHtp(976471570782600768n);
  await _createAndFundBuckets();
}

async function _createAndFundBuckets() {
  const amount = 100000000000000000000n;
  const buckets = [
    [4166n, 951347940696068854n],
    [4165n, 956104680399549190n],
    [4164n, 960885203801546928n],
    [4163n, 965689629820554655n],
    [4162n, 970518077969657420n],
    [4161n, 975370668359505700n],
    [4160n, 980247521701303221n],
    [4159n, 985148759309809729n],
    [4158n, 990074503106358770n],
    [4157n, 995024875621890556n],
    [4156n, 999870478245824934n],
    [4155n, 1004999999999999991n],
    [4154n, 1010024999999999983n],
    [4153n, 1015075124999999975n],
    [4152n, 1020150500624999966n],
    [4151n, 1025251253128124958n],
    [4150n, 1030377509393765575n],
    [4149n, 1035529396940734394n],
  ];

  for (let i = 0; i < buckets.length; i++) {
    const amt = i === buckets.length - 1 ? 100000n : amount;
    await _addBucket(buckets[i]![0]!, buckets[i]![1]!, amt);
  }
}
