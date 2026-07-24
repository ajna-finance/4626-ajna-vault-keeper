import { afterEach, describe, expect, it, vi } from 'vitest';

const NOW_SEC = 1_700_000_000;
const COLLATERAL = '0x1111111111111111111111111111111111111111';
const QUOTE = '0x2222222222222222222222222222222222222222';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/utils/env.ts');
});

function setup(responseBody: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_SEC * 1000));
  vi.doMock('../../src/utils/config.ts', () => ({
    DEFAULT_FUTURE_SKEW_TOLERANCE: 120,
    DEFAULT_OFFCHAIN_MAX_STALENESS: 86400,
    config: {
      quoteTokenAddress: QUOTE,
      collateralTokenAddress: COLLATERAL,
      oracle: {
        apiUrl: 'https://example.test',
        offchainMaxStaleness: 60,
        futureSkewTolerance: 120,
        requestTimeoutMs: 10000,
      },
    },
  }));
  vi.doMock('../../src/utils/env.ts', () => ({ env: {} }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => responseBody }));
}

// A quote price of exactly 1 makes quote-per-collateral equal to the collateral price,
// which lets these cases keep asserting the exact CoinGecko numeric literal end to end.
function body(collateralUsd: string, quoteUsd = '1', collateralUpdatedAt = NOW_SEC): string {
  return (
    `{"${COLLATERAL}":{"usd":${collateralUsd},"last_updated_at":${collateralUpdatedAt}},` +
    `"${QUOTE}":{"usd":${quoteUsd},"last_updated_at":${NOW_SEC}}}`
  );
}

describe('offchain oracle exact parsing', () => {
  it('preserves the exact CoinGecko numeric literal when parsing price', async () => {
    setup(body('0.999870478245824934'));
    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).resolves.toBe(999870478245824934n);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requestedUrl.searchParams.get('include_last_updated_at')).toBe('true');
    const requestInit = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(requestInit.signal).toBeInstanceOf(AbortSignal);
  });

  it('divides the two legs into a quote-per-collateral WAD price', async () => {
    setup(body('3', '2'));
    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).resolves.toBe(1_500_000_000_000_000_000n);
  });

  it('fails closed when the quote token price is zero', async () => {
    setup(body('1', '0'));
    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).rejects.toThrow('quote token price must be positive');
  });

  it('fails closed on scientific-notation literals from the network response', async () => {
    setup(body('1e100000000'));
    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).rejects.toThrow(
      'price is undefined or could not be parsed exactly',
    );
  });

  it('parses the token object structurally when extra metadata is present', async () => {
    setup(
      `{"${COLLATERAL}":{"meta":{"source":"cg"},"usd":0.999870478245824934,"last_updated_at":${NOW_SEC}},` +
        `"${QUOTE}":{"usd":1,"last_updated_at":${NOW_SEC}}}`,
    );
    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).resolves.toBe(999870478245824934n);
  });

  it('fails closed when CoinGecko returns the price as a JSON string', async () => {
    setup(body('"0.999870478245824934"'));
    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).rejects.toThrow(
      'price is undefined or could not be parsed exactly',
    );
  });

  it('fails closed when CoinGecko omits the freshness timestamp', async () => {
    setup(
      `{"${COLLATERAL}":{"usd":0.999870478245824934},"${QUOTE}":{"usd":1,"last_updated_at":${NOW_SEC}}}`,
    );
    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).rejects.toThrow(
      'price is undefined or could not be parsed exactly',
    );
  });

  it('fails closed when the offchain price is stale', async () => {
    setup(body('0.999870478245824934', '1', NOW_SEC - 61));
    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).rejects.toThrow('offchain oracle price is stale');
  });

  it('fails closed when the offchain timestamp is too far in the future', async () => {
    setup(body('0.999870478245824934', '1', NOW_SEC + 121));
    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).rejects.toThrow('offchain oracle price has future timestamp');
  });
});
