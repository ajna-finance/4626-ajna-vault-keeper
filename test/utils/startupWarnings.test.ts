import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/utils/env.ts');
  vi.doUnmock('../../src/utils/logger.ts');
});

function mockEnv(overrides: { credentialMode?: string; env?: Record<string, unknown> } = {}): void {
  vi.doMock('../../src/utils/env.ts', () => ({
    credentialMode: overrides.credentialMode ?? 'privateKey',
    env: {
      RPC_URL: 'https://rpc.example',
      PRIVATE_KEY: '0xabc123',
      KEYSTORE_PATH: undefined,
      REMOTE_SIGNER_URL: undefined,
      REMOTE_SIGNER_ADDRESS: undefined,
      REMOTE_SIGNER_ALLOW_INSECURE: false,
      REMOTE_SIGNER_AUTH_TOKEN: undefined,
      ORACLE_API_KEY: undefined,
      ORACLE_API_TIER: undefined,
      ...overrides.env,
    },
  }));
}

describe('logStartupWarnings', () => {
  it('emits warnings for stale-check disabling and fixed-price mode', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        arks: [],
        keeper: {},
        oracle: {
          onchainCollateralAddress: '0x0000000000000000000000000000000000000002',
          onchainQuoteAddress: '0x0000000000000000000000000000000000000003',
          onchainPrimary: true,
          onchainMaxStaleness: null,
          fixedPrice: '1.00',
        },
      },
    }));
    mockEnv();
    vi.doMock('../../src/utils/logger.ts', () => ({
      startupNoticeLog: { warn },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ event: 'oracle_staleness_check_disabled' }),
      expect.stringContaining('staleness checking is disabled'),
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ event: 'oracle_fixed_price_enabled', rawPrice: '1.00' }),
      expect.stringContaining('fixed-price mode is enabled'),
    );
  });

  it('does not emit startup warnings for the safe live-oracle path', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        arks: [],
        keeper: {},
        oracle: {
          onchainPrimary: true,
          onchainMaxStaleness: 86400,
          fixedPrice: null,
        },
      },
    }));
    mockEnv();
    vi.doMock('../../src/utils/logger.ts', () => ({
      startupNoticeLog: { warn },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when an offchain-primary setup disables staleness checks on its onchain fallback', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        arks: [],
        keeper: {},
        oracle: {
          onchainCollateralAddress: '0x0000000000000000000000000000000000000002',
          onchainQuoteAddress: '0x0000000000000000000000000000000000000003',
          onchainPrimary: false,
          onchainMaxStaleness: null,
          fixedPrice: null,
        },
      },
    }));
    mockEnv();
    vi.doMock('../../src/utils/logger.ts', () => ({
      startupNoticeLog: { warn },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'oracle_staleness_check_disabled',
        onchainCollateralAddress: '0x0000000000000000000000000000000000000002',
        onchainPrimary: false,
      }),
      expect.stringContaining('staleness checking is disabled'),
    );
  });

  it('still emits startup notices when the main logger is configured at error level', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        arks: [],
        keeper: {
          logLevel: 'error',
        },
        oracle: {
          onchainPrimary: true,
          onchainMaxStaleness: 86400,
          fixedPrice: '1.00',
        },
      },
    }));
    mockEnv();
    vi.doMock('../../src/utils/logger.ts', () => ({
      startupNoticeLog: { warn },
      log: { error: vi.fn(), warn: vi.fn() },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'oracle_fixed_price_enabled' }),
      expect.stringContaining('fixed-price mode is enabled'),
    );
  });

  it('warns when the remote signer URL is http and REMOTE_SIGNER_ALLOW_INSECURE is set', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        arks: [],
        keeper: {},
        oracle: {
          onchainPrimary: true,
          onchainMaxStaleness: 86400,
          fixedPrice: null,
        },
      },
    }));
    mockEnv({
      credentialMode: 'remoteSigner',
      env: {
        REMOTE_SIGNER_URL: 'http://signer.example',
        REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
        REMOTE_SIGNER_ALLOW_INSECURE: true,
      },
    });
    vi.doMock('../../src/utils/logger.ts', () => ({
      startupNoticeLog: { warn },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'remote_signer_insecure_transport', tokenExposed: false }),
      expect.stringContaining('plaintext http'),
    );
  });

  it('warns that the bearer token is exposed when REMOTE_SIGNER_AUTH_TOKEN is set with http', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        arks: [],
        keeper: {},
        oracle: {
          onchainPrimary: true,
          onchainMaxStaleness: 86400,
          fixedPrice: null,
        },
      },
    }));
    mockEnv({
      credentialMode: 'remoteSigner',
      env: {
        REMOTE_SIGNER_URL: 'http://signer.example',
        REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
        REMOTE_SIGNER_ALLOW_INSECURE: true,
        REMOTE_SIGNER_AUTH_TOKEN: 'tok',
      },
    });
    vi.doMock('../../src/utils/logger.ts', () => ({
      startupNoticeLog: { warn },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'remote_signer_insecure_transport', tokenExposed: true }),
      expect.stringContaining('bearer token'),
    );
  });

  it('warns when the oracle denomination is degenerate (collateral equals quote)', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        arks: [],
        keeper: {},
        quoteTokenAddress: '0x0000000000000000000000000000000000000004',
        collateralTokenAddress: '0x0000000000000000000000000000000000000004',
        oracle: {
          onchainCollateralAddress: '0x0000000000000000000000000000000000000005',
          onchainQuoteAddress: '0x0000000000000000000000000000000000000005',
          onchainPrimary: true,
          onchainMaxStaleness: 86400,
          fixedPrice: null,
        },
      },
    }));
    mockEnv();
    vi.doMock('../../src/utils/logger.ts', () => ({
      startupNoticeLog: { warn },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'oracle_denomination_degenerate', source: 'offchain' }),
      expect.stringContaining('constant 1.0'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'oracle_denomination_degenerate', source: 'onchain' }),
      expect.stringContaining('constant 1.0'),
    );
  });
});

// Regression (PR19-D03 follow-up): the per-ARK oracle overrides must receive the same startup
// notices as the global values, or a degenerate per-ARK feed pair or per-ARK fixed price would
// boot without any operator-visible warning.
describe('logStartupWarnings per-ark oracle overrides', () => {
  const ARK = '0x00000000000000000000000000000000000000c1';

  function mockConfigWithArk(ark: Record<string, unknown>): void {
    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        arks: [{ vaultAddress: ARK, ...ark }],
        quoteTokenAddress: '0x0000000000000000000000000000000000000004',
        keeper: {},
        oracle: {
          onchainQuoteAddress: '0x0000000000000000000000000000000000000005',
          onchainPrimary: true,
          onchainMaxStaleness: 86400,
          fixedPrice: null,
        },
      },
    }));
  }

  it('warns when a per-ark collateral token equals the quote token', async () => {
    const warn = vi.fn();
    mockConfigWithArk({ collateralTokenAddress: '0x0000000000000000000000000000000000000004' });
    mockEnv();
    vi.doMock('../../src/utils/logger.ts', () => ({ startupNoticeLog: { warn } }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');
    logStartupWarnings();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'oracle_denomination_degenerate',
        source: 'offchain',
        ark: ARK,
      }),
      expect.stringContaining('constant 1.0'),
    );
  });

  it('warns when a per-ark collateral feed equals the quote feed', async () => {
    const warn = vi.fn();
    mockConfigWithArk({ onchainCollateralAddress: '0x0000000000000000000000000000000000000005' });
    mockEnv();
    vi.doMock('../../src/utils/logger.ts', () => ({ startupNoticeLog: { warn } }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');
    logStartupWarnings();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'oracle_denomination_degenerate',
        source: 'onchain',
        ark: ARK,
      }),
      expect.stringContaining('constant 1.0'),
    );
  });

  it('warns when a per-ark fixed price is set while the global fixed price is null', async () => {
    const warn = vi.fn();
    mockConfigWithArk({ fixedPrice: '2.50' });
    mockEnv();
    vi.doMock('../../src/utils/logger.ts', () => ({ startupNoticeLog: { warn } }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');
    logStartupWarnings();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'oracle_fixed_price_enabled',
        rawPrice: '2.50',
        ark: ARK,
      }),
      expect.stringContaining('for this ark'),
    );
  });

  it('does not duplicate warnings for arks that only inherit the global values', async () => {
    const warn = vi.fn();
    mockConfigWithArk({});
    mockEnv();
    vi.doMock('../../src/utils/logger.ts', () => ({ startupNoticeLog: { warn } }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');
    logStartupWarnings();

    expect(warn).not.toHaveBeenCalled();
  });
});
