import { log } from '../utils/logger.ts';
import { config } from '../utils/config.ts';
import { toAsset } from '../utils/decimalConversion.ts';
import { getOffchainPrice } from './offchain.ts';
import { getOnchainPrice } from './onchain.ts';
import { AJNA_MAX_PRICE, AJNA_MIN_PRICE } from '../ajna/constants.ts';

const AJNA_PRICE_DECIMALS = 18;

type PriceSource = () => Promise<bigint | string>;

const SOURCES: Record<'onchain' | 'offchain', PriceSource> = {
  onchain: getOnchainPrice,
  offchain: getOffchainPrice,
};

export async function getPrice(): Promise<bigint> {
  if (config.oracle.fixedPrice != null) return getFixedPrice(config.oracle.fixedPrice);

  const errors: Error[] = [];
  const order: ('onchain' | 'offchain')[] = config.oracle.onchainPrimary
    ? ['onchain', 'offchain']
    : ['offchain', 'onchain'];

  for (const tag of order) {
    try {
      const price = await SOURCES[tag]();
      const normalizedPrice =
        typeof price === 'bigint' ? price : toAsset(price, AJNA_PRICE_DECIMALS);
      validateLivePrice(normalizedPrice, tag);
      return normalizedPrice;
    } catch (err) {
      const e = new Error(`${tag} price query failed`, { cause: err });
      errors.push(e);
      log.warn({ event: 'price_query_failed', err, tag }, `${tag} price query failed`);
    }
  }

  throw new AggregateError(errors, 'unable to fetch price from either source');
}

function validateLivePrice(price: bigint, tag: string): void {
  if (price <= 0n) throw new Error(`${tag} price must be positive`);
  if (price < AJNA_MIN_PRICE || price > AJNA_MAX_PRICE) {
    throw new Error(`${tag} price is outside Ajna price range`);
  }
}

async function getFixedPrice(rawPrice: string): Promise<bigint> {
  const price = toAsset(rawPrice, AJNA_PRICE_DECIMALS);
  if (price <= 0n) throw new Error('fixed price must be positive');
  log.info({ event: 'keeper_price_fixed', rawPrice, price }, `using fixed price: ${price}`);
  return price;
}
