import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockConfig, signTypedData } = vi.hoisted(() => ({
  mockConfig: {
    chainId: 1,
    quoteTokenAddress: '0x6b175474e89094c44da98b954eedeac495271d0f',
    keeper: { logLevel: 'warn' },
    recovery: {} as { swapExecutor?: { adapter: string; apiBaseUrl?: string; expectedSpender?: string } },
  },
  signTypedData: vi.fn(async (_args: unknown) => '0xdeadbeefsignature'),
}));

vi.mock('../../src/utils/config', () => ({ config: mockConfig }));
vi.mock('../../src/utils/client', () => ({
  client: {
    account: { address: '0x00000000000000000000000000000000000000a1' },
    signTypedData,
  },
}));

import { CowSwapExecutor } from '../../src/ark/swapAdapters/cow';
import { createSwapExecutor } from '../../src/ark/swapAdapters';
import { UnconfiguredSwapExecutor, type SwapQuoteRequest } from '../../src/ark/swapExecutor';

const VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';
const SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';
const TOKEN_IN = '0x0000000000000000000000000000000000000c01' as `0x${string}`;
const TOKEN_OUT = '0x6b175474e89094c44da98b954eedeac495271d0f' as `0x${string}`;
const WALLET = '0x00000000000000000000000000000000000000a1' as `0x${string}`;

function baseRequest(overrides: Partial<SwapQuoteRequest> = {}): SwapQuoteRequest {
  return {
    chainId: 1,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn: 10n ** 18n,
    maxSlippageBps: 50,
    maxValueLossBps: 100,
    expectedQuoteOut: 10n ** 18n,
    recipient: WALLET,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    ...overrides,
  };
}

type Route = {
  match: (url: string, method: string) => boolean;
  respond: () => { status?: number; body: unknown };
};

function stubFetch(routes: Route[]) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    const route = routes.find((r) => r.match(url, method));
    if (!route) throw new Error(`no stub route for ${method} ${url}`);
    const { status = 200, body: responseBody } = route.respond();
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(responseBody),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

beforeEach(() => {
  mockConfig.chainId = 1;
  mockConfig.recovery = {};
  signTypedData.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CowSwapExecutor', () => {
  it('returns the GPv2 vault relayer as the spender', () => {
    const executor = new CowSwapExecutor();
    expect(executor.getSpender()).toBe(VAULT_RELAYER);
  });

  it('fails fast at construction for a chain with no known API endpoint', () => {
    mockConfig.chainId = 777;
    expect(() => new CowSwapExecutor()).toThrow('no CoW API endpoint known for chainId 777');
    expect(() => new CowSwapExecutor({ apiBaseUrl: 'https://example.test' })).not.toThrow();
  });

  it('quotes a sell and applies our slippage to minAmountOut', async () => {
    const { calls } = stubFetch([
      {
        match: (url, method) => url.endsWith('/api/v1/quote') && method === 'POST',
        respond: () => ({
          body: { quote: { sellAmount: '1000', buyAmount: '10000', validTo: 1234567890 }, id: 42 },
        }),
      },
    ]);

    const executor = new CowSwapExecutor();
    const result = await executor.quoteExactIn(baseRequest());

    expect(result.expectedAmountOut).toBe(10000n);
    // 50 bps off 10000
    expect(result.minAmountOut).toBe(9950n);
    expect(result.routeId).toBe('42');
    expect(result.validUntil).toBe(1234567890n);

    expect(calls[0]!.url).toBe('https://api.cow.fi/mainnet/api/v1/quote');
    expect(calls[0]!.body).toMatchObject({
      sellToken: TOKEN_IN,
      buyToken: TOKEN_OUT,
      receiver: WALLET,
      from: WALLET,
      kind: 'sell',
      sellAmountBeforeFee: (10n ** 18n).toString(),
    });
  });

  it('signs and places an order, polls to settlement, and returns the trade', async () => {
    const req = baseRequest();
    const statuses = ['open', 'fulfilled'];
    const { calls } = stubFetch([
      {
        match: (url, method) => url.endsWith('/api/v1/quote') && method === 'POST',
        respond: () => ({
          body: { quote: { sellAmount: '1000', buyAmount: '10000', validTo: 1234567890 } },
        }),
      },
      {
        match: (url, method) => url.endsWith('/api/v1/orders') && method === 'POST',
        respond: () => ({ body: 'order-uid-1' }),
      },
      {
        match: (url, method) => url.includes('/api/v1/orders/order-uid-1') && method === 'GET',
        respond: () => ({
          body: { status: statuses.shift() ?? 'fulfilled', executedBuyAmount: '10123' },
        }),
      },
      {
        match: (url, method) => url.includes('/api/v1/trades?orderUid=') && method === 'GET',
        respond: () => ({ body: [{ txHash: `0x${'cd'.repeat(32)}` }] }),
      },
    ]);

    const executor = new CowSwapExecutor({ pollIntervalMs: 1 });
    const result = await executor.executeExactIn(req);

    expect(result.amountOut).toBe(10123n);
    expect(result.minAmountOut).toBe(9950n);
    expect(result.routeId).toBe('order-uid-1');
    expect(result.txHash).toBe(`0x${'cd'.repeat(32)}`);
    expect(result.recipient).toBe(WALLET);

    // The signed order is the on-chain safety contract: limit = minAmountOut,
    // expiry = the keeper's deadline, receiver = the recovery wallet.
    expect(signTypedData).toHaveBeenCalledTimes(1);
    const signedArgs = signTypedData.mock.calls[0]![0] as unknown as {
      domain: { verifyingContract: string; chainId: number };
      message: Record<string, unknown>;
    };
    expect(signedArgs.domain.verifyingContract).toBe(SETTLEMENT);
    expect(signedArgs.domain.chainId).toBe(1);
    expect(signedArgs.message).toMatchObject({
      sellToken: TOKEN_IN,
      buyToken: TOKEN_OUT,
      receiver: WALLET,
      sellAmount: 10n ** 18n,
      buyAmount: 9950n,
      validTo: Number(req.deadline),
      kind: 'sell',
      partiallyFillable: false,
    });

    const orderPost = calls.find((c) => c.url.endsWith('/api/v1/orders'));
    expect(orderPost!.body).toMatchObject({
      buyAmount: '9950',
      feeAmount: '0',
      signingScheme: 'eip712',
      signature: '0xdeadbeefsignature',
      from: WALLET,
    });
  });

  it('throws when the order sits unfilled past validTo', async () => {
    // Deadline already in the past: the first poll is beyond validTo + grace.
    const req = baseRequest({ deadline: BigInt(Math.floor(Date.now() / 1000) - 120) });
    stubFetch([
      {
        match: (url, method) => url.endsWith('/api/v1/quote') && method === 'POST',
        respond: () => ({
          body: { quote: { sellAmount: '1000', buyAmount: '10000', validTo: 1234567890 } },
        }),
      },
      {
        match: (url, method) => url.endsWith('/api/v1/orders') && method === 'POST',
        respond: () => ({ body: 'order-uid-2' }),
      },
      {
        match: (url, method) => url.includes('/api/v1/orders/order-uid-2') && method === 'GET',
        respond: () => ({ body: { status: 'open' } }),
      },
    ]);

    const executor = new CowSwapExecutor({ pollIntervalMs: 1 });
    await expect(executor.executeExactIn(req)).rejects.toThrow('not filled by validTo');
  });

  it('throws when the order is cancelled or expired on the book', async () => {
    stubFetch([
      {
        match: (url, method) => url.endsWith('/api/v1/quote') && method === 'POST',
        respond: () => ({
          body: { quote: { sellAmount: '1000', buyAmount: '10000', validTo: 1234567890 } },
        }),
      },
      {
        match: (url, method) => url.endsWith('/api/v1/orders') && method === 'POST',
        respond: () => ({ body: 'order-uid-3' }),
      },
      {
        match: (url, method) => url.includes('/api/v1/orders/order-uid-3') && method === 'GET',
        respond: () => ({ body: { status: 'expired' } }),
      },
    ]);

    const executor = new CowSwapExecutor({ pollIntervalMs: 1 });
    await expect(executor.executeExactIn(baseRequest())).rejects.toThrow(
      'expired without filling',
    );
  });

  it('surfaces API errors with status and body', async () => {
    stubFetch([
      {
        match: (url, method) => url.endsWith('/api/v1/quote') && method === 'POST',
        respond: () => ({ status: 400, body: { errorType: 'NoLiquidity' } }),
      },
    ]);

    const executor = new CowSwapExecutor();
    await expect(executor.quoteExactIn(baseRequest())).rejects.toThrow('failed (400)');
  });

  it('rejects a deadline that does not fit uint32 validTo', async () => {
    const executor = new CowSwapExecutor();
    await expect(
      executor.executeExactIn(baseRequest({ deadline: 2n ** 33n })),
    ).rejects.toThrow('does not fit uint32');
  });
});

describe('createSwapExecutor registry', () => {
  it('returns the fail-closed UnconfiguredSwapExecutor when no adapter is configured', () => {
    expect(createSwapExecutor()).toBeInstanceOf(UnconfiguredSwapExecutor);
  });

  it("builds the CoW adapter for adapter: 'cow'", () => {
    mockConfig.recovery.swapExecutor = { adapter: 'cow' };
    const executor = createSwapExecutor();
    expect(executor.getSpender(TOKEN_IN)).toBe(VAULT_RELAYER);
  });

  it('fails closed on an unknown adapter name that slipped past config validation', () => {
    mockConfig.recovery.swapExecutor = { adapter: 'definitely-not-real' };
    expect(() => createSwapExecutor()).toThrow("Unknown swap adapter 'definitely-not-real'");
  });

  it('pins the spender when expectedSpender is configured', () => {
    mockConfig.recovery.swapExecutor = { adapter: 'cow', expectedSpender: VAULT_RELAYER };
    expect(createSwapExecutor().getSpender(TOKEN_IN)).toBe(VAULT_RELAYER);

    mockConfig.recovery.swapExecutor = {
      adapter: 'cow',
      expectedSpender: '0x0000000000000000000000000000000000000bad',
    };
    expect(() => createSwapExecutor().getSpender(TOKEN_IN)).toThrow(
      'expectedSpender pins 0x0000000000000000000000000000000000000bad',
    );
  });
});
