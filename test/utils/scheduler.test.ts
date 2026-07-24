import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const firstArk = '0x00000000000000000000000000000000000000a1' as Address;
const secondArk = '0x00000000000000000000000000000000000000b2' as Address;
const thirdArk = '0x00000000000000000000000000000000000000c3' as Address;

const settings = {
  optimalBucketDiff: 0n,
  bufferPadding: 0n,
  minMoveAmount: 1n,
  minTimeSinceBankruptcy: 0n,
  maxAuctionAge: 0,
};

function ark(vaultAddress: Address) {
  return { vaultAddress, vaultAuthAddress: vaultAddress };
}

async function setupScheduler(opts: {
  arks?: ReturnType<typeof ark>[];
  metavaultAddress?: Address;
  metavaultRun?: ReturnType<typeof vi.fn>;
  arkRun?: ReturnType<typeof vi.fn>;
  resolveArkSettings?: ReturnType<typeof vi.fn>;
  getTransactionCount?: ReturnType<typeof vi.fn>;
}) {
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const arks = opts.arks ?? [ark(firstArk), ark(secondArk)];
  const metavaultRun = opts.metavaultRun ?? vi.fn().mockResolvedValue(undefined);
  const arkRun = opts.arkRun ?? vi.fn().mockResolvedValue(undefined);
  const resolveArkSettings = opts.resolveArkSettings ?? vi.fn(() => settings);
  const getTransactionCount = opts.getTransactionCount ?? vi.fn().mockResolvedValue(0);

  vi.doMock('../../src/utils/config.ts', () => ({
    config: {
      metavaultAddress: opts.metavaultAddress,
      keeper: { intervalMs: 1 },
      arks,
    },
    resolveArkSettings,
  }));
  vi.doMock('../../src/utils/client.ts', () => ({
    client: {
      account: { address: '0x00000000000000000000000000000000000000ee' },
      getTransactionCount,
    },
  }));
  vi.doMock('../../src/utils/logger.ts', () => ({ log }));
  vi.doMock('../../src/keepers/metavaultKeeper.ts', () => ({ metavaultRun }));
  vi.doMock('../../src/keepers/arkKeeper.ts', () => ({ arkRun }));

  const { runKeeperInterval } = await import('../../src/utils/scheduler.ts');

  return { runKeeperInterval, log, metavaultRun, arkRun, resolveArkSettings, getTransactionCount };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/utils/client.ts');
  vi.doUnmock('../../src/utils/logger.ts');
  vi.doUnmock('../../src/keepers/metavaultKeeper.ts');
  vi.doUnmock('../../src/keepers/arkKeeper.ts');
});

describe('runKeeperInterval', () => {
  it('continues to later ARKs when one ARK run throws', async () => {
    const failure = new Error('ark failure');
    const arkRun = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);

    const { runKeeperInterval, log, resolveArkSettings } = await setupScheduler({
      arks: [ark(firstArk), ark(secondArk), ark(thirdArk)],
      arkRun,
    });

    await expect(runKeeperInterval()).resolves.toBeUndefined();

    expect(resolveArkSettings).toHaveBeenCalledTimes(3);
    expect(arkRun).toHaveBeenCalledTimes(3);
    expect(arkRun).toHaveBeenNthCalledWith(1, firstArk, firstArk, settings);
    expect(arkRun).toHaveBeenNthCalledWith(2, secondArk, secondArk, settings);
    expect(arkRun).toHaveBeenNthCalledWith(3, thirdArk, thirdArk, settings);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ark_run_failed',
        ark: secondArk,
        vaultAuth: secondArk,
        err: failure,
      }),
      expect.stringContaining(secondArk),
    );
  });

  it('continues to later ARKs when one ARK settings resolution throws', async () => {
    const failure = new Error('bad ark config');
    const resolveArkSettings = vi.fn((configuredArk: ReturnType<typeof ark>) => {
      if (configuredArk.vaultAddress === firstArk) throw failure;
      return settings;
    });

    const { runKeeperInterval, log, arkRun } = await setupScheduler({
      arks: [ark(firstArk), ark(secondArk)],
      resolveArkSettings,
    });

    await expect(runKeeperInterval()).resolves.toBeUndefined();

    expect(resolveArkSettings).toHaveBeenCalledTimes(2);
    expect(arkRun).toHaveBeenCalledOnce();
    expect(arkRun).toHaveBeenCalledWith(secondArk, secondArk, settings);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ark_run_failed',
        ark: firstArk,
        vaultAuth: firstArk,
        err: failure,
      }),
      expect.stringContaining(firstArk),
    );
  });

  it('isolates metavault failures so ARK runs still execute', async () => {
    const failure = new Error('metavault failure');
    const metavaultRun = vi.fn().mockRejectedValue(failure);

    const { runKeeperInterval, arkRun, log } = await setupScheduler({
      arks: [ark(firstArk)],
      metavaultAddress: firstArk,
      metavaultRun,
    });

    await expect(runKeeperInterval()).resolves.toBeUndefined();
    expect(arkRun).toHaveBeenCalledWith(firstArk, firstArk, settings);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'metavault_run_failed', err: failure }),
      expect.any(String),
    );
  });

  // Regression (PR19-D10): after a receipt timeout the keeper persists nothing, so a still
  // pending transaction from a prior interval could be duplicated by the next run's
  // submissions. The interval must skip entirely while the account has an in-flight nonce.
  it('skips the whole interval when the account has a pending transaction', async () => {
    const getTransactionCount = vi.fn(({ blockTag }: { blockTag: string }) =>
      Promise.resolve(blockTag === 'pending' ? 5 : 4),
    );

    const { runKeeperInterval, log, metavaultRun, arkRun } = await setupScheduler({
      arks: [ark(firstArk)],
      metavaultAddress: firstArk,
      getTransactionCount,
    });

    await expect(runKeeperInterval()).resolves.toBeUndefined();

    expect(metavaultRun).not.toHaveBeenCalled();
    expect(arkRun).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'pending_transaction_detected', pending: 5, latest: 4 }),
      expect.stringContaining('still pending'),
    );
  });

  it('runs normally when pending and latest nonces match', async () => {
    const { runKeeperInterval, arkRun, getTransactionCount } = await setupScheduler({
      arks: [ark(firstArk)],
    });

    await expect(runKeeperInterval()).resolves.toBeUndefined();

    expect(getTransactionCount).toHaveBeenCalledWith(
      expect.objectContaining({ blockTag: 'pending' }),
    );
    expect(getTransactionCount).toHaveBeenCalledWith(
      expect.objectContaining({ blockTag: 'latest' }),
    );
    expect(arkRun).toHaveBeenCalled();
  });
});
