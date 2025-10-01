import { log } from '../utils/logger.ts';
import { env } from '../utils/env.ts';
import { toAsset } from '../utils/decimalConversion.ts';
import { getOffchainPrice } from './offchain.ts';
import { getOnchainPrice } from './onchain.ts';

type PriceSource = () => Promise<bigint | number>;

const SOURCES: Record<'on' | 'off', PriceSource> = {
  on: getOnchainPrice,
  off: getOffchainPrice as () => Promise<number>,
};

export async function getPrice(): Promise<bigint> {
  const order: ('on' | 'off')[] = env.ONCHAIN_ORACLE_PRIMARY ? ['on', 'off'] : ['off', 'on'];

  for (const tag of order) {
    try {
      const price = await SOURCES[tag]();

      if (typeof price === 'number') {
        return toAsset(price);
      } else if (typeof price === 'bigint') {
        return price;
      }
    } catch (err) {
      log.warn(
        { event: 'price_query', err, tag },
        'primary price source failed, trying secondary source',
      );
    }
  }

  throw new Error('unable to fetch price from either source');
}
