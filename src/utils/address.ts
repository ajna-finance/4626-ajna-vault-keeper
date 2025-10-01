import type { Address } from 'viem';

type StaticTuple = readonly [string | undefined, string | undefined];
type DynamicResolver = () => Promise<Address>;

export const contracts = {
  vault: [process.env.VAULT_ADDRESS, process.env.MOCK_VAULT_ADDRESS] as StaticTuple,
  vaultAuth: [process.env.VAULT_AUTH_ADDRESS, process.env.MOCK_VAULT_AUTH_ADDRESS] as StaticTuple,
  chronicle: [
    process.env.ONCHAIN_ORACLE_ADDRESS,
    process.env.MOCK_CHRONICLE_ADDRESS,
  ] as StaticTuple,
  buffer: (async () => (await import('../vault/vault')).getBufferAddress()) as DynamicResolver,
  poolInfoUtils: (async () =>
    (await import('../vault/vault')).getPoolInfoUtilsAddress()) as DynamicResolver,
  pool: (async () => (await import('../vault/vault')).getPoolAddress()) as DynamicResolver,
} as const;

export type ContractAddressKey = keyof typeof contracts;

export async function getAddress(name: ContractAddressKey): Promise<Address> {
  const entry = contracts[name];
  if (typeof entry === 'function') {
    return (entry as DynamicResolver)();
  }

  const idx = process.env.USE_MOCKS === 'true' ? 1 : 0;
  const addr = (entry as StaticTuple)[idx];
  if (!addr) throw new Error(`Missing ${name} address`);
  return addr as Address;
}
