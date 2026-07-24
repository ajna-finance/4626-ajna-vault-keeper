import { vaultAbi } from '../abi/Vault.ts';
import { bufferAbi } from '../abi/Buffer.ts';
import { chronicleAbi } from '../abi/Chronicle.ts';
import { poolInfoUtilsAbi } from '../abi/PoolInfoUtils.ts';
import { vaultAuthAbi } from '../abi/VaultAuth.ts';
import { poolAbi } from '../abi/Pool.ts';
import { eulerEarnAbi } from '../abi/EulerEarn.ts';
import { mockVaultAbi } from '../abi/mock/MockVault.ts';
import { mockBufferAbi } from '../abi/mock/MockBuffer.ts';
import { mockChronicleAbi } from '../abi/mock/MockChronicle.ts';
import { mockPoolInfoUtilsAbi } from '../abi/mock/MockPoolInfoUtils.ts';
import { mockVaultAuthAbi } from '../abi/mock/MockVaultAuth.ts';
import { mockPoolAbi } from '../abi/mock/MockPool.ts';
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
  metavault: { real: eulerEarnAbi, mock: eulerEarnAbi },
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
