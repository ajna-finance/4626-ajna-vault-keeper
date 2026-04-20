import type { Address } from 'viem';

export type SwapQuoteRequest = {
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  maxSlippageBps: number;
  maxValueLossBps: number;
  expectedQuoteOut: bigint;
  recipient: Address;
  deadline: bigint;
};

export type SwapQuoteResult = {
  expectedAmountOut: bigint;
  minAmountOut: bigint;
  routeId: string;
  validUntil: bigint;
};

export type SwapExecutionRequest = SwapQuoteRequest & {
  priorTxHash?: `0x${string}`;
};

export type SwapExecutionResult = {
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  txHash: `0x${string}`;
  routeId: string;
  recipient: Address;
};

export interface SwapExecutor {
  // Address that must hold an ERC20 allowance from the bot wallet to pull `tokenIn`.
  // Adapter-specific: could be the router, the executor contract, or the adapter itself.
  // Returning the bot wallet itself is a bug — self-approval is a no-op.
  getSpender(tokenIn: Address): Address;
  quoteExactIn(input: SwapQuoteRequest): Promise<SwapQuoteResult>;
  executeExactIn(input: SwapExecutionRequest): Promise<SwapExecutionResult>;
}

// Scaffold implementation — concrete Bot 1 adapter lives in a separate repo.
// This is the placeholder recoveryKeeper instantiates when no real adapter is configured.
// It throws on any call, making misconfiguration loud.
export class UnconfiguredSwapExecutor implements SwapExecutor {
  getSpender(): Address {
    throw new Error(
      'SwapExecutor not configured. Recovery-auto / recovery-oneshot modes require a real SwapExecutor implementation (Bot 1 adapter).',
    );
  }
  async quoteExactIn(): Promise<SwapQuoteResult> {
    throw new Error(
      'SwapExecutor not configured. Recovery-auto / recovery-oneshot modes require a real SwapExecutor implementation (Bot 1 adapter).',
    );
  }
  async executeExactIn(): Promise<SwapExecutionResult> {
    throw new Error(
      'SwapExecutor not configured. Recovery-auto / recovery-oneshot modes require a real SwapExecutor implementation (Bot 1 adapter).',
    );
  }
}
