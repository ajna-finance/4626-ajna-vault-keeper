import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('fs');
});

describe('config onchainMaxStaleness handling', () => {
  it('defaults onchainMaxStaleness when onchainPrimary is enabled and the field is omitted', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => `{
        "chainId": 1,
        "quoteTokenAddress": "0x0000000000000000000000000000000000000001",
        "keeper": {
          "intervalMs": 1,
          "haltIfLupBelowHtp": true
        },
        "oracle": {
          "onchainPrimary": true,
          "onchainCollateralAddress": "0x0000000000000000000000000000000000000002",
          "onchainQuoteAddress": "0x0000000000000000000000000000000000000002",
          "fixedPrice": null
        },
        "arkGlobal": {},
        "transaction": {
          "confirmations": 1
        },
        "arks": [],
        "buffer": {
          "address": "0x0000000000000000000000000000000000000003",
          "allocation": 0
        },
        "minRateDiff": 10
      }`,
    }));

    const { config } = await import('../../src/utils/config.ts');
    expect(config.oracle.onchainMaxStaleness).toBe(86400);
  });

  it('defaults onchainMaxStaleness when offchain-primary mode still configures an onchain fallback', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => `{
        "chainId": 1,
        "quoteTokenAddress": "0x0000000000000000000000000000000000000001",
        "collateralTokenAddress": "0x0000000000000000000000000000000000000001",
        "keeper": {
          "intervalMs": 1,
          "haltIfLupBelowHtp": true
        },
        "oracle": {
          "apiUrl": "https://example.test",
          "onchainPrimary": false,
          "onchainCollateralAddress": "0x0000000000000000000000000000000000000002",
          "onchainQuoteAddress": "0x0000000000000000000000000000000000000002",
          "fixedPrice": null
        },
        "arkGlobal": {},
        "transaction": {
          "confirmations": 1
        },
        "arks": [],
        "buffer": {
          "address": "0x0000000000000000000000000000000000000003",
          "allocation": 0
        },
        "minRateDiff": 10
      }`,
    }));

    const { config } = await import('../../src/utils/config.ts');
    expect(config.oracle.onchainMaxStaleness).toBe(86400);
  });

  it('preserves an explicit null staleness override', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => `{
        "chainId": 1,
        "quoteTokenAddress": "0x0000000000000000000000000000000000000001",
        "keeper": {
          "intervalMs": 1,
          "haltIfLupBelowHtp": true
        },
        "oracle": {
          "onchainPrimary": true,
          "onchainCollateralAddress": "0x0000000000000000000000000000000000000002",
          "onchainQuoteAddress": "0x0000000000000000000000000000000000000002",
          "onchainMaxStaleness": null,
          "fixedPrice": null
        },
        "arkGlobal": {},
        "transaction": {
          "confirmations": 1
        },
        "arks": [],
        "buffer": {
          "address": "0x0000000000000000000000000000000000000003",
          "allocation": 0
        },
        "minRateDiff": 10
      }`,
    }));

    const { config } = await import('../../src/utils/config.ts');
    expect(config.oracle.onchainMaxStaleness).toBeNull();
  });

  it('rejects non-positive onchainMaxStaleness values', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => `{
        "chainId": 1,
        "quoteTokenAddress": "0x0000000000000000000000000000000000000001",
        "keeper": {
          "intervalMs": 1,
          "haltIfLupBelowHtp": true
        },
        "oracle": {
          "onchainPrimary": true,
          "onchainCollateralAddress": "0x0000000000000000000000000000000000000002",
          "onchainQuoteAddress": "0x0000000000000000000000000000000000000002",
          "onchainMaxStaleness": 0,
          "fixedPrice": null
        },
        "arkGlobal": {},
        "transaction": {
          "confirmations": 1
        },
        "arks": [],
        "buffer": {
          "address": "0x0000000000000000000000000000000000000003",
          "allocation": 0
        },
        "minRateDiff": 10
      }`,
    }));

    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: oracle.onchainMaxStaleness must be a positive integer or null',
    );
  });
});
