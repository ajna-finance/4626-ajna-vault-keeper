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

export const getTotalT0DebtInAuction = () => pool().read.totalT0DebtInAuction();

export const getInflatorInfo = () => pool().read.inflatorInfo();

export const getDepositIndex = (debt: bigint) => pool().read.depositIndex(debt);

export const isBucketDebtLocked = async (index: bigint): Promise<boolean> => {
  const t0DebtInAuction = (await getTotalT0DebtInAuction()) as bigint;
  let debtLocked = false;

  if (t0DebtInAuction !== 0n) {
    const inflatorInfo = await getInflatorInfo();
    const wad = 10n ** 18n;
    const debt = (t0DebtInAuction * inflatorInfo[0] + wad / 2n) / wad;
    const indexOfSum = await getDepositIndex(debt);

    if (index <= indexOfSum) debtLocked = true;
  }

  return debtLocked;
};
