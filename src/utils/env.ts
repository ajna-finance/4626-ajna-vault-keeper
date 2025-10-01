import 'dotenv/config';

const REQUIRED = [
  'RPC_URL',
  'ORACLE_API_URL',
  'QUOTE_TOKEN_ADDRESS',
  'PRIVATE_KEY',
  'VAULT_ADDRESS',
  'VAULT_AUTH_ADDRESS',
  'OPTIMAL_BUCKET_DIFF',
  'KEEPER_INTERVAL_MS',
  'SUBGRAPH_URL',
] as const;

for (const key of REQUIRED) {
  if (!process.env[key]) {
    throw new Error(`${key} must be specified`);
  }
}

if (process.env.ORACLE_API_KEY && !process.env.ORACLE_API_TIER) {
  throw new Error('API key tier must be specified');
}

if (process.env.ONCHAIN_ORACLE_PRIMARY === 'true' && !process.env.ONCHAIN_ORACLE_ADDRESS) {
  throw new Error('oracle smart contract address must be specified');
}

const minAmount = process.env.MIN_MOVE_AMOUNT ?? 1000000;

// Defaults to 72 hours (seconds)
const minTimeSinceBankruptcy = process.env.MIN_TIME_SINCE_BANKRUPTCY ?? 259200;

// Defaults to 72 hours (seconds)
const maxAuctionAge = process.env.MAX_AUCTION_AGE ?? 259200;

export const env = {
  KEEPER_INTERVAL_MS: Number(process.env.KEEPER_INTERVAL_MS),
  VAULT_ADDRESS: process.env.VAULT_ADDRESS,
  VAULT_AUTH_ADDRESS: process.env.VAULT_AUTH_ADDRESS,
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  OPTIMAL_BUCKET_DIFF: BigInt(process.env.OPTIMAL_BUCKET_DIFF!),
  ORACLE_API_URL: process.env.ORACLE_API_URL,
  RPC_URL: process.env.RPC_URL,
  QUOTE_TOKEN_ADDRESS: process.env.QUOTE_TOKEN_ADDRESS!.toLowerCase(),
  CONFIRMATIONS: process.env.CONFIRMATIONS,
  MIN_MOVE_AMOUNT: BigInt(minAmount),
  ORACLE_API_KEY: process.env.ORACLE_API_KEY,
  ORACLE_API_TIER: process.env.ORACLE_API_TIER,
  ONCHAIN_ORACLE_PRIMARY: process.env.ONCHAIN_ORACLE_PRIMARY === 'true' ? true : false,
  ONCHAIN_ORACLE_ADDRESS: process.env.ONCHAIN_ORACLE_ADDRESS,
  ONCHAIN_ORACLE_MAX_STALENESS: process.env.ONCHAIN_ORACLE_MAX_STALENESS
    ? Number(process.env.ONCHAIN_ORACLE_MAX_STALENESS)
    : undefined,
  LOG_LEVEL: process.env.LOG_LEVEL,
  SUBGRAPH_URL: process.env.SUBGRAPH_URL,
  MIN_TIME_SINCE_BANKRUPTCY: BigInt(minTimeSinceBankruptcy),
  MAX_AUCTION_AGE: Number(maxAuctionAge),
};
