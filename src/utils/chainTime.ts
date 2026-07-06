import { readOnlyClient } from './client.ts';

export class ChainTimeUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('failed to read latest block timestamp from RPC', { cause });
    this.name = 'ChainTimeUnavailableError';
  }
}

export async function getChainTime(): Promise<bigint> {
  try {
    const latestBlock = await readOnlyClient.getBlock({ blockTag: 'latest' });
    return latestBlock.timestamp;
  } catch (err) {
    throw new ChainTimeUnavailableError(err);
  }
}
