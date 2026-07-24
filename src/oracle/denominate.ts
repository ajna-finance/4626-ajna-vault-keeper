import { AJNA_PRICE_WAD } from '../ajna/constants.ts';

export function quotePerCollateralWad(collateralWad: bigint, quoteWad: bigint): bigint {
  if (quoteWad <= 0n) throw new Error('quote token price must be positive');
  return (collateralWad * AJNA_PRICE_WAD) / quoteWad;
}
