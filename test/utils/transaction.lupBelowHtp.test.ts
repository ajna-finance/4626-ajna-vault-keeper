import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const hash = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const ark = '0x00000000000000000000000000000000000000a1' as Address;
const selector = '0x444507e1' as const;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/client.ts');
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/keepers/arkKeeper.ts');
});

describe('wait LUPBelowHTP detection', () => {
  it.each([
    ['cause.cause.data', { cause: { cause: { data: selector } } }],
    ['cause.data', { cause: { data: selector } }],
    ['data', { data: selector }],
    ['decoded.errorName', { decoded: { errorName: 'LUPBelowHTP' } }],
  ])('halts the current ark when revert data is surfaced via %s', async (_label, revertError) => {
    const haltKeeper = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        metavaultAddress: '0x00000000000000000000000000000000000000e5',
        transaction: { confirmations: 1 },
        keeper: { haltIfLupBelowHtp: true },
        oracle: {
          onchainCollateralAddress: '0x00000000000000000000000000000000000000f6',
          onchainQuoteAddress: '0x00000000000000000000000000000000000000f6',
        },
        defaultGas: 0n,
        gasBuffer: 0n,
      },
    }));
    vi.doMock('../../src/keepers/arkKeeper.ts', () => ({ haltKeeper }));
    vi.doMock('../../src/utils/client.ts', () => ({
      client: {
        waitForTransactionReceipt: vi
          .fn()
          .mockResolvedValue({ status: 'reverted', blockNumber: 1n }),
        getTransaction: vi.fn().mockResolvedValue({
          to: '0x00000000000000000000000000000000000000c3',
          from: '0x00000000000000000000000000000000000000d4',
          input: '0xdeadbeef',
        }),
        call: vi.fn().mockRejectedValue(revertError),
      },
    }));

    const { wait } = await import('../../src/utils/transaction.ts');

    await expect(wait(hash, { ark })).rejects.toThrow('LUPBelowHTP');
    expect(haltKeeper).toHaveBeenCalledWith(ark);
  });
});
