import { keccak256, stringToBytes, type Address } from 'viem';
import { client } from '../../utils/client';
import { config } from '../../utils/config';
import { log } from '../../utils/logger';
import type {
  SwapExecutionRequest,
  SwapExecutionResult,
  SwapExecutor,
  SwapQuoteRequest,
  SwapQuoteResult,
} from '../swapExecutor';

// CoW Protocol adapter. Deliberately a minimal in-repo client (viem signing +
// fetch) instead of the CoW SDK: the safety of a CoW swap is enforced on-chain by
// the signed order limit, so the only thing the SDK would add here is dependency
// surface. The hosted orderbook API is a LIVENESS dependency, not a safety one —
// a compromised API can at worst refuse quotes or delay settlement; it cannot make
// the settlement contract fill below the signed buyAmount, pull more than the
// signed sellAmount, or fill after validTo.
//
// Mapping to the SwapExecutor contract:
// - getSpender  -> GPv2VaultRelayer (a fixed, audited constant — deployed at the
//                  same deterministic address on every supported chain)
// - quoteExactIn -> POST /api/v1/quote; minAmountOut = buyAmount minus our own
//                  maxSlippageBps (CoW's quote already nets fees into the price)
// - executeExactIn -> sign a sell order (EIP-712) with buyAmount = minAmountOut
//                  and validTo = deadline, POST /api/v1/orders, then poll until
//                  fulfilled or expiry. An expired order can never fill later, so
//                  throwing on expiry leaves the state machine free to re-quote on
//                  the next tick without a double-fill risk.

const GPV2_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as Address;
const GPV2_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as Address;

const API_BASE_BY_CHAIN: Record<number, string> = {
  1: 'https://api.cow.fi/mainnet',
  100: 'https://api.cow.fi/xdai',
  8453: 'https://api.cow.fi/base',
  42161: 'https://api.cow.fi/arbitrum_one',
  11155111: 'https://api.cow.fi/sepolia',
};

// Hash-only appData skips the orderbook's app-data document schema entirely; the
// signed struct only ever carries the hash.
const APP_DATA_HASH = keccak256(stringToBytes('{}'));

const ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
} as const;

const UINT32_MAX = 4_294_967_295n;

type CowQuoteResponse = {
  quote: {
    sellAmount: string;
    buyAmount: string;
    validTo: number;
  };
  id?: number | string | null;
};

type CowOrderStatus = {
  status: 'presignaturePending' | 'open' | 'fulfilled' | 'cancelled' | 'expired';
  executedBuyAmount?: string;
  executedSellAmount?: string;
};

export type CowSwapExecutorOptions = {
  apiBaseUrl?: string | undefined;
  // Test seam; production polls every 5s, well inside a 300s default deadline.
  pollIntervalMs?: number | undefined;
};

export class CowSwapExecutor implements SwapExecutor {
  private readonly apiBase: string;
  private readonly pollIntervalMs: number;

  constructor(opts: CowSwapExecutorOptions = {}) {
    const base = opts.apiBaseUrl ?? API_BASE_BY_CHAIN[config.chainId];
    if (!base) {
      throw new Error(
        `CowSwapExecutor: no CoW API endpoint known for chainId ${config.chainId}; set recovery.swapExecutor.apiBaseUrl`,
      );
    }
    this.apiBase = base.replace(/\/$/, '');
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
  }

  getSpender(): Address {
    return GPV2_VAULT_RELAYER;
  }

  async quoteExactIn(input: SwapQuoteRequest): Promise<SwapQuoteResult> {
    const { quote, id } = await this.fetchQuote(input);
    const expectedAmountOut = BigInt(quote.buyAmount);
    return {
      expectedAmountOut,
      minAmountOut: applySlippage(expectedAmountOut, input.maxSlippageBps),
      routeId: id == null ? 'cow' : String(id),
      validUntil: BigInt(quote.validTo),
    };
  }

  async executeExactIn(input: SwapExecutionRequest): Promise<SwapExecutionResult> {
    if (input.deadline > UINT32_MAX) {
      throw new Error(`CowSwapExecutor: deadline ${input.deadline} does not fit uint32 validTo`);
    }

    // Fresh quote at execution time; the signed limit below is what actually binds.
    const { quote } = await this.fetchQuote(input);
    const minAmountOut = applySlippage(BigInt(quote.buyAmount), input.maxSlippageBps);
    const validTo = Number(input.deadline);

    const order = {
      sellToken: input.tokenIn,
      buyToken: input.tokenOut,
      receiver: input.recipient,
      sellAmount: input.amountIn,
      buyAmount: minAmountOut,
      validTo,
      appData: APP_DATA_HASH,
      feeAmount: 0n,
      kind: 'sell',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    } as const;

    const signature = await client.signTypedData({
      account: client.account,
      domain: {
        name: 'Gnosis Protocol',
        version: 'v2',
        chainId: input.chainId,
        verifyingContract: GPV2_SETTLEMENT,
      },
      types: ORDER_TYPES,
      primaryType: 'Order',
      message: order,
    });

    const orderUid = (await this.post('/api/v1/orders', {
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      receiver: order.receiver,
      sellAmount: order.sellAmount.toString(),
      buyAmount: order.buyAmount.toString(),
      validTo,
      appData: APP_DATA_HASH,
      feeAmount: '0',
      kind: 'sell',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
      signingScheme: 'eip712',
      signature,
      from: client.account.address,
    })) as string;

    log.info(
      { event: 'cow_order_placed', orderUid, validTo, minAmountOut },
      'CoW order placed; awaiting settlement',
    );

    const settled = await this.waitForSettlement(orderUid, validTo);
    const txHash = await this.settlementTxHash(orderUid);

    return {
      amountIn: input.amountIn,
      amountOut: BigInt(settled.executedBuyAmount ?? '0'),
      minAmountOut,
      txHash,
      routeId: orderUid,
      recipient: input.recipient,
    };
  }

  private async fetchQuote(input: SwapQuoteRequest): Promise<CowQuoteResponse> {
    return (await this.post('/api/v1/quote', {
      sellToken: input.tokenIn,
      buyToken: input.tokenOut,
      receiver: input.recipient,
      from: client.account.address,
      kind: 'sell',
      sellAmountBeforeFee: input.amountIn.toString(),
      signingScheme: 'eip712',
    })) as CowQuoteResponse;
  }

  // Poll until the order leaves the book. An order that reaches validTo without
  // filling can never fill afterwards, so "expired" is a terminal, re-quotable
  // failure — the keeper resumes at RECOVERED on the next tick.
  private async waitForSettlement(orderUid: string, validTo: number): Promise<CowOrderStatus> {
    const graceMs = 30_000;
    const deadlineMs = validTo * 1000 + graceMs;
    for (;;) {
      const order = (await this.get(`/api/v1/orders/${orderUid}`)) as CowOrderStatus;
      if (order.status === 'fulfilled') return order;
      if (order.status === 'cancelled' || order.status === 'expired') {
        throw new Error(`CowSwapExecutor: order ${orderUid} ${order.status} without filling`);
      }
      if (Date.now() > deadlineMs) {
        throw new Error(`CowSwapExecutor: order ${orderUid} not filled by validTo ${validTo}`);
      }
      await sleep(this.pollIntervalMs);
    }
  }

  private async settlementTxHash(orderUid: string): Promise<`0x${string}`> {
    const trades = (await this.get(`/api/v1/trades?orderUid=${orderUid}`)) as Array<{
      txHash?: `0x${string}` | null;
    }>;
    const txHash = trades?.[0]?.txHash;
    if (!txHash) {
      throw new Error(`CowSwapExecutor: no settlement trade found for order ${orderUid}`);
    }
    return txHash;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async get(path: string): Promise<unknown> {
    return this.request(path, { method: 'GET' });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.apiBase}${path}`, init);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`CowSwapExecutor: ${init.method} ${path} failed (${res.status}): ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

function applySlippage(amount: bigint, maxSlippageBps: number): bigint {
  return (amount * BigInt(10000 - maxSlippageBps)) / 10000n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
