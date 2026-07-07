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
}) {
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const arks = opts.arks ?? [ark(firstArk), ark(secondArk)];
  const metavaultRun = opts.metavaultRun ?? vi.fn().mockResolvedValue(undefined);
  const arkRun = opts.arkRun ?? vi.fn().mockResolvedValue(undefined);
  const resolveArkSettings = opts.resolveArkSettings ?? vi.fn(() => settings);

  vi.doMock('../../src/utils/config.ts', () => ({
    config: {
      metavaultAddress: opts.metavaultAddress,
      keeper: { intervalMs: 1 },
      oracle: {},
      transaction: { confirmations: 0 },
      arks,
    },
    resolveArkSettings,
    resolveRecoverySettings: vi.fn(() => ({ enabled: true })),
  }));
  vi.doMock('../../src/utils/logger.ts', () => ({ log }));
  vi.doMock('../../src/keepers/metavaultKeeper.ts', () => ({ metavaultRun }));
  vi.doMock('../../src/keepers/arkKeeper.ts', () => ({ arkRun }));

  const { runKeeperInterval } = await import('../../src/utils/scheduler.ts');

  return { runKeeperInterval, log, metavaultRun, arkRun, resolveArkSettings };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
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

  it('leaves metavault failures to the outer scheduler failure boundary', async () => {
    const failure = new Error('metavault failure');
    const metavaultRun = vi.fn().mockRejectedValue(failure);

    const { runKeeperInterval, arkRun } = await setupScheduler({
      arks: [ark(firstArk)],
      metavaultAddress: firstArk,
      metavaultRun,
    });

    await expect(runKeeperInterval()).rejects.toThrow('metavault failure');
    expect(arkRun).not.toHaveBeenCalled();
  });
});

describe('recovery-oneshot exit codes', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../src/utils/env.ts');
    vi.doUnmock('../../src/keepers/recoveryKeeper.ts');
    vi.doUnmock('../../src/ark/swapAdapters/index.ts');
    vi.restoreAllMocks();
  });

  async function setupOneshot(executeResults: boolean[]) {
    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const targets = executeResults.map((_, i) => ({
      vaultAddress: `0x00000000000000000000000000000000000000a${i}` as Address,
      vaultAuthAddress: `0x00000000000000000000000000000000000000b${i}` as Address,
      settings: { enabled: true },
    }));
    const execute = vi.fn();
    for (const result of executeResults) execute.mockResolvedValueOnce(result);

    vi.doMock('../../src/utils/env.ts', () => ({ env: { BOT_MODE: 'recovery-oneshot' } }));
    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        keeper: { intervalMs: 1 },
        oracle: {},
        transaction: { confirmations: 0 },
        recovery: {},
        arks: [],
      },
      resolveArkSettings: vi.fn(),
      resolveRecoverySettings: vi.fn(),
    }));
    vi.doMock('../../src/utils/logger.ts', () => ({ log }));
    vi.doMock('../../src/keepers/metavaultKeeper.ts', () => ({ metavaultRun: vi.fn() }));
    vi.doMock('../../src/keepers/arkKeeper.ts', () => ({ arkRun: vi.fn() }));
    vi.doMock('../../src/keepers/recoveryKeeper.ts', () => ({
      detectOnly: vi.fn(),
      execute,
      getRecoveryTargets: () => targets,
    }));
    // Mock at the registry seam so scheduler tests don't drag the adapters' real
    // client/signing dependency chain into this module graph.
    vi.doMock('../../src/ark/swapAdapters/index.ts', () => ({
      createSwapExecutor: vi.fn(() => undefined),
    }));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { startScheduler } = await import('../../src/utils/scheduler.ts');
    startScheduler();
    return { exitSpy, execute, log };
  }

  it('exits 1 when any ark run reports failure', async () => {
    const { exitSpy, execute, log } = await setupOneshot([true, false]);

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'recovery_oneshot_incomplete' }),
      expect.any(String),
    );
  });

  it('exits 0 when every ark run completes cleanly', async () => {
    const { exitSpy, execute } = await setupOneshot([true, true]);

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
