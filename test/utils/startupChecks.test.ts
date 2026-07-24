import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const METAVAULT = '0x000000000000000000000000000000000000aaaa';
const BUFFER = '0x000000000000000000000000000000000000bbbb';
const ARK_1 = '0x000000000000000000000000000000000000cccc';
const VAULT_AUTH_1 = '0x000000000000000000000000000000000000dddd';
const QUOTE_TOKEN = '0x000000000000000000000000000000000000eeee';
const KEEPER_ADDRESS = '0x000000000000000000000000000000000000ffff';

type MetavaultStub = {
  asset: () => string;
  owner: () => string;
  curator: () => string;
  isAllocator: (caller: string) => boolean;
  config: Record<string, { balance: bigint; cap: bigint; enabled: boolean; removableAt: bigint }>;
};

type ContractCall = (...args: unknown[]) => unknown;

function buildContractMock(opts: {
  metavault: MetavaultStub;
  bufferRatioByAuth: Record<string, bigint>;
  taxByAuth: Record<string, bigint>;
  tollByAuth: Record<string, bigint>;
}) {
  return (name: string, address: string) => {
    if (name === 'metavault') {
      return () => ({
        read: {
          asset: (() => opts.metavault.asset()) as ContractCall,
          owner: (() => opts.metavault.owner()) as ContractCall,
          curator: (() => opts.metavault.curator()) as ContractCall,
          isAllocator: ((args: unknown[]) =>
            opts.metavault.isAllocator(args[0] as string)) as ContractCall,
          config: ((args: unknown[]) => {
            const id = (args[0] as string).toLowerCase();
            const entry = opts.metavault.config[id];
            if (!entry) {
              throw new Error(`mock: missing strategy config for ${id}`);
            }
            return entry;
          }) as ContractCall,
        },
      });
    }
    if (name === 'vaultAuth') {
      return () => ({
        read: {
          bufferRatio: (() => opts.bufferRatioByAuth[address.toLowerCase()] ?? 0n) as ContractCall,
          tax: (() => opts.taxByAuth[address.toLowerCase()] ?? 0n) as ContractCall,
          toll: (() => opts.tollByAuth[address.toLowerCase()] ?? 0n) as ContractCall,
        },
      });
    }
    throw new Error(`mock: unexpected contract '${name}'`);
  };
}

function configWithMetavault() {
  return {
    chainId: 1,
    quoteTokenAddress: QUOTE_TOKEN,
    metavaultAddress: METAVAULT,
    buffer: { address: BUFFER, allocation: 40 },
    arks: [
      {
        address: ARK_1,
        vaultAddress: ARK_1,
        vaultAuthAddress: VAULT_AUTH_1,
      },
    ],
  };
}

function strategyEntries(
  overrides: Partial<MetavaultStub['config']> = {},
): MetavaultStub['config'] {
  return {
    [BUFFER]: { balance: 0n, cap: 1n, enabled: true, removableAt: 0n },
    [ARK_1]: { balance: 0n, cap: 1n, enabled: true, removableAt: 0n },
    ...overrides,
  };
}

async function loadStartupChecks(opts: {
  configOverrides?: Record<string, unknown>;
  chainId?: number;
  metavault?: Partial<MetavaultStub>;
  bufferRatioByAuth?: Record<string, bigint>;
  taxByAuth?: Record<string, bigint>;
  tollByAuth?: Record<string, bigint>;
  poolCollateralByVault?: Record<string, string>;
  authByVault?: Record<string, string>;
}) {
  const cfg = { ...configWithMetavault(), ...opts.configOverrides };
  const cfgArks = cfg.arks as Array<{ vaultAddress: string; vaultAuthAddress: string }>;
  const authByVault = {
    ...Object.fromEntries(cfgArks.map((a) => [a.vaultAddress.toLowerCase(), a.vaultAuthAddress])),
    ...opts.authByVault,
  };

  const metavault: MetavaultStub = {
    asset: () => QUOTE_TOKEN,
    owner: () => '0x0000000000000000000000000000000000000099',
    curator: () => '0x0000000000000000000000000000000000000098',
    isAllocator: () => true,
    config: strategyEntries(),
    ...opts.metavault,
  };

  vi.doMock('../../src/utils/config.ts', () => ({
    config: cfg,
    resolveArkSettings: (ark: { collateralTokenAddress?: string }) => ({
      oracle: {
        collateralTokenAddress: ark.collateralTokenAddress,
        onchainCollateralAddress: undefined,
        fixedPrice: null,
      },
    }),
  }));
  vi.doMock('../../src/utils/client.ts', () => ({
    client: { account: { address: KEEPER_ADDRESS } },
    readOnlyClient: { getChainId: async () => opts.chainId ?? 1 },
  }));
  vi.doMock('../../src/utils/contract.ts', () => ({
    contract: buildContractMock({
      metavault,
      bufferRatioByAuth: opts.bufferRatioByAuth ?? {},
      taxByAuth: opts.taxByAuth ?? {},
      tollByAuth: opts.tollByAuth ?? {},
    }),
  }));
  vi.doMock('../../src/utils/logger.ts', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
  vi.doMock('../../src/ark/vault.ts', () => ({
    createVault: (address: string) => ({
      getAuthAddress: async () => {
        const auth = authByVault[address.toLowerCase()];
        if (!auth) throw new Error(`mock: missing vault AUTH for ${address}`);
        return auth;
      },
      getCollateralAddress: async () => {
        const collateral = opts.poolCollateralByVault?.[address.toLowerCase()];
        if (!collateral) throw new Error(`mock: missing pool collateral for ${address}`);
        return collateral;
      },
    }),
  }));

  const { runStartupChecks } = await import('../../src/utils/startupChecks.ts');
  return runStartupChecks;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/utils/client.ts');
  vi.doUnmock('../../src/utils/contract.ts');
  vi.doUnmock('../../src/utils/logger.ts');
  vi.doUnmock('../../src/ark/vault.ts');
});

describe('runStartupChecks: chain id', () => {
  it('passes when the RPC chain id matches config', async () => {
    const run = await loadStartupChecks({ chainId: 1 });
    await expect(run()).resolves.toBeUndefined();
  });

  it('throws when the RPC chain id does not match config', async () => {
    const run = await loadStartupChecks({ chainId: 10 });
    await expect(run()).rejects.toThrow(
      'chain id mismatch: config.chainId is 1 but RPC reports 10',
    );
  });

  it('skips metavault checks when no metavaultAddress is set', async () => {
    const run = await loadStartupChecks({
      chainId: 1,
      configOverrides: {
        metavaultAddress: undefined,
        arks: [],
        buffer: { address: BUFFER, allocation: 0 },
      },
    });
    await expect(run()).resolves.toBeUndefined();
  });
});

describe('runStartupChecks: metavault asset and authorization', () => {
  it('throws when the metavault asset does not match quoteTokenAddress', async () => {
    const run = await loadStartupChecks({
      metavault: { asset: () => '0x000000000000000000000000000000000000feed' },
    });
    await expect(run()).rejects.toThrow(
      'metavault asset (0x000000000000000000000000000000000000feed) does not match config.quoteTokenAddress',
    );
  });

  it('throws when keeper is neither allocator, curator, nor owner', async () => {
    const run = await loadStartupChecks({
      metavault: {
        isAllocator: () => false,
        owner: () => '0x0000000000000000000000000000000000000099',
        curator: () => '0x0000000000000000000000000000000000000098',
      },
    });
    await expect(run()).rejects.toThrow(
      `keeper account ${KEEPER_ADDRESS} is not authorized to allocate on metavault ${METAVAULT}`,
    );
  });

  it('accepts when keeper is the owner even if not in the allocator list', async () => {
    const run = await loadStartupChecks({
      metavault: {
        isAllocator: () => false,
        owner: () => KEEPER_ADDRESS,
      },
    });
    await expect(run()).resolves.toBeUndefined();
  });

  it('accepts when keeper is the curator even if not in the allocator list', async () => {
    const run = await loadStartupChecks({
      metavault: {
        isAllocator: () => false,
        curator: () => KEEPER_ADDRESS,
      },
    });
    await expect(run()).resolves.toBeUndefined();
  });
});

describe('runStartupChecks: strategy enablement and caps', () => {
  it('throws when a configured ark strategy is not enabled in the metavault', async () => {
    const run = await loadStartupChecks({
      metavault: {
        config: strategyEntries({
          [ARK_1]: { balance: 0n, cap: 1n, enabled: false, removableAt: 0n },
        }),
      },
    });
    await expect(run()).rejects.toThrow(`metavault strategy for arks[0] (${ARK_1}) is not enabled`);
  });

  it('throws when the buffer strategy is not enabled', async () => {
    const run = await loadStartupChecks({
      metavault: {
        config: strategyEntries({
          [BUFFER]: { balance: 0n, cap: 1n, enabled: false, removableAt: 0n },
        }),
      },
    });
    await expect(run()).rejects.toThrow(`metavault strategy for buffer (${BUFFER}) is not enabled`);
  });

  it('throws when a configured strategy has a zero supply cap', async () => {
    const run = await loadStartupChecks({
      metavault: {
        config: strategyEntries({
          [ARK_1]: { balance: 0n, cap: 0n, enabled: true, removableAt: 0n },
        }),
      },
    });
    await expect(run()).rejects.toThrow(
      `metavault strategy for arks[0] (${ARK_1}) has zero supply cap`,
    );
  });
});

describe('runStartupChecks: managed ark buffer ratio', () => {
  it('throws when a managed ark has a non-zero buffer ratio', async () => {
    const run = await loadStartupChecks({
      bufferRatioByAuth: { [VAULT_AUTH_1]: 500n },
    });
    await expect(run()).rejects.toThrow(
      `metavault-managed arks[0] (${ARK_1}) has non-zero bufferRatio 500`,
    );
  });

  it('passes when the managed ark has a zero buffer ratio', async () => {
    const run = await loadStartupChecks({
      bufferRatioByAuth: { [VAULT_AUTH_1]: 0n },
    });
    await expect(run()).resolves.toBeUndefined();
  });
});

describe('runStartupChecks: managed ark fees', () => {
  it('throws when a managed ark has a non-zero tax', async () => {
    const run = await loadStartupChecks({
      taxByAuth: { [VAULT_AUTH_1]: 50n },
    });
    await expect(run()).rejects.toThrow(`metavault-managed arks[0] (${ARK_1}) has non-zero tax 50`);
  });

  it('throws when a managed ark has a non-zero toll', async () => {
    const run = await loadStartupChecks({
      tollByAuth: { [VAULT_AUTH_1]: 50n },
    });
    await expect(run()).rejects.toThrow(
      `metavault-managed arks[0] (${ARK_1}) has non-zero toll 50`,
    );
  });

  it('passes when tax and toll are both zero', async () => {
    const run = await loadStartupChecks({
      taxByAuth: { [VAULT_AUTH_1]: 0n },
      tollByAuth: { [VAULT_AUTH_1]: 0n },
    });
    await expect(run()).resolves.toBeUndefined();
  });
});

// Regression (PR19-D03): nothing verified that a configured collateral token actually matches
// the ARK pool's collateral, so a mispointed oracle configuration could price a pool with
// another market's feed. Startup now binds each ARK's resolved collateral to its pool.
describe('runStartupChecks: ark collateral binding', () => {
  const COLLATERAL = '0x0000000000000000000000000000000000001111';
  const OTHER_COLLATERAL = '0x0000000000000000000000000000000000002222';

  it('passes when the configured collateral matches the pool collateral', async () => {
    const runStartupChecks = await loadStartupChecks({
      configOverrides: {
        arks: [
          {
            address: ARK_1,
            vaultAddress: ARK_1,
            vaultAuthAddress: VAULT_AUTH_1,
            collateralTokenAddress: COLLATERAL,
          },
        ],
      },
      poolCollateralByVault: { [ARK_1.toLowerCase()]: COLLATERAL },
    });

    await expect(runStartupChecks()).resolves.toBeUndefined();
  });

  it('throws when the configured collateral does not match the pool collateral', async () => {
    const runStartupChecks = await loadStartupChecks({
      configOverrides: {
        arks: [
          {
            address: ARK_1,
            vaultAddress: ARK_1,
            vaultAuthAddress: VAULT_AUTH_1,
            collateralTokenAddress: COLLATERAL,
          },
        ],
      },
      poolCollateralByVault: { [ARK_1.toLowerCase()]: OTHER_COLLATERAL },
    });

    await expect(runStartupChecks()).rejects.toThrow(
      'does not match its configured collateralTokenAddress',
    );
  });

  it('skips the binding check for arks without a resolvable collateral token', async () => {
    const runStartupChecks = await loadStartupChecks({});

    await expect(runStartupChecks()).resolves.toBeUndefined();
  });
});

// The configured vaultAuthAddress is where the keeper reads bufferRatio/tax/toll policy from,
// but the Vault enforces its own immutable AUTH. If the two diverge, startup validates the
// zero-fee invariants against the wrong contract while the real AUTH's fees silently apply to
// every reallocate. Startup must bind the configured address to the vault's actual AUTH.
describe('runStartupChecks: ark auth binding', () => {
  it('throws when the configured vaultAuthAddress does not match the vault AUTH', async () => {
    const runStartupChecks = await loadStartupChecks({
      authByVault: { [ARK_1.toLowerCase()]: '0x0000000000000000000000000000000000009999' },
    });

    await expect(runStartupChecks()).rejects.toThrow(
      'does not match its configured vaultAuthAddress',
    );
  });

  it('passes when the configured vaultAuthAddress matches the vault AUTH', async () => {
    const runStartupChecks = await loadStartupChecks({});

    await expect(runStartupChecks()).resolves.toBeUndefined();
  });
});
