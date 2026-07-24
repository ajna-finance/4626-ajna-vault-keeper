import { getChainTime } from '../utils/chainTime.ts';
import { config } from '../utils/config.ts';
import { zeroAddress, type Address } from 'viem';

type VaultLike = {
  getAddress: () => Address | undefined;
  getTotalAuctionsInPool: () => Promise<bigint>;
  getAuctionNext: (
    borrower: Address,
  ) => Promise<{ head: Address; next: Address; kickTime: bigint }>;
  getAuctionStatus: (borrower: Address) => Promise<readonly [bigint, bigint, bigint, ...unknown[]]>;
};

export async function poolHasBadDebt(vault: VaultLike, maxAuctionAge?: number): Promise<boolean> {
  const borrowers = await _getActiveAuctionBorrowers(vault);
  if (borrowers.length === 0) return false;

  const nowSec = await getChainTime();

  for (const borrower of borrowers) {
    const [kickTime, collateralRemaining, debtRemaining] = await vault.getAuctionStatus(borrower);
    const activeDebtAuction = kickTime !== 0n && debtRemaining > 0n;

    if (
      activeDebtAuction &&
      (collateralRemaining === 0n || isPastAuctionAge(kickTime, nowSec, maxAuctionAge))
    )
      return true;
  }

  return false;
}

const MAX_ENUMERATION_ATTEMPTS = 3;

export async function _getActiveAuctionBorrowers(vault: VaultLike): Promise<Address[]> {
  for (let attempt = 0; attempt < MAX_ENUMERATION_ATTEMPTS; attempt++) {
    const count = await vault.getTotalAuctionsInPool();
    if (count === 0n) return [];

    const borrowers = await _walkAuctionList(vault, count);
    if (borrowers !== null && BigInt(borrowers.length) === count) {
      const countAfter = await vault.getTotalAuctionsInPool();
      if (countAfter === count) return borrowers;
    }
  }

  throw new Error(
    `pool auction list for ark ${vault.getAddress()} kept changing during enumeration`,
  );
}

async function _walkAuctionList(vault: VaultLike, count: bigint): Promise<Address[] | null> {
  const borrowers: Address[] = [];
  let cursor = (await vault.getAuctionNext(zeroAddress)).head;

  while (cursor !== zeroAddress) {
    const { next, kickTime } = await vault.getAuctionNext(cursor);
    if (kickTime === 0n) return null;
    borrowers.push(cursor);
    if (BigInt(borrowers.length) > count) return null;
    cursor = next;
  }

  return borrowers;
}

export function isPastAuctionAge(
  kickTime: bigint,
  nowSec: bigint,
  maxAuctionAge?: number,
): boolean {
  const maxAge = maxAuctionAge ?? config.arkGlobal.maxAuctionAge;
  if (maxAge === 0) return true;
  return nowSec - kickTime > BigInt(maxAge);
}
