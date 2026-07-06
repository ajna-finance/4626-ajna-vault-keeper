import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/client.ts');
});

describe('getChainTime', () => {
  it('returns the latest block timestamp from the read-only client', async () => {
    const expectedTimestamp = 1_700_000_000n;
    const getBlock = vi.fn().mockResolvedValue({ timestamp: expectedTimestamp });

    vi.doMock('../../src/utils/client.ts', () => ({
      readOnlyClient: { getBlock },
    }));

    const { getChainTime } = await import('../../src/utils/chainTime.ts');

    await expect(getChainTime()).resolves.toBe(expectedTimestamp);
    expect(getBlock).toHaveBeenCalledExactlyOnceWith({ blockTag: 'latest' });
  });

  it('returns the chain timestamp even when host wall clock has drifted', async () => {
    // Chain reports a value much earlier than the host clock would; the utility
    // must trust the RPC, never the host clock.
    const chainTimestamp = 1_500_000_000n;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Number(1_800_000_000n) * 1000));

    vi.doMock('../../src/utils/client.ts', () => ({
      readOnlyClient: {
        getBlock: vi.fn().mockResolvedValue({ timestamp: chainTimestamp }),
      },
    }));

    const { getChainTime } = await import('../../src/utils/chainTime.ts');

    try {
      await expect(getChainTime()).resolves.toBe(chainTimestamp);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps RPC errors as ChainTimeUnavailableError with the cause preserved', async () => {
    const rpcError = new Error('rpc unreachable');
    vi.doMock('../../src/utils/client.ts', () => ({
      readOnlyClient: { getBlock: vi.fn().mockRejectedValue(rpcError) },
    }));

    const { getChainTime, ChainTimeUnavailableError } = await import(
      '../../src/utils/chainTime.ts'
    );

    const thrown = await getChainTime().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ChainTimeUnavailableError);
    expect((thrown as Error).cause).toBe(rpcError);
  });
});
