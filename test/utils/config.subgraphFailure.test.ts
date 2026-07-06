import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('fs');
});

describe('config exitOnSubgraphFailure handling', () => {
  it('defaults exitOnSubgraphFailure to true when the field is omitted', async () => {
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
          "onchainAddress": "0x0000000000000000000000000000000000000002",
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
    expect(config.keeper.exitOnSubgraphFailure).toBe(true);
  });

  it('preserves an explicit false fail-open override', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => `{
        "chainId": 1,
        "quoteTokenAddress": "0x0000000000000000000000000000000000000001",
        "keeper": {
          "intervalMs": 1,
          "haltIfLupBelowHtp": true,
          "exitOnSubgraphFailure": false
        },
        "oracle": {
          "onchainPrimary": true,
          "onchainAddress": "0x0000000000000000000000000000000000000002",
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
    expect(config.keeper.exitOnSubgraphFailure).toBe(false);
  });
});
