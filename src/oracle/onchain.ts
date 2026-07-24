import { getAbi } from '../utils/abi.ts';
import { getAddress } from '../utils/address.ts';
import { client, readOnlyClient } from '../utils/client.ts';
import { getChainTime } from '../utils/chainTime.ts';
import { config } from '../utils/config.ts';
import { log } from '../utils/logger.ts';
import { quotePerCollateralWad } from './denominate.ts';
import type { Address } from 'viem';

type OracleData = readonly [bigint, bigint];

const FUTURE_SKEW_TOLERANCE_SECS = BigInt(config.oracle.futureSkewTolerance);

export async function getOnchainPrice(collateralFeedAddress?: Address): Promise<bigint> {
  const collateralFeedConfigured = collateralFeedAddress ?? config.oracle.onchainCollateralAddress;
  if (!collateralFeedConfigured || !config.oracle.onchainQuoteAddress) {
    throw new Error('onchain oracle addresses are undefined');
  }

  const collateralFeed = await getAddress('chronicleCollateral', collateralFeedAddress);
  const quoteFeed = await getAddress('chronicleQuote');

  const [[collateralUsd, collateralAge], [quoteUsd, quoteAge]] = await Promise.all([
    _queryChronicle(collateralFeed),
    _queryChronicle(quoteFeed),
  ]);
  const latestBlockTimestamp = await getChainTime();

  for (const rawAge of [collateralAge, quoteAge]) {
    checkForFutureTimestamp(rawAge, latestBlockTimestamp);
    checkForStaleTimestamp(latestBlockTimestamp - rawAge);
  }

  return quotePerCollateralWad(collateralUsd, quoteUsd);
}

export async function _queryChronicle(feedAddress: Address): Promise<OracleData> {
  const queryData = {
    address: feedAddress,
    abi: getAbi('chronicle'),
    functionName: 'readWithAge',
  } as const;

  try {
    return (await client.readContract(queryData)) as OracleData;
  } catch {
    log.info(
      { event: 'chronicle_read' },
      'account not tolled by chronicle, falling back to read-only client',
    );
    return (await readOnlyClient.readContract(queryData)) as OracleData;
  }
}

function checkForFutureTimestamp(rawAge: bigint, latestBlockTimestamp: bigint) {
  if (rawAge > latestBlockTimestamp + FUTURE_SKEW_TOLERANCE_SECS) {
    throw new Error('onchain oracle price has future timestamp');
  }
}

function checkForStaleTimestamp(age: bigint) {
  const maxStalenessSecs =
    config.oracle.onchainMaxStaleness == null ? null : BigInt(config.oracle.onchainMaxStaleness);

  if (maxStalenessSecs != null && age > maxStalenessSecs) {
    throw new Error('onchain oracle price is stale');
  }
}
