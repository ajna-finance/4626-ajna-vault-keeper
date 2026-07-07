import type { Address } from 'viem';
import { config } from '../../utils/config';
import { type SwapExecutor, UnconfiguredSwapExecutor } from '../swapExecutor';
import { CowSwapExecutor } from './cow';
import type { SwapAdapterName } from './names';

// Compile-time adapter registry. Adapters are selected by NAME from config
// (recovery.swapExecutor.adapter) — config stays data, never code: there is no
// dynamic module loading, so nothing outside this reviewed set can ever run
// inside the process that holds the swapper key. Config validation already
// rejects unknown names at load time; the default throw is the fail-closed
// backstop for a name that slips past it.
export function createSwapExecutor(): SwapExecutor {
  const cfg = config.recovery.swapExecutor;
  if (!cfg) return new UnconfiguredSwapExecutor();

  let executor: SwapExecutor;
  switch (cfg.adapter as SwapAdapterName) {
    case 'cow':
      executor = new CowSwapExecutor({ apiBaseUrl: cfg.apiBaseUrl });
      break;
    default:
      throw new Error(`Unknown swap adapter '${cfg.adapter}'`);
  }

  return cfg.expectedSpender
    ? withPinnedSpender(executor, cfg.expectedSpender as Address, cfg.adapter)
    : executor;
}

// Operator-pinned spender allowlist: when recovery.swapExecutor.expectedSpender is
// set, the address the wallet approves collateral to must equal it exactly. This
// turns the keeper's spender sanity check into an independent allowlist — even a
// compromised adapter implementation cannot redirect the approval.
function withPinnedSpender(
  executor: SwapExecutor,
  expected: Address,
  adapter: string,
): SwapExecutor {
  return {
    getSpender(tokenIn: Address): Address {
      const spender = executor.getSpender(tokenIn);
      if (spender.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(
          `swap adapter '${adapter}' returned spender ${spender}, but recovery.swapExecutor.expectedSpender pins ${expected}`,
        );
      }
      return spender;
    },
    quoteExactIn: (input) => executor.quoteExactIn(input),
    executeExactIn: (input) => executor.executeExactIn(input),
  };
}
