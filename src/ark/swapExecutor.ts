import type { Address } from 'viem';

// UNITS CONTRACT — read before implementing an adapter.
//
// This interface deliberately mixes two decimal bases and the split is invisible
// with an 18-decimal quote token (WAD == native), so an adapter that guesses wrong
// works on DAI and then fails min-out on every swap the day it meets USDC:
//
// - `amountIn`, `expectedAmountOut`, `minAmountOut`, `amountOut` are RAW TOKEN UNITS
//   in the respective token's own decimals (straight from/for ERC20 transfer amounts).
// - `expectedQuoteOut` is a QUOTE-DENOMINATED WAD (1e18), NOT tokenOut native units.
//   It carries the vault's removedCollateralValue — the quote value the vault is owed.
//   Bot 3 enforces its value-loss threshold against this WAD figure itself; adapters
//   MUST NOT derive `minAmountOut` from it without rescaling by 10^(tokenOutDecimals-18).
// - `maxSlippageBps` / `maxValueLossBps` are basis points (1/10000).
// - `deadline` / `validUntil` are unix timestamps in seconds.
export type SwapQuoteRequest = {
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  // Raw tokenIn units (tokenIn decimals).
  amountIn: bigint;
  // Basis points. DEX execution slippage tolerance — enforced by the adapter.
  maxSlippageBps: number;
  // Basis points. Vault-value loss threshold — enforced by Bot 3, informational here.
  maxValueLossBps: number;
  // Quote-denominated WAD (1e18), not tokenOut native units. See UNITS CONTRACT above.
  expectedQuoteOut: bigint;
  recipient: Address;
  // Unix seconds.
  deadline: bigint;
};

export type SwapQuoteResult = {
  // Raw tokenOut units (tokenOut decimals).
  expectedAmountOut: bigint;
  // Raw tokenOut units (tokenOut decimals).
  minAmountOut: bigint;
  routeId: string;
  // Unix seconds.
  validUntil: bigint;
};

export type SwapExecutionRequest = SwapQuoteRequest & {
  priorTxHash?: `0x${string}`;
};

export type SwapExecutionResult = {
  // Raw tokenIn units (tokenIn decimals).
  amountIn: bigint;
  // Raw tokenOut units (tokenOut decimals).
  amountOut: bigint;
  // Raw tokenOut units (tokenOut decimals).
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
