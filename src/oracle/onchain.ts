import { getAbi } from '../utils/abi';
import { getAddress } from '../utils/address';
import { client, readOnlyClient } from '../utils/client';
import { env } from '../utils/env';
import { log } from '../utils/logger';
import type { Address } from 'viem';

type OracleData = readonly [bigint, bigint];

export async function getOnchainPrice(): Promise<bigint> {
  if (!env.ONCHAIN_ORACLE_ADDRESS) throw new Error('onchain oracle address is undefined');

  const [price, rawAge] = await _queryChronicle();

  const age = Math.floor(Date.now() / 1_000) - Number(rawAge);
  if (
    Number(env.ONCHAIN_ORACLE_MAX_STALENESS) > 0 &&
    age > Number(env.ONCHAIN_ORACLE_MAX_STALENESS)
  )
    throw new Error('onchain oracle price is stale');

  return price;
}

export async function _queryChronicle(): Promise<OracleData> {
  const queryData = {
    address: (await getAddress('chronicle')) as Address,
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
