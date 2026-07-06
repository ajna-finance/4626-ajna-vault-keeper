import { afterEach, describe, expect, it, vi } from 'vitest';

const NOW_SEC = 1_700_000_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/utils/env.ts');
});

describe('offchain oracle exact parsing', () => {
  it('preserves the exact CoinGecko numeric literal when parsing price', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SEC * 1000));
    vi.doMock('../../src/utils/config.ts', () => ({
      DEFAULT_FUTURE_SKEW_TOLERANCE: 120,
      DEFAULT_OFFCHAIN_MAX_STALENESS: 86400,
      config: {
        quoteTokenAddress: '0xabc',
        oracle: {
          apiUrl: 'https://example.test',
          offchainMaxStaleness: 60,
          futureSkewTolerance: 120,
        },
      },
    }));
    vi.doMock('../../src/utils/env.ts', () => ({ env: {} }));
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `{"0xabc":{"usd":0.999870478245824934,"last_updated_at":${NOW_SEC}}}`,
    });
    vi.stubGlobal('fetch', fetch);

    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).resolves.toBe('0.999870478245824934');
    const requestedUrl = new URL(fetch.mock.calls[0]![0] as string);
    expect(requestedUrl.searchParams.get('include_last_updated_at')).toBe('true');
  });

  it('fails closed on scientific-notation literals from the network response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SEC * 1000));
    vi.doMock('../../src/utils/config.ts', () => ({
      DEFAULT_FUTURE_SKEW_TOLERANCE: 120,
      DEFAULT_OFFCHAIN_MAX_STALENESS: 86400,
      config: {
        quoteTokenAddress: '0xabc',
        oracle: {
          apiUrl: 'https://example.test',
          offchainMaxStaleness: 60,
          futureSkewTolerance: 120,
        },
      },
    }));
    vi.doMock('../../src/utils/env.ts', () => ({ env: {} }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => `{"0xabc":{"usd":1e100000000,"last_updated_at":${NOW_SEC}}}`,
      }),
    );

    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).rejects.toThrow(
      'price is undefined or could not be parsed exactly',
    );
  });

  it('parses the token object structurally when extra metadata is present', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SEC * 1000));
    vi.doMock('../../src/utils/config.ts', () => ({
      DEFAULT_FUTURE_SKEW_TOLERANCE: 120,
      DEFAULT_OFFCHAIN_MAX_STALENESS: 86400,
      config: {
        quoteTokenAddress: '0xabc',
        oracle: {
          apiUrl: 'https://example.test',
          offchainMaxStaleness: 60,
          futureSkewTolerance: 120,
        },
      },
    }));
    vi.doMock('../../src/utils/env.ts', () => ({ env: {} }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          `{"0xabc":{"meta":{"source":"cg"},"usd":0.999870478245824934,"last_updated_at":${NOW_SEC}}}`,
      }),
    );

    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).resolves.toBe('0.999870478245824934');
  });

  it('fails closed when CoinGecko returns the price as a JSON string', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SEC * 1000));
    vi.doMock('../../src/utils/config.ts', () => ({
      DEFAULT_FUTURE_SKEW_TOLERANCE: 120,
      DEFAULT_OFFCHAIN_MAX_STALENESS: 86400,
      config: {
        quoteTokenAddress: '0xabc',
        oracle: {
          apiUrl: 'https://example.test',
          offchainMaxStaleness: 60,
          futureSkewTolerance: 120,
        },
      },
    }));
    vi.doMock('../../src/utils/env.ts', () => ({ env: {} }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => `{"0xabc":{"usd":"0.999870478245824934","last_updated_at":${NOW_SEC}}}`,
      }),
    );

    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).rejects.toThrow(
      'price is undefined or could not be parsed exactly',
    );
  });

  it('fails closed when CoinGecko omits the freshness timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SEC * 1000));
    vi.doMock('../../src/utils/config.ts', () => ({
      DEFAULT_FUTURE_SKEW_TOLERANCE: 120,
      DEFAULT_OFFCHAIN_MAX_STALENESS: 86400,
      config: {
        quoteTokenAddress: '0xabc',
        oracle: {
          apiUrl: 'https://example.test',
          offchainMaxStaleness: 60,
          futureSkewTolerance: 120,
        },
      },
    }));
    vi.doMock('../../src/utils/env.ts', () => ({ env: {} }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{"0xabc":{"usd":0.999870478245824934}}',
      }),
    );

    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).rejects.toThrow(
      'price is undefined or could not be parsed exactly',
    );
  });

  it('fails closed when the offchain price is stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SEC * 1000));
    vi.doMock('../../src/utils/config.ts', () => ({
      DEFAULT_FUTURE_SKEW_TOLERANCE: 120,
      DEFAULT_OFFCHAIN_MAX_STALENESS: 86400,
      config: {
        quoteTokenAddress: '0xabc',
        oracle: {
          apiUrl: 'https://example.test',
          offchainMaxStaleness: 60,
          futureSkewTolerance: 120,
        },
      },
    }));
    vi.doMock('../../src/utils/env.ts', () => ({ env: {} }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          `{"0xabc":{"usd":0.999870478245824934,"last_updated_at":${NOW_SEC - 61}}}`,
      }),
    );

    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).rejects.toThrow('offchain oracle price is stale');
  });

  it('fails closed when the offchain timestamp is too far in the future', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SEC * 1000));
    vi.doMock('../../src/utils/config.ts', () => ({
      DEFAULT_FUTURE_SKEW_TOLERANCE: 120,
      DEFAULT_OFFCHAIN_MAX_STALENESS: 86400,
      config: {
        quoteTokenAddress: '0xabc',
        oracle: {
          apiUrl: 'https://example.test',
          offchainMaxStaleness: 60,
          futureSkewTolerance: 120,
        },
      },
    }));
    vi.doMock('../../src/utils/env.ts', () => ({ env: {} }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          `{"0xabc":{"usd":0.999870478245824934,"last_updated_at":${NOW_SEC + 121}}}`,
      }),
    );

    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).rejects.toThrow('offchain oracle price has future timestamp');
  });
});
