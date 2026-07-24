import { log } from './logger.ts';
import { client } from './client.ts';
import { config } from './config.ts';
import { getAddress, type contracts } from './address.ts';
import { getAbi, type ContractAbiKey } from './abi.ts';
import { decodeAjnaError } from '../ajna/utils/decodeAjnaError.ts';
import { haltKeeper } from '../keepers/arkKeeper.ts';
import {
  parseEventLogs,
  decodeErrorResult,
  type TransactionReceipt,
  type Address,
  isAddress,
} from 'viem';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Hash = `0x${string}`;
export type TransactionData = {
  status: boolean;
  assets: bigint;
};
type ContractKey = keyof typeof contracts;
type TransactionContext = Record<string, unknown>;

const LUP_BELOW_HTP_SELECTOR = '0x444507e1';

const MOVE_EVENT_BY_ACTION = {
  move: 'Move',
  moveToBuffer: 'MoveToBuffer',
  moveFromBuffer: 'MoveFromBuffer',
} as const satisfies Record<string, string>;

type MoveAction = keyof typeof MOVE_EVENT_BY_ACTION;
type MoveEventName = (typeof MOVE_EVENT_BY_ACTION)[MoveAction];

const confirmations = config.transaction.confirmations;

export async function wait(
  txHash: Hash,
  context?: TransactionContext,
): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    confirmations,
  });

  if (receipt.status !== 'success') {
    const tx = await client.getTransaction({ hash: txHash });

    try {
      await client.call({
        to: tx.to!,
        account: tx.from,
        data: tx.input,
        blockNumber: receipt.blockNumber,
      });
    } catch (err: any) {
      const data = getRevertData(err);
      const errorName = getErrorName(err, data);

      if (isLupBelowHtp(data, errorName)) {
        const decoded = { errorName: 'LUPBelowHTP', data };
        if (config.keeper.haltIfLupBelowHtp) {
          const ark = getArkAddress(context);
          if (ark) haltKeeper(ark);
        }
        throw Object.assign(
          new Error(
            'LUPBelowHTP. Vault funds have been lent out by the pool and cannot be moved. Consider running the AJNA Keeper to check for necessary liquidations.',
          ),
          { receipt, decoded, cause: err },
        );
      } else if (data) {
        let decoded;
        try {
          decoded = decodeErrorResult({ abi: getAbi('metavault'), data });
        } catch {
          try {
            decoded = decodeErrorResult({ abi: getAbi('vault'), data });
          } catch {
            decoded = { errorName: errorName ?? 'UnknownRevert', sig: data.slice(0, 10), data };
          }
        }
        throw Object.assign(new Error(String(decoded.errorName)), { receipt, decoded, cause: err });
      }
    }

    throw Object.assign(new Error(`Transaction ${txHash} reverted`), { receipt });
  }

  return receipt;
}

export async function handleTransaction(
  tx: Promise<Hash>,
  context?: TransactionContext,
): Promise<TransactionData> {
  let hash: Hash | undefined;
  let assets = 0n;
  let status = false;

  try {
    hash = await tx;
    const receipt = await wait(hash, context);

    const eventName = getMoveEventName(context?.action);
    if (eventName) {
      const amount = parseMoveEventAmount(receipt, eventName);
      if (amount === undefined) {
        log.error(
          {
            event: 'tx_event_missing',
            phase: 'event_missing',
            hash,
            block: receipt.blockNumber,
            expectedEvent: eventName,
            ...context,
          },
          `transaction confirmed without expected '${eventName}' event; treating as failure`,
        );
        return { status: false, assets: 0n };
      }
      assets = amount;
    }

    status = true;

    if (assets === 0n) {
      log.info(
        {
          event: 'tx_success',
          hash,
          block: receipt.blockNumber,
          ...context,
        },
        `transaction confirmed`,
      );
    } else {
      log.info(
        {
          event: 'tx_success',
          hash,
          block: receipt.blockNumber,
          assetsMoved: assets,
          ...context,
        },
        `transaction confirmed`,
      );
    }
  } catch (err) {
    const receipt = (err as any)?.receipt as TransactionReceipt | undefined;
    const phase = receipt ? 'revert' : hash ? 'fail' : 'send';

    if (phase === 'fail' && hash) {
      const isInsufficientFunds = await _checkInsufficientFunds(hash);
      if (isInsufficientFunds) {
        log.error(
          {
            event: 'tx_failed',
            phase: 'insufficient_funds',
            hash,
            reason: 'Account does not have enough ETH to cover gas costs',
            ...context,
          },
          'transaction failed: insufficient funds',
        );
        return { status, assets };
      }
    }

    log.error(
      {
        event: 'tx_failed',
        phase,
        hash,
        block: receipt?.blockNumber,
        receipt,
        err: abridgedViemError(err),
        ...context,
      },
      `transaction failed`,
    );
  }

  return {
    status,
    assets,
  };
}

function getMoveEventName(action: unknown): MoveEventName | undefined {
  if (typeof action !== 'string') return undefined;
  return MOVE_EVENT_BY_ACTION[action as MoveAction];
}

function parseMoveEventAmount(
  receipt: TransactionReceipt,
  eventName: MoveEventName,
): bigint | undefined {
  const logs = parseEventLogs({
    abi: getAbi('vault'),
    eventName,
    logs: receipt.logs,
  }) as unknown as Array<{ args: { amount: bigint } }>;
  return logs[0]?.args.amount;
}

function abridgedViemError(err: unknown) {
  const e = err as any;
  const data = getRevertData(err);
  const errorName = getErrorName(err, data);

  return {
    shortMessage: e?.shortMessage,
    errorName,
    decoded: e?.decoded,
    contractAddress: e?.contractAddress,
    functionName: e?.functionName,
    args: e?.args,
    sender: e?.sender,
    data,
    stack: e?.stack,
  };
}

export async function getGasWithBuffer(
  contract: ContractKey | ContractAbiKey,
  functionName: string,
  args: readonly unknown[],
  address?: Address,
): Promise<bigint> {
  const defaultGas = config.defaultGas;
  const resolvedAddress = address ?? (await getAddress(contract as ContractKey));
  const abi = getAbi(contract as ContractAbiKey);

  try {
    const fees = await client.estimateFeesPerGas();
    const estimated = await client.estimateContractGas({
      account: client.account,
      address: resolvedAddress,
      abi,
      functionName,
      args,
      ...fees,
    });
    return estimated + (estimated * config.gasBuffer) / 100n;
  } catch (err) {
    log.warn(
      {
        event: 'gas_estimation_failed',
        error: abridgedViemError(err),
        defaultGas,
      },
      `gas estimation failed, falling back to default value: ${defaultGas}`,
    );

    return defaultGas;
  }
}

async function _checkInsufficientFunds(hash: Hash): Promise<boolean> {
  try {
    const tx = await client.getTransaction({ hash }).catch(() => null);

    if (!tx) return true;

    const balance = await client.getBalance({ address: tx.from });
    const maxGasCost = tx.gas * (tx.maxFeePerGas || tx.gasPrice || 0n);

    if (balance < maxGasCost) return true;

    return false;
  } catch {
    return false;
  }
}

function getRevertData(err: unknown): Hash | undefined {
  const e = err as any;
  const data = e?.cause?.cause?.data ?? e?.cause?.data ?? e?.data ?? e?.decoded?.data;
  return typeof data === 'string' && data.startsWith('0x') ? (data as Hash) : undefined;
}

function getErrorName(err: unknown, data?: Hash): string | undefined {
  const e = err as any;
  const errorName = e?.decoded?.errorName ?? e?.cause?.errorName ?? e?.errorName;
  if (typeof errorName === 'string') return errorName;
  if (!data) return undefined;

  try {
    return decodeAjnaError(data).errorName;
  } catch {
    return undefined;
  }
}

function isLupBelowHtp(data?: Hash, errorName?: string) {
  return errorName === 'LUPBelowHTP' || data === LUP_BELOW_HTP_SELECTOR;
}

function getArkAddress(context?: TransactionContext): Address | undefined {
  const ark = context?.ark;
  return typeof ark === 'string' && isAddress(ark) ? ark : undefined;
}
