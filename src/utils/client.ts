import { createWalletClient, createPublicClient, http, publicActions } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { env } from './env';

const account = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
const transport = process.env.TEST_ENV === 'true' ? 'http://127.0.0.1:8545' : env.RPC_URL;

export const client = createWalletClient({
  account: account,
  chain: mainnet,
  transport: http(transport),
}).extend(publicActions);

export const readOnlyClient = createPublicClient({ chain: mainnet, transport: http(transport) });
