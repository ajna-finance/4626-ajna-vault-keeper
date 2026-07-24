import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('fs');
});

describe('config fixedPrice validation', () => {
  it('rejects numeric fixedPrice values to avoid precision loss', async () => {
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
          "fixedPrice": 0.999870478245824934
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
      'config.json: oracle.fixedPrice must be a string decimal to avoid precision loss',
    );
  });
});
