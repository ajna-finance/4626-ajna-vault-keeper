import { client } from '../../utils/client.ts';
import { config } from '../../utils/config.ts';
import { toWad } from '../../utils/decimalConversion.ts';
import { erc20Abi, type Address } from 'viem';

type VaultLike = { getPoolAddress: () => Promise<Address> };
type WadVaultLike = VaultLike & { getAssetDecimals: () => Promise<number> };

async function getPoolBalance(vault: VaultLike) {
  const poolAddress = await vault.getPoolAddress();
  return client.readContract({
    address: config.quoteTokenAddress as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [poolAddress],
  });
}

export async function poolBalanceCapAsset(
  initialAmount: bigint,
  vault: VaultLike,
): Promise<bigint> {
  if (process.env.INTEGRATION_TEST) return initialAmount;
  const poolBalance = await getPoolBalance(vault);
  return initialAmount > poolBalance ? poolBalance : initialAmount;
}

export async function poolBalanceCapWad(
  initialAmount: bigint,
  vault: WadVaultLike,
): Promise<bigint> {
  if (process.env.INTEGRATION_TEST) return initialAmount;
  const [poolBalance, assetDecimals] = await Promise.all([
    getPoolBalance(vault),
    vault.getAssetDecimals(),
  ]);
  const poolBalanceWad = toWad(poolBalance, assetDecimals);
  return initialAmount > poolBalanceWad ? poolBalanceWad : initialAmount;
}
