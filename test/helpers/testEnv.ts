import { beforeAll, beforeEach, afterAll } from 'vitest';
import { contract } from '../../src/utils/contract';
import { client } from '../../src/utils/client';
import { useMocks } from './vaultHelpers';
import type { Address } from 'viem';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const vaultAddr = (): Address => process.env.MOCK_VAULT_ADDRESS as Address;
export const authAddr = (): Address => process.env.MOCK_VAULT_AUTH_ADDRESS as Address;

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
