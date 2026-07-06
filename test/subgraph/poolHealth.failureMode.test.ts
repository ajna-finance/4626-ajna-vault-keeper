import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('graphql-request');
  vi.doUnmock('../../src/utils/env');
  vi.doUnmock('../../src/utils/config');
  vi.doUnmock('../../src/utils/logger');
  vi.doUnmock('../../src/utils/chainTime.ts');
});

const POOL_ADDRESS = '0x0000000000000000000000000000000000000001' as Address;
const VAULT_ADDRESS = '0x0000000000000000000000000000000000000002' as Address;

function makeVault() {
  return {
    getAddress: () => VAULT_ADDRESS,
    getPoolAddress: vi.fn().mockResolvedValue(POOL_ADDRESS),
    getAuctionStatus: vi.fn(),
  };
}

describe('subgraph failure handling', () => {
  it('fails closed by throwing SubgraphUnavailableError when exitOnSubgraphFailure is enabled', async () => {
    const cause = new Error('subgraph unavailable');
    const request = vi.fn().mockRejectedValue(cause);
    const error = vi.fn();
    const vault = makeVault();

    vi.doMock('graphql-request', () => ({
      gql: (strings: TemplateStringsArray) => strings[0] ?? '',
      request,
    }));
    vi.doMock('../../src/utils/env', () => ({
      env: { SUBGRAPH_URL: 'https://example.test/subgraph' },
    }));
    vi.doMock('../../src/utils/config', () => ({
      config: {
        keeper: { exitOnSubgraphFailure: true },
        arkGlobal: { maxAuctionAge: 259200 },
      },
    }));
    vi.doMock('../../src/utils/logger', () => ({
      log: { error, info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('../../src/utils/chainTime.ts', () => ({
      getChainTime: vi.fn().mockResolvedValue(0n),
    }));

    const { _getUnsettledAuctions, poolHasBadDebt, SubgraphUnavailableError } = await import(
      '../../src/subgraph/poolHealth'
    );

    const subgraphFailure = await _getUnsettledAuctions(vault).catch((e) => e);
    expect(subgraphFailure).toBeInstanceOf(SubgraphUnavailableError);
    expect((subgraphFailure as Error).cause).toBe(cause);

    await expect(poolHasBadDebt(vault)).rejects.toBeInstanceOf(SubgraphUnavailableError);
    expect(vault.getAuctionStatus).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'subgraph_query_failed', ark: VAULT_ADDRESS }),
      'subgraph query failed',
    );
  });

  it('keeps fail-open behavior available as an explicit opt-in', async () => {
    const request = vi.fn().mockRejectedValue(new Error('subgraph unavailable'));
    const vault = makeVault();

    vi.doMock('graphql-request', () => ({
      gql: (strings: TemplateStringsArray) => strings[0] ?? '',
      request,
    }));
    vi.doMock('../../src/utils/env', () => ({
      env: { SUBGRAPH_URL: 'https://example.test/subgraph' },
    }));
    vi.doMock('../../src/utils/config', () => ({
      config: {
        keeper: { exitOnSubgraphFailure: false },
        arkGlobal: { maxAuctionAge: 259200 },
      },
    }));
    vi.doMock('../../src/utils/logger', () => ({
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('../../src/utils/chainTime.ts', () => ({
      getChainTime: vi.fn().mockResolvedValue(0n),
    }));

    const { _getUnsettledAuctions, poolHasBadDebt } = await import('../../src/subgraph/poolHealth');

    await expect(_getUnsettledAuctions(vault)).resolves.toEqual({ liquidationAuctions: [] });
    await expect(poolHasBadDebt(vault)).resolves.toBe(false);
    expect(vault.getAuctionStatus).not.toHaveBeenCalled();
  });
});

describe('subgraph URL redaction in failure logs', () => {
  async function captureFailureLog(subgraphUrl: string): Promise<Record<string, unknown>> {
    const request = vi.fn().mockRejectedValue(new Error('subgraph unavailable'));
    const error = vi.fn();
    const vault = makeVault();

    vi.doMock('graphql-request', () => ({
      gql: (strings: TemplateStringsArray) => strings[0] ?? '',
      request,
    }));
    vi.doMock('../../src/utils/env', () => ({
      env: { SUBGRAPH_URL: subgraphUrl },
    }));
    vi.doMock('../../src/utils/config', () => ({
      config: {
        keeper: { exitOnSubgraphFailure: true },
        arkGlobal: { maxAuctionAge: 259200 },
      },
    }));
    vi.doMock('../../src/utils/logger', () => ({
      log: { error, info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('../../src/utils/chainTime.ts', () => ({
      getChainTime: vi.fn().mockResolvedValue(0n),
    }));

    const { _getUnsettledAuctions } = await import('../../src/subgraph/poolHealth');
    await _getUnsettledAuctions(vault).catch(() => undefined);

    expect(error).toHaveBeenCalledTimes(1);
    const [logFields] = error.mock.calls[0]!;
    return logFields as Record<string, unknown>;
  }

  it('strips an API key embedded in the URL path', async () => {
    const apiKey = 'deadbeefcafef00d1234567890abcdef';
    const logFields = await captureFailureLog(
      `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/QmAbc`,
    );

    expect(logFields).toMatchObject({
      event: 'subgraph_query_failed',
      subgraphOrigin: 'https://gateway.thegraph.com',
    });
    expect(logFields).not.toHaveProperty('url');
    expect(JSON.stringify(logFields)).not.toContain(apiKey);
  });

  it('strips an API key embedded in the query string', async () => {
    const apiKey = 'sk_live_supersecretkey_4242';
    const logFields = await captureFailureLog(
      `https://api.example.test/subgraph?api-key=${apiKey}`,
    );

    expect(logFields).toMatchObject({
      event: 'subgraph_query_failed',
      subgraphOrigin: 'https://api.example.test',
    });
    expect(JSON.stringify(logFields)).not.toContain(apiKey);
  });

  it('strips credentials embedded in the URL userinfo', async () => {
    const password = 'hunter2-correct-horse-battery';
    const logFields = await captureFailureLog(
      `https://user:${password}@subgraph.example.test/sub/v1`,
    );

    expect(logFields).toMatchObject({
      event: 'subgraph_query_failed',
      subgraphOrigin: 'https://subgraph.example.test',
    });
    expect(JSON.stringify(logFields)).not.toContain(password);
    expect(JSON.stringify(logFields)).not.toContain('user:');
  });

  it('omits the origin field without throwing when the URL cannot be parsed', async () => {
    const logFields = await captureFailureLog('not a real url with embedded-secret-xyz');

    expect(logFields).toMatchObject({ event: 'subgraph_query_failed' });
    expect(logFields.subgraphOrigin).toBeUndefined();
    expect(JSON.stringify(logFields)).not.toContain('embedded-secret-xyz');
  });
});
