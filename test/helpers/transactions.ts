import { client } from '../../src/utils/client';
import type { Hash, TransactionReceipt } from 'viem';

export async function waitForWrite(tx: Promise<Hash>): Promise<TransactionReceipt> {
  const hash = await tx;
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted`);
  return receipt;
}
