/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  getConfig,
  getExpectedSupplyAssets,
  getSupplyCap,
  getTotalExpectedSupplyAssets,
  reallocate,
  type MarketAllocation,
} from '../../src/metavault/metavault';
import { type Address, maxUint256 } from 'viem';
import { client } from '../../src/utils/client';
import { toWad } from '../../src/utils/decimalConversion';
import { handleTransaction } from '../../src/utils/transaction';

describe('metavault interface', () => {
  it('can read expectedSupplyAssets', async () => {
    const bufferAddress = process.env.AAVE_VAULT_ADDRESS as Address;
    const assets = await getExpectedSupplyAssets(bufferAddress);
    expect(500e18 - Number(assets)).toBeCloseTo(0);
  });

  it('can return total expected supply assets', async () => {
    const strategyAddresses: Address[] = [
      process.env.AAVE_VAULT_ADDRESS as Address,
      process.env.ARK_1_ADDRESS as Address,
      process.env.ARK_2_ADDRESS as Address,
      process.env.ARK_3_ADDRESS as Address,
    ];

    const totalAssets = await getTotalExpectedSupplyAssets(strategyAddresses);
    expect(500e18 - Number(totalAssets)).toBeCloseTo(0);
  });

  it('can read market config', async () => {
    const bufferAddress = process.env.AAVE_VAULT_ADDRESS as Address;
    const config = await getConfig(bufferAddress);
    expect(Object.keys(config)).toStrictEqual(['balance', 'cap', 'enabled', 'removableAt']);
  });

  it('can return supply cap', async () => {
    const bufferAddress = process.env.AAVE_VAULT_ADDRESS as Address;
    const bufferCap = await getSupplyCap(bufferAddress);
    expect(bufferCap).toBe(87112285931760246646623899502532662132735n);
  });
});

describe('reallocate', () => {
  let snapshot: string;

  beforeAll(async () => {
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
  });

  afterAll(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
  });

  beforeEach(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
  });

  it('can reallocate all funds from one vault to another', async () => {
    const bufferAddress = process.env.AAVE_VAULT_ADDRESS as Address;
    const arkAddress = process.env.ARK_1_ADDRESS as Address;

    const allocations: MarketAllocation[] = [
      {
        id: bufferAddress,
        assets: 0n,
      },
      {
        id: arkAddress,
        assets: maxUint256,
      },
    ];

    await handleTransaction(reallocate(allocations, 5000000n), {
      action: 'reallocate',
      allocations,
    });

    const arkBalance = await getExpectedSupplyAssets(arkAddress);
    const bufferBalance = await getExpectedSupplyAssets(bufferAddress);

    expect((Number(arkBalance) - 500e18) / 1e18).toBeCloseTo(0);
    expect(bufferBalance).toBe(0n);
  });

  it('can reallocate specific amounts between vaults', async () => {
    const bufferAddress = process.env.AAVE_VAULT_ADDRESS as Address;
    const ark1Address = process.env.ARK_1_ADDRESS as Address;
    const ark2Address = process.env.ARK_2_ADDRESS as Address;
    const ark3Address = process.env.ARK_3_ADDRESS as Address;

    const allocations: MarketAllocation[] = [
      {
        id: bufferAddress,
        assets: toWad(400n, 0),
      },
      {
        id: ark1Address,
        assets: toWad(45n, 0),
      },
      {
        id: ark2Address,
        assets: toWad(35n, 0),
      },
      {
        id: ark3Address,
        assets: maxUint256,
      },
    ];

    await handleTransaction(reallocate(allocations, 5000000n), {
      action: 'reallocate',
      allocations,
    });

    const bufferBalance = await getExpectedSupplyAssets(bufferAddress);
    const ark1Balance = await getExpectedSupplyAssets(ark1Address);
    const ark2Balance = await getExpectedSupplyAssets(ark2Address);
    const ark3Balance = await getExpectedSupplyAssets(ark3Address);

    expect(Number(bufferBalance) / 1e18).toBe(400);
    expect(ark1Balance).toBe(45000000000000000000n);
    expect(ark2Balance).toBe(35000000000000000000n);
    expect(Number(ark3Balance) / 1e18).toBeCloseTo(20);
  });
});
