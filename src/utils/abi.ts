import { vaultAbi } from '../abi/Vault';
import { mockVaultAbi } from '../../test/mocks/abi/MockVault.ts';
import { bufferAbi } from '../abi/Buffer.ts';
import { mockBufferAbi } from '../../test/mocks/abi/MockBuffer.ts';
import { chronicleAbi } from '../abi/Chronicle';
import { mockChronicleAbi } from '../../test/mocks/abi/MockChronicle.ts';
import { poolInfoUtilsAbi } from '../abi/PoolInfoUtils';
import { mockPoolInfoUtilsAbi } from '../../test/mocks/abi/MockPoolInfoUtils.ts';
import { vaultAuthAbi } from '../abi/VaultAuth';
import { mockVaultAuthAbi } from '../../test/mocks/abi/MockVaultAuth.ts';
import { poolAbi } from '../abi/Pool.ts';
import { mockPoolAbi } from '../../test/mocks/abi/MockPool.ts';
import type { Abi } from 'viem';

type Variant = { real: Abi; mock?: Abi };
type AbiEntry = Abi | Variant;

export const abis = {
  vault: { real: vaultAbi, mock: mockVaultAbi },
  vaultAuth: { real: vaultAuthAbi, mock: mockVaultAuthAbi },
  chronicle: { real: chronicleAbi, mock: mockChronicleAbi },
  buffer: { real: bufferAbi, mock: mockBufferAbi },
  poolInfoUtils: { real: poolInfoUtilsAbi, mock: mockPoolInfoUtilsAbi },
  pool: { real: poolAbi, mock: mockPoolAbi },
} as const satisfies Record<string, AbiEntry>;

export type ContractAbiKey = keyof typeof abis;

function pick(entry: AbiEntry): Abi {
  if (typeof (entry as Variant).real === 'object') {
    const v = entry as Variant;
    const useMock = process.env.USE_MOCKS === 'true';
    return useMock ? (v.mock ?? v.real) : v.real;
  }
  return entry as Abi;
}

export function getAbi<K extends ContractAbiKey>(name: K): Abi {
  return pick(abis[name]);
}
