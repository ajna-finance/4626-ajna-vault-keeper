import { client } from '../../utils/client.ts';
import { config } from '../../utils/config.ts';
import { fromWad, toWad } from '../../utils/decimalConversion.ts';
import { erc20Abi, type Address } from 'viem';

type VaultLike = {
  getPoolAddress: () => Promise<Address>;
  getAssetDecimals: () => Promise<number>;
  getPoolEscrowedQuote: () => Promise<bigint>;
};

async function getAvailablePoolBalanceWad(vault: VaultLike): Promise<bigint> {
  const [poolAddress, escrowed, assetDecimals] = await Promise.all([
    vault.getPoolAddress(),
    vault.getPoolEscrowedQuote(),
    vault.getAssetDecimals(),
  ]);
  const poolBalance = await client.readContract({
    address: config.quoteTokenAddress as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [poolAddress],
  });
  const poolBalanceWad = toWad(poolBalance as bigint, assetDecimals);
  return poolBalanceWad > escrowed ? poolBalanceWad - escrowed : 0n;
}

export async function poolBalanceCapAsset(
  initialAmount: bigint,
  vault: VaultLike,
): Promise<bigint> {
  if (process.env.INTEGRATION_TEST === 'true') return initialAmount;
  const [availableWad, assetDecimals] = await Promise.all([
    getAvailablePoolBalanceWad(vault),
    vault.getAssetDecimals(),
  ]);
  const available = fromWad(availableWad, assetDecimals);
  return initialAmount > available ? available : initialAmount;
}

export async function poolBalanceCapWad(initialAmount: bigint, vault: VaultLike): Promise<bigint> {
  if (process.env.INTEGRATION_TEST === 'true') return initialAmount;
  const available = await getAvailablePoolBalanceWad(vault);
  return initialAmount > available ? available : initialAmount;
}
