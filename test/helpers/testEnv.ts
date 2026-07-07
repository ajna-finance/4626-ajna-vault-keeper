import { beforeAll, beforeEach, afterAll } from 'vitest';
import { contract } from '../../src/utils/contract';
import { client } from '../../src/utils/client';
import { config } from '../../src/utils/config';
import { useMocks } from './vaultHelpers';
import { encodeFunctionData, erc20Abi, type Address } from 'viem';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const vaultAddr = (): Address => process.env.MOCK_VAULT_ADDRESS as Address;
export const authAddr = (): Address => process.env.MOCK_VAULT_AUTH_ADDRESS as Address;
export const collateralTokenAddr = (): Address =>
  process.env.MOCK_COLLATERAL_TOKEN_ADDRESS as Address;

const MINT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_to', type: 'address' },
      { name: '_amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

// Mint mock collateral straight to an address (e.g. the swapper wallet, to stage a
// crashed-after-recoverCollateral resume).
export async function mintCollateral(to: Address, amount: bigint): Promise<void> {
  const hash = await client.writeContract({
    address: collateralTokenAddr(),
    abi: MINT_ABI,
    functionName: 'mint',
    args: [to, amount],
    chain: null,
    account: client.account,
  });
  await client.waitForTransactionReceipt({ hash });
}

// The quote token is real mainnet DAI on the fork, so funding a wallet with it means
// impersonating a holder — same whale and mechanism the global setup's
// fundTestAccount uses for the unit suites.
const DAI_WHALE = '0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf';

export async function fundWithQuoteToken(to: Address, amount: bigint): Promise<void> {
  await client.request({ method: 'anvil_impersonateAccount' as any, params: [DAI_WHALE] as any });
  await client.request({
    method: 'anvil_setBalance' as any,
    params: [DAI_WHALE, '0x1000000000000000000000'] as any,
  });
  const txHash = (await client.request({
    method: 'eth_sendTransaction' as any,
    params: [
      {
        from: DAI_WHALE,
        to: config.quoteTokenAddress,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
        gas: '0x186A0',
        maxFeePerGas: '0x77359400',
        maxPriorityFeePerGas: '0x3B9ACA00',
        value: '0x0',
      },
    ] as any,
  })) as `0x${string}`;
  await client.waitForTransactionReceipt({ hash: txHash });
  await client.request({
    method: 'anvil_stopImpersonatingAccount' as any,
    params: [DAI_WHALE] as any,
  });
}

// Minimal single-bucket setup — cheaper than the 18-bucket setMockState and
// sufficient for tests that only exercise detection / refill preconditions.
export async function addOneBucket(bucketIndex: bigint): Promise<void> {
  await contract('vault', vaultAddr())().write.addBucket(
    bucketIndex,
    1_000_000_000_000_000_000n,
    1_000_000_000_000_000_000n,
  );
}

// Registers beforeAll/beforeEach/afterAll hooks that snapshot the anvil fork before
// the suite runs and revert to that snapshot between every test. Keeps state fresh
// across tests without re-running the heavy deploy script per case.
export function useForkSnapshot(): void {
  let snapshot: string;

  beforeAll(async () => {
    useMocks();
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
  });

  beforeEach(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
  });

  afterAll(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
  });
}

// Resets the graphql-request mock between tests and defaults it to "no liquidation
// auctions", which is the shape the keeper expects for the happy path. The caller
// must have `vi.mock('graphql-request', ...)` at module scope and pass in the mocked
// `request` symbol.
export function useSubgraphMock(request: unknown): void {
  beforeEach(() => {
    const mock = request as { mockReset?: () => void; mockResolvedValue: (v: unknown) => void };
    mock.mockReset?.();
    mock.mockResolvedValue({ liquidationAuctions: [] });
  });
}
