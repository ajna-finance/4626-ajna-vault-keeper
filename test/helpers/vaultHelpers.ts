import { contract } from '../../src/utils/contract';
import { config } from '../../src/utils/config';
import { createVault } from '../../src/ark/vault';
import type { Address } from 'viem';
import { waitForWrite } from './transactions';

/* eslint-disable @typescript-eslint/no-explicit-any */

function getVaultAddr(): Address {
  return (
    process.env.USE_MOCKS === 'true' ? process.env.MOCK_VAULT_ADDRESS : config.arks[0]!.vaultAddress
  ) as Address;
}

function getVaultAuthAddr(): Address {
  return (
    process.env.USE_MOCKS === 'true'
      ? process.env.MOCK_VAULT_AUTH_ADDRESS
      : config.arks[0]!.vaultAuthAddress
  ) as Address;
}

const vaultAuth = () => contract('vaultAuth', getVaultAuthAddr())();
const chronicle = () => contract('chronicle', process.env.MOCK_CHRONICLE_ADDRESS as Address)();
const vault = () => contract('vault', getVaultAddr())();

const getPool = async () => {
  const poolAddr = await createVault(getVaultAddr(), getVaultAuthAddr()).getPoolAddress();
  return contract('pool', poolAddr)();
};

const getPoolInfoUtils = async () => {
  const v = createVault(getVaultAddr(), getVaultAuthAddr());
  const addr = (await v.getPoolInfoUtilsAddress()) as Address;
  return contract('poolInfoUtils', addr)();
};

export const setBufferRatio = (ratio: bigint) =>
  waitForWrite(vaultAuth().write.setBufferRatio([ratio]));
export const setMinBucketIndex = (index: bigint) =>
  waitForWrite(vaultAuth().write.setMinBucketIndex([index]));

export const setPaused = (status: boolean) => waitForWrite(vault().write.setPaused(status));

const _setPrice = (price: bigint) => waitForWrite(chronicle().write.setPrice(price));

export const setBankruptcyTime = async (timestamp: bigint) =>
  waitForWrite((await getPool()).write.setBankruptcyTime(timestamp));
export const setLps = async (lps: bigint) => waitForWrite((await getPool()).write.setLps(lps));

export const setAuctionStatus = async (
  borrower: Address,
  kickTime: bigint,
  collateral: bigint,
  debt: bigint,
) =>
  waitForWrite(
    (await getPoolInfoUtils()).write.setAuctionStatus(borrower, kickTime, collateral, debt),
  );
export const setAuctionBorrowers = async (borrowers: Address[]) =>
  waitForWrite((await getPool()).write.setAuctionBorrowers([borrowers]));
const _setLup = async (lup: bigint) => waitForWrite((await getPoolInfoUtils()).write.setLup(lup));
const _setHtp = async (htp: bigint) => waitForWrite((await getPoolInfoUtils()).write.setHtp(htp));

const _addBucket = (index: bigint, price: bigint, amount: bigint) =>
  waitForWrite(vault().write.addBucket(index, price, amount));

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
