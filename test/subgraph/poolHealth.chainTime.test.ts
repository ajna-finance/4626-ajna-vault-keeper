import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const POOL_ADDRESS = '0x0000000000000000000000000000000000000001' as Address;
const VAULT_ADDRESS = '0x0000000000000000000000000000000000000002' as Address;
const BORROWER = '0x0000000000000000000000000000000000000003' as Address;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('graphql-request');
  vi.doUnmock('../../src/utils/env');
  vi.doUnmock('../../src/utils/config');
  vi.doUnmock('../../src/utils/logger');
  vi.doUnmock('../../src/utils/chainTime.ts');
});

function makeVault() {
  return {
    getAddress: () => VAULT_ADDRESS,
    getPoolAddress: vi.fn().mockResolvedValue(POOL_ADDRESS),
    getAuctionStatus: vi.fn(),
  };
}

// isPastAuctionAge cutoff is `auctionAge > maxAge` (strictly greater than). These
// tests pin the boundary so a refactor cannot silently turn it into >= and start
// flagging boundary-aged auctions as "stuck".
describe('isPastAuctionAge cutoff boundary', () => {
  async function loadIsPastAuctionAge() {
    vi.doMock('../../src/utils/config', () => ({
      config: { arkGlobal: { maxAuctionAge: 1 } },
    }));
    vi.doMock('../../src/utils/logger', () => ({
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('../../src/utils/chainTime.ts', () => ({
      getChainTime: vi.fn(),
    }));
    const mod = await import('../../src/subgraph/poolHealth');
    return mod.isPastAuctionAge;
  }

  it('excludes auctions whose age equals maxAge', async () => {
    const isPastAuctionAge = await loadIsPastAuctionAge();
    const nowSec = 1_700_000_000n;
    const maxAge = 100;
    const kickTime = nowSec - BigInt(maxAge);

    expect(isPastAuctionAge(kickTime, nowSec, maxAge)).toBe(false);
  });

  it('includes auctions whose age is one second past maxAge', async () => {
    const isPastAuctionAge = await loadIsPastAuctionAge();
    const nowSec = 1_700_000_000n;
    const maxAge = 100;
    const kickTime = nowSec - BigInt(maxAge) - 1n;

    expect(isPastAuctionAge(kickTime, nowSec, maxAge)).toBe(true);
  });

  it('excludes auctions kicked in the future (kickTime > nowSec)', async () => {
    const isPastAuctionAge = await loadIsPastAuctionAge();
    const nowSec = 1_700_000_000n;
    const kickTime = nowSec + 50n;

    expect(isPastAuctionAge(kickTime, nowSec, 100)).toBe(false);
  });

  it('excludes auctions with kickTime exactly equal to nowSec (age 0)', async () => {
    const isPastAuctionAge = await loadIsPastAuctionAge();
    const nowSec = 1_700_000_000n;

    expect(isPastAuctionAge(nowSec, nowSec, 100)).toBe(false);
  });

  it('returns true for every auction when maxAge is 0 regardless of nowSec', async () => {
    const isPastAuctionAge = await loadIsPastAuctionAge();
    const nowSec = 1_700_000_000n;

    expect(isPastAuctionAge(nowSec - 10n, nowSec, 0)).toBe(true);
    expect(isPastAuctionAge(nowSec + 10n, nowSec, 0)).toBe(true);
  });
});

// End-to-end coverage that poolHasBadDebt sources "now" from chain time, not
// from Date.now(). Failure of this test would mean an operator with a drifted
// host clock could under- or over-report bad-debt status.
describe('poolHasBadDebt uses chain time, not host wall clock', () => {
  async function loadPoolHealth(opts: {
    chainTimeSec: bigint;
    auctions: Array<{ borrower: string; kickTime: string }>;
  }) {
    vi.doMock('graphql-request', () => ({
      gql: (strings: TemplateStringsArray) => strings[0] ?? '',
      request: vi.fn().mockResolvedValue({ liquidationAuctions: opts.auctions }),
    }));
    vi.doMock('../../src/utils/env', () => ({
      env: { SUBGRAPH_URL: 'https://example.test/subgraph' },
    }));
    vi.doMock('../../src/utils/config', () => ({
      config: {
        keeper: { exitOnSubgraphFailure: true },
        arkGlobal: { maxAuctionAge: 600 },
      },
    }));
    vi.doMock('../../src/utils/logger', () => ({
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('../../src/utils/chainTime.ts', () => ({
      getChainTime: vi.fn().mockResolvedValue(opts.chainTimeSec),
    }));
    return await import('../../src/subgraph/poolHealth');
  }

  it('flags stale active debt when chain time puts the auction past the cutoff even if Date.now would not', async () => {
    const chainTimeSec = 1_700_000_700n;
    const dateNowSec = 1_700_000_000n;
    const kickTimeSec = 1_700_000_050n;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Number(dateNowSec) * 1000));
    try {
      const { poolHasBadDebt } = await loadPoolHealth({
        chainTimeSec,
        auctions: [{ borrower: BORROWER, kickTime: String(kickTimeSec) }],
      });

      const vault = makeVault();
      vault.getAuctionStatus.mockResolvedValue([kickTimeSec, 1n, 1n]);

      await expect(poolHasBadDebt(vault)).resolves.toBe(true);
      expect(vault.getAuctionStatus).toHaveBeenCalledExactlyOnceWith(BORROWER);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not flag collateralized active debt when chain time leaves the auction inside the cutoff even if Date.now would', async () => {
    const chainTimeSec = 1_700_000_100n;
    const dateNowSec = 1_700_000_900n;
    const kickTimeSec = 1_700_000_050n;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Number(dateNowSec) * 1000));
    try {
      const { poolHasBadDebt } = await loadPoolHealth({
        chainTimeSec,
        auctions: [{ borrower: BORROWER, kickTime: String(kickTimeSec) }],
      });

      const vault = makeVault();
      vault.getAuctionStatus.mockResolvedValue([kickTimeSec, 1n, 1n]);

      await expect(poolHasBadDebt(vault)).resolves.toBe(false);
      expect(vault.getAuctionStatus).toHaveBeenCalledExactlyOnceWith(BORROWER);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flags zero-collateral bad debt even when the auction is inside the cutoff', async () => {
    const chainTimeSec = 1_700_000_100n;
    const kickTimeSec = 1_700_000_050n;

    const { poolHasBadDebt } = await loadPoolHealth({
      chainTimeSec,
      auctions: [{ borrower: BORROWER, kickTime: String(kickTimeSec) }],
    });

    const vault = makeVault();
    vault.getAuctionStatus.mockResolvedValue([kickTimeSec, 0n, 1n]);

    await expect(poolHasBadDebt(vault)).resolves.toBe(true);
    expect(vault.getAuctionStatus).toHaveBeenCalledExactlyOnceWith(BORROWER);
  });

  it('uses onchain kickTime for the stale active debt cutoff', async () => {
    const chainTimeSec = 1_700_000_700n;
    const subgraphKickTimeSec = 1_700_000_000n;
    const onchainKickTimeSec = 1_700_000_650n;

    const { poolHasBadDebt } = await loadPoolHealth({
      chainTimeSec,
      auctions: [{ borrower: BORROWER, kickTime: String(subgraphKickTimeSec) }],
    });

    const vault = makeVault();
    vault.getAuctionStatus.mockResolvedValue([onchainKickTimeSec, 1n, 1n]);

    await expect(poolHasBadDebt(vault)).resolves.toBe(false);
    expect(vault.getAuctionStatus).toHaveBeenCalledExactlyOnceWith(BORROWER);
  });
});
