import { env } from '../utils/env.ts';
import { config } from '../utils/config.ts';

const tier = env.ORACLE_API_TIER ?? 'none';
const key = env.ORACLE_API_KEY ?? '';
const MAX_OFFCHAIN_PRICE_LITERAL_LENGTH = 64;
const DECIMAL_PRICE_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const INTEGER_LITERAL = /^(?:0|[1-9]\d*)$/;

type JsonParseReviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { source?: string },
) => unknown;

class RawJsonNumber {
  constructor(readonly source: string) {}
}

const headers: Record<string, string> = {
  accept: 'application/json',
  ...(tier === 'demo' && key && { 'x-cg-demo-api-key': key }),
  ...(tier === 'pro' && key && { 'x-cg-pro-api-key': key }),
};

export async function getOffchainPrice(): Promise<string> {
  const address = config.quoteTokenAddress;

  const res = await fetch(_priceUrl(), { method: 'GET', headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = await res.text();
  const price = _extractUsdPrice(body, address);
  if (price == null) {
    throw new Error('price is undefined or could not be parsed exactly');
  }
  _checkFreshness(price.lastUpdatedAt);

  return price.usd;
}

function _priceUrl(): string {
  const url = new URL(config.oracle.apiUrl as string);
  url.searchParams.set('include_last_updated_at', 'true');
  return url.toString();
}

function _extractUsdPrice(
  body: string,
  address: string,
): { usd: string; lastUpdatedAt: bigint } | undefined {
  const bodyJson = _parseOracleJson(body);
  if (!isRecord(bodyJson)) return undefined;

  const token = Object.entries(bodyJson).find(
    ([tokenAddress]) => tokenAddress.toLowerCase() === address.toLowerCase(),
  )?.[1];
  if (!isRecord(token)) return undefined;

  const literal = readRawNumberLiteral(token.usd, DECIMAL_PRICE_LITERAL);
  if (!literal) return undefined;
  if (literal.length > MAX_OFFCHAIN_PRICE_LITERAL_LENGTH) return undefined;

  const lastUpdatedAt = readRawNumberLiteral(token.last_updated_at, INTEGER_LITERAL);
  if (!lastUpdatedAt) return undefined;

  return { usd: literal, lastUpdatedAt: BigInt(lastUpdatedAt) };
}

function _parseOracleJson(body: string): unknown {
  try {
    const parse = JSON.parse as (text: string, reviver: JsonParseReviver) => unknown;
    return parse(body, (key, value, context) => {
      if ((key === 'usd' || key === 'last_updated_at') && typeof value === 'number') {
        return context?.source == null ? undefined : new RawJsonNumber(context.source);
      }
      return value;
    });
  } catch {
    return undefined;
  }
}

function readRawNumberLiteral(value: unknown, pattern: RegExp): string | undefined {
  if (!(value instanceof RawJsonNumber)) return undefined;
  return pattern.test(value.source) ? value.source : undefined;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function _checkFreshness(lastUpdatedAt: bigint): void {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const futureSkewTolerance = BigInt(config.oracle.futureSkewTolerance);
  const maxStaleness = BigInt(config.oracle.offchainMaxStaleness);

  if (lastUpdatedAt > nowSec + futureSkewTolerance) {
    throw new Error('offchain oracle price has future timestamp');
  }
  if (nowSec - lastUpdatedAt > maxStaleness) {
    throw new Error('offchain oracle price is stale');
  }
}
