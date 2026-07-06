import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, pad, toEventSelector, type Address, type Hash, type Log } from 'viem';

const ARK = '0x00000000000000000000000000000000000000a1' as Address;
const POOL = '0x00000000000000000000000000000000000000c3' as Address;
const CALLER = '0x00000000000000000000000000000000000000d4' as Address;
const TX_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111' as Hash;

const MOVE_SIG = 'Move(address,address,uint256,uint256,uint256)';
const MOVE_TO_BUFFER_SIG = 'MoveToBuffer(address,address,uint256,uint256)';
const MOVE_FROM_BUFFER_SIG = 'MoveFromBuffer(address,address,uint256,uint256)';

function paddedAddress(addr: Address): Hash {
  return pad(addr, { size: 32 }) as Hash;
}

function buildMoveLog(amount: bigint, fromBucket = 1n, toBucket = 2n): Log {
  return {
    address: ARK,
    topics: [toEventSelector(MOVE_SIG), paddedAddress(CALLER), paddedAddress(POOL)],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [fromBucket, toBucket, amount],
    ),
    blockNumber: 1n,
    blockHash: TX_HASH,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

function buildMoveToBufferLog(amount: bigint, bucket = 1n): Log {
  return {
    address: ARK,
    topics: [toEventSelector(MOVE_TO_BUFFER_SIG), paddedAddress(CALLER), paddedAddress(POOL)],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [bucket, amount]),
    blockNumber: 1n,
    blockHash: TX_HASH,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

function buildMoveFromBufferLog(amount: bigint, bucket = 1n): Log {
  return {
    address: ARK,
    topics: [toEventSelector(MOVE_FROM_BUFFER_SIG), paddedAddress(CALLER), paddedAddress(POOL)],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [bucket, amount]),
    blockNumber: 1n,
    blockHash: TX_HASH,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

function setupMocks(receipt: { status: 'success' | 'reverted'; logs: Log[]; blockNumber: bigint }) {
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

  vi.doMock('../../src/utils/config.ts', () => ({
    config: {
      metavaultAddress: '0x00000000000000000000000000000000000000e5',
      transaction: { confirmations: 1 },
      keeper: { haltIfLupBelowHtp: false },
      oracle: { onchainAddress: '0x00000000000000000000000000000000000000f6' },
      defaultGas: 0n,
      gasBuffer: 0n,
    },
  }));
  vi.doMock('../../src/keepers/arkKeeper.ts', () => ({ haltKeeper: vi.fn() }));
  vi.doMock('../../src/utils/logger.ts', () => ({ log }));
  vi.doMock('../../src/utils/client.ts', () => ({
    client: {
      waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      getTransaction: vi.fn(),
      getBalance: vi.fn(),
      call: vi.fn(),
    },
  }));

  return { log };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/keepers/arkKeeper.ts');
  vi.doUnmock('../../src/utils/logger.ts');
  vi.doUnmock('../../src/utils/client.ts');
});

describe('handleTransaction move event parsing', () => {
  it('returns the emitted Move amount when smaller than the requested amount', async () => {
    const requested = 1000n;
    const emitted = 750n;

    const { log } = setupMocks({
      status: 'success',
      blockNumber: 1n,
      logs: [buildMoveLog(emitted)],
    });

    const { handleTransaction } = await import('../../src/utils/transaction.ts');

    const result = await handleTransaction(Promise.resolve(TX_HASH), {
      action: 'move',
      from: 1n,
      to: 2n,
      amount: requested,
      ark: ARK,
    });

    expect(result).toEqual({ status: true, assets: emitted });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'tx_success', assetsMoved: emitted }),
      expect.any(String),
    );
  });

  it('parses MoveToBuffer events by their capitalized ABI name', async () => {
    const emitted = 42n;

    setupMocks({
      status: 'success',
      blockNumber: 1n,
      logs: [buildMoveToBufferLog(emitted)],
    });

    const { handleTransaction } = await import('../../src/utils/transaction.ts');

    const result = await handleTransaction(Promise.resolve(TX_HASH), {
      action: 'moveToBuffer',
      from: 1n,
      amount: 100n,
      ark: ARK,
    });

    expect(result).toEqual({ status: true, assets: emitted });
  });

  it('parses MoveFromBuffer events', async () => {
    const emitted = 1234n;

    setupMocks({
      status: 'success',
      blockNumber: 1n,
      logs: [buildMoveFromBufferLog(emitted)],
    });

    const { handleTransaction } = await import('../../src/utils/transaction.ts');

    const result = await handleTransaction(Promise.resolve(TX_HASH), {
      action: 'moveFromBuffer',
      to: 1n,
      amount: 9999n,
      ark: ARK,
    });

    expect(result).toEqual({ status: true, assets: emitted });
  });

  it('treats a confirmed move with no matching event as a failure', async () => {
    const { log } = setupMocks({
      status: 'success',
      blockNumber: 7n,
      logs: [],
    });

    const { handleTransaction } = await import('../../src/utils/transaction.ts');

    const result = await handleTransaction(Promise.resolve(TX_HASH), {
      action: 'moveToBuffer',
      from: 1n,
      amount: 500n,
      ark: ARK,
    });

    expect(result).toEqual({ status: false, assets: 0n });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tx_event_missing',
        phase: 'event_missing',
        expectedEvent: 'MoveToBuffer',
      }),
      expect.stringContaining('MoveToBuffer'),
    );
  });

  it('does not fall back to the requested amount when the event is missing', async () => {
    setupMocks({
      status: 'success',
      blockNumber: 1n,
      logs: [],
    });

    const { handleTransaction } = await import('../../src/utils/transaction.ts');

    const result = await handleTransaction(Promise.resolve(TX_HASH), {
      action: 'move',
      from: 1n,
      to: 2n,
      amount: 99999n,
      ark: ARK,
    });

    expect(result.assets).toBe(0n);
    expect(result.status).toBe(false);
  });

  it('skips event parsing for non-move actions (drain)', async () => {
    setupMocks({
      status: 'success',
      blockNumber: 1n,
      logs: [],
    });

    const { handleTransaction } = await import('../../src/utils/transaction.ts');

    const result = await handleTransaction(Promise.resolve(TX_HASH), {
      action: 'drain',
      bucket: 1n,
      ark: ARK,
    });

    expect(result).toEqual({ status: true, assets: 0n });
  });

  it('skips event parsing for reallocate', async () => {
    setupMocks({
      status: 'success',
      blockNumber: 1n,
      logs: [],
    });

    const { handleTransaction } = await import('../../src/utils/transaction.ts');

    const result = await handleTransaction(Promise.resolve(TX_HASH), {
      action: 'reallocate',
      gas: 1n,
    });

    expect(result).toEqual({ status: true, assets: 0n });
  });

  it('ignores unrelated logs and picks the matching Move event', async () => {
    const emitted = 555n;

    setupMocks({
      status: 'success',
      blockNumber: 1n,
      logs: [
        // unrelated log with no matching topic
        {
          address: ARK,
          topics: ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hash],
          data: '0x',
          blockNumber: 1n,
          blockHash: TX_HASH,
          transactionHash: TX_HASH,
          transactionIndex: 0,
          logIndex: 0,
          removed: false,
        } as unknown as Log,
        buildMoveLog(emitted),
      ],
    });

    const { handleTransaction } = await import('../../src/utils/transaction.ts');

    const result = await handleTransaction(Promise.resolve(TX_HASH), {
      action: 'move',
      from: 1n,
      to: 2n,
      amount: 1000n,
      ark: ARK,
    });

    expect(result).toEqual({ status: true, assets: emitted });
  });
});
