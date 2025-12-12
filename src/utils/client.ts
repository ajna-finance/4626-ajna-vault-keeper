import { createWalletClient, createPublicClient, http, publicActions, type Chain } from 'viem';
import * as allChains from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { env } from './env';

const account = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
const transport = process.env.TEST_ENV === 'true' ? 'http://127.0.0.1:8545' : env.RPC_URL;

// Helper: Find the matching chain definition or create a custom one
function getChain(chainId: number): Chain {
  // 1. Try to find a standard chain (Base, Mainnet, Optimism, etc.)
  for (const chain of Object.values(allChains)) {
    if ('id' in chain && chain.id === chainId) {
      return chain as Chain;
    }
  }

  // 2. If unknown, create a generic custom chain config
  console.log(`Unknown Chain ID ${chainId}, using custom configuration.`);
  return {
    id: chainId,
    name: 'Custom Chain',
    nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    rpcUrls: {
      default: { http: [env.RPC_URL as string] },
      public: { http: [env.RPC_URL as string] },
    },
  } as Chain;
}

// Select the chain dynamically based on .env
const targetChain = getChain(env.CHAIN_ID);

export const client = createWalletClient({
  account: account,
  chain: targetChain,
  transport: http(transport),
}).extend(publicActions);

export const readOnlyClient = createPublicClient({ 
  chain: targetChain, 
  transport: http(transport) 
});
