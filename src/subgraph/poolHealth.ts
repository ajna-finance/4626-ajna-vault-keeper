import { gql, request } from 'graphql-request';
import { env } from '../utils/env';
import { log } from '../utils/logger';
import { getPoolAddress } from '../vault/vault';
import { getAuctionStatus } from '../ajna/poolInfoUtils';
import type { Address } from 'viem';

type GetUnsettledAuctionsResponse = {
  liquidationAuctions: LiquidationAuction[];
};

type LiquidationAuction = {
  borrower: string;
  kickTime: string;
};

export async function poolHasBadDebt(): Promise<boolean> {
  const unfilteredAuctions = await _getUnsettledAuctions();
  const auctionsBeforeCutoff = _filterAuctions(unfilteredAuctions);

  for (let i = 0; i < auctionsBeforeCutoff.length; i++) {
    const [kickTime, collateralRemaining, debtRemaining] = await getAuctionStatus(
      auctionsBeforeCutoff[i]!.borrower as Address,
    );

    if (kickTime !== 0n && debtRemaining > 0n && collateralRemaining === 0n) return true;
  }

  return false;
}

export async function _getUnsettledAuctions(): Promise<GetUnsettledAuctionsResponse> {
  try {
    const poolAddress = (await getPoolAddress()).toLowerCase();
    const subgraphUrl = env.SUBGRAPH_URL;

    const query = gql`
      query GetUnsettledAuctions($poolId: String!) {
        liquidationAuctions(where: { pool: $poolId, settled: false }) {
          borrower
          kickTime
        }
      }
    `;

    const result: GetUnsettledAuctionsResponse = await request(subgraphUrl!, query, {
      poolId: poolAddress,
    });

    return result;
  } catch (err) {
    log.error(
      { event: 'subgraph_query_failed', url: env.SUBGRAPH_URL, err },
      'subgraph query failed, continuing with keeper run optimistically',
    );

    return { liquidationAuctions: [] };
  }
}

export function _filterAuctions(response: GetUnsettledAuctionsResponse): LiquidationAuction[] {
  const unsettledAuctions = response.liquidationAuctions;
  const maxAge = env.MAX_AUCTION_AGE;

  if (maxAge === 0) return unsettledAuctions;

  let auctionsBeforeCutoff: LiquidationAuction[] = [];

  for (let i = 0; i < unsettledAuctions.length; i++) {
    const kickTime = Number(unsettledAuctions[i]!.kickTime);
    const auctionAge = Math.floor(Date.now() / 1000) - kickTime;

    if (auctionAge > maxAge) {
      auctionsBeforeCutoff.push(unsettledAuctions[i]!);
    }
  }

  return auctionsBeforeCutoff;
}
