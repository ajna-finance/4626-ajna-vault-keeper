import { env } from '../utils/env';

type OffchainPriceResponse = Record<string, { [currency: string]: number }>;

const tier = env.ORACLE_API_TIER ?? 'none';
const key = env.ORACLE_API_KEY ?? '';

const headers: Record<string, string> = {
  accept: 'application/json',
  ...(tier === 'demo' && key && { 'x-cg-demo-api-key': key }),
  ...(tier === 'pro' && key && { 'x-cg-pro-api-key': key }),
};

export async function getOffchainPrice(): Promise<number> {
  const address = env.QUOTE_TOKEN_ADDRESS;

  const res = await fetch(env.ORACLE_API_URL as string, { method: 'GET', headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = (await res.json()) as OffchainPriceResponse;
  const price = json[address]?.usd;
  if (price === undefined) throw new Error('price is undefined');

  return price;
}
