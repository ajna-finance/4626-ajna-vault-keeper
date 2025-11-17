import { log } from './logger';
import { client } from './client';
import { env } from './env';
import { parseEventLogs, type TransactionReceipt } from 'viem';
import { getAbi } from './abi';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Hash = `0x${string}`;
export type TransactionData = {
  status: boolean;
  assets: bigint;
};

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

export async function handleTransaction(
  tx: Promise<Hash>,
  context?: Record<string, unknown>,
): Promise<TransactionData> {
  let hash: Hash | undefined;
  let assets = 0n;
  let status = false;

  try {
    hash = await tx;
    const receipt = await wait(hash);
    status = true;

    if (context) {
      const action = context.action as string;
      const amount = getAmountMoved(receipt, action);
      assets = amount ?? (context.amount as bigint);
    }

    log.info(
      { event: 'tx_success', hash, block: receipt.blockNumber, assetsMoved: assets, ...context },
      `move confirmed`,
    );
  } catch (err) {
    const receipt = (err as any)?.receipt as TransactionReceipt | undefined;
    const phase = receipt ? 'revert' : hash ? 'fail' : 'send';

    log.error(
      { event: 'tx_failed', phase, hash, block: receipt?.blockNumber, receipt, err, ...context },
      `move failed`,
    );
  }

  return {
    status,
    assets,
  };
}

function getAmountMoved(receipt: any, action: string) {
  const vaultAbi = getAbi('vault');
  let amount;

  if (action === 'Move' || action === 'MoveToBuffer') {
    const logs = parseEventLogs({
      abi: vaultAbi,
      eventName: action,
      logs: receipt.logs,
    }) as unknown as Array<{ args: { amount: bigint } }>;
    amount = logs[0]?.args.amount as bigint;
  } else {
    amount = null;
  }

  return amount;
}
