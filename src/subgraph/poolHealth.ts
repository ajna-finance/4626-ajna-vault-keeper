import { gql, request } from 'graphql-request';
import { env } from '../utils/env.ts';
import { config } from '../utils/config.ts';
import { log } from '../utils/logger.ts';
import { getChainTime } from '../utils/chainTime.ts';
import type { Address } from 'viem';

type GetUnsettledAuctionsResponse = {
  liquidationAuctions: LiquidationAuction[];
};

type LiquidationAuction = {
  borrower: string;
  kickTime: string;
};

const AUCTION_PAGE_SIZE = 1000;

type VaultLike = {
  getAddress: () => Address | undefined;
  getPoolAddress: () => Promise<Address>;
  getAuctionStatus: (borrower: Address) => Promise<readonly [bigint, bigint, bigint, ...unknown[]]>;
};

export class SubgraphUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('subgraph query failed in fail-closed mode', { cause });
    this.name = 'SubgraphUnavailableError';
  }
}

export async function poolHasBadDebt(vault: VaultLike, maxAuctionAge?: number): Promise<boolean> {
  const auctions = await _getUnsettledAuctions(vault);
  const nowSec = await getChainTime();

  for (let i = 0; i < auctions.liquidationAuctions.length; i++) {
    const borrower = auctions.liquidationAuctions[i]!.borrower;
    const [kickTime, collateralRemaining, debtRemaining] = await vault.getAuctionStatus(
      borrower as Address,
    );
    const activeDebtAuction = kickTime !== 0n && debtRemaining > 0n;

    if (
      activeDebtAuction &&
      (collateralRemaining === 0n || isPastAuctionAge(kickTime, nowSec, maxAuctionAge))
    )
      return true;
  }

  return false;
}

export async function _getUnsettledAuctions(
  vault: VaultLike,
): Promise<GetUnsettledAuctionsResponse> {
  try {
    const poolAddress = (await vault.getPoolAddress()).toLowerCase();
    const subgraphUrl = env.SUBGRAPH_URL;

    const query = gql`
      query GetUnsettledAuctions($poolId: String!, $first: Int!, $skip: Int!) {
        liquidationAuctions(
          first: $first
          skip: $skip
          orderBy: id
          orderDirection: asc
          where: { pool: $poolId, settled: false }
        ) {
          borrower
          kickTime
        }
      }
    `;

    const liquidationAuctions: LiquidationAuction[] = [];
    let skip = 0;

    while (true) {
      const result = await request<GetUnsettledAuctionsResponse>(subgraphUrl!, query, {
        poolId: poolAddress,
        first: AUCTION_PAGE_SIZE,
        skip,
      });

      liquidationAuctions.push(...result.liquidationAuctions);

      if (result.liquidationAuctions.length < AUCTION_PAGE_SIZE) break;
      skip += AUCTION_PAGE_SIZE;
    }

    return { liquidationAuctions };
  } catch (err) {
    log.error(
      {
        event: 'subgraph_query_failed',
        subgraphOrigin: safeOrigin(env.SUBGRAPH_URL),
        ark: vault.getAddress(),
        err,
      },
      'subgraph query failed',
    );

    if (config.keeper.exitOnSubgraphFailure) throw new SubgraphUnavailableError(err);
    return { liquidationAuctions: [] };
  }
}

function safeOrigin(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl).origin;
  } catch {
    return undefined;
  }
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
