import { getAssetDecimals } from '../vault/vault';

export function toWad(rawValue: bigint, assetDecimals: number): bigint {
  const decimals = BigInt(assetDecimals);

  if (decimals === 18n) {
    return rawValue;
  } else if (decimals < 18n) {
    return rawValue * 10n ** (18n - decimals);
  } else {
    return rawValue / 10n ** (decimals - 18n);
  }
}

export async function toAsset(rawValue: number): Promise<bigint> {
  const assetDecimals = await getAssetDecimals();
  return BigInt(rawValue * 10 ** assetDecimals);
}
