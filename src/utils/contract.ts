import { getContract, type Address } from 'viem';
import { client } from './client';
import { getAbi, type ContractAbiKey } from './abi';
import { getAddress, type ContractAddressKey } from './address';

/* eslint-disable @typescript-eslint/no-explicit-any */

const isOpts = (x: any) =>
  !!x &&
  typeof x === 'object' &&
  !Array.isArray(x) &&
  ('account' in x ||
    'chain' in x ||
    'gas' in x ||
    'gasPrice' in x ||
    'maxFeePerGas' in x ||
    'maxPriorityFeePerGas' in x ||
    'nonce' in x ||
    'blockNumber' in x ||
    'blockTag' in x);

export function contract<K extends ContractAbiKey & ContractAddressKey>(name: K) {
  let memo: { addr?: Address; env?: 'real' | 'mock' } = {};
  const envKey = () => (process.env.USE_MOCKS === 'true' ? 'mock' : 'real');

  const getAddr = async (): Promise<Address> => {
    const k = envKey();
    if (memo.addr && memo.env === k) return memo.addr!;
    const a = (await getAddress(name)) as Address;
    memo = { addr: a, env: k };
    return a;
  };

  const make = async () =>
    getContract({
      address: await getAddr(),
      abi: getAbi(name),
      client,
    });

  const forward = (kind: 'read' | 'write' | 'simulate') =>
    new Proxy(
      {},
      {
        get:
          (_t, fn: string) =>
          async (...args: any[]) => {
            const c = await make();

            if (args.length === 0) {
              // @ts-expect-error dynamic dispatch
              return c[kind][fn]();
            }

            if (Array.isArray(args[0])) {
              const [params, opts] = args as [any[], any?];
              // @ts-expect-error dynamic dispatch
              return opts !== undefined ? c[kind][fn](params, opts) : c[kind][fn](params);
            }

            if (args.length === 1 && isOpts(args[0])) {
              // @ts-expect-error dynamic dispatch
              return c[kind][fn]([], args[0]);
            }

            const last = args[args.length - 1];
            const hasOpts = isOpts(last);
            const params = hasOpts ? args.slice(0, -1) : args;
            const opts = hasOpts ? last : undefined;

            // @ts-expect-error dynamic dispatch
            return opts !== undefined ? c[kind][fn](params, opts) : c[kind][fn](params);
          },
      },
    );

  return () =>
    ({
      read: forward('read'),
      write: forward('write'),
      simulate: forward('simulate'),
    }) as any;
}
