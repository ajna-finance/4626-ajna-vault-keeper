import { log } from './logger';
import { client } from './client';
import { env } from './env';
import type { TransactionReceipt } from 'viem';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Hash = `0x${string}`;
const confirmations = Number(env.CONFIRMATIONS ?? 1);

export async function wait(txHash: Hash): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    confirmations: confirmations,
  });

  if (receipt.status !== 'success') {
    const e = new Error(`Transaction ${txHash} reverted`);
    (e as any).receipt = receipt;
    throw e;
  }

  return receipt;
}

export async function handleTransaction(tx: Promise<Hash>, context?: Record<string, unknown>) {
  let hash: Hash | undefined;

  try {
    hash = await tx;
    const receipt = await wait(hash);
    log.info(
      { event: 'tx_success', hash, block: receipt.blockNumber, ...context },
      `move confirmed`,
    );
    return true;
  } catch (err) {
    const receipt = (err as any)?.receipt as TransactionReceipt | undefined;
    const phase = receipt ? 'revert' : hash ? 'fail' : 'send';
    log.error(
      { event: 'tx_failed', phase, hash, block: receipt?.blockNumber, receipt, err, ...context },
      `move failed`,
    );
    return false;
  }
}
