import type { Address } from 'viem';
import { config } from './config.ts';

type StaticTuple = readonly [string | undefined, string | undefined];

export const contracts = {
  chronicleCollateral: [
    config.oracle.onchainCollateralAddress,
    process.env.MOCK_CHRONICLE_ADDRESS,
  ] as StaticTuple,
  chronicleQuote: [
    config.oracle.onchainQuoteAddress,
    process.env.MOCK_CHRONICLE_QUOTE_ADDRESS ?? process.env.MOCK_CHRONICLE_ADDRESS,
  ] as StaticTuple,
  metavault: [config.metavaultAddress, config.metavaultAddress] as StaticTuple,
} as const;

export type ContractAddressKey = keyof typeof contracts;

export async function getAddress(name: ContractAddressKey, override?: Address): Promise<Address> {
  const entry = contracts[name] as StaticTuple;
  const useMocks = process.env.USE_MOCKS === 'true';
  const addr = useMocks ? entry[1] : (override ?? entry[0]);
  if (!addr) throw new Error(`Missing ${name} address`);
  return addr as Address;
}
