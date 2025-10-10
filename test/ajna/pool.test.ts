import { describe, it, expect } from 'vitest';
import {
  getBankruptcyTime,
  getBucketInfo,
  getBucketLps,
  updateInterest,
} from '../../src/ajna/pool';

describe('Pool interface', () => {
  it('can query bucket info', async () => {
    const info = await getBucketInfo(4156n);
    expect(info.length).toBe(5);
  });

  it('can query bankruptcy time', async () => {
    const timestamp = await getBankruptcyTime(4156n);
    expect(timestamp).toBe(0n);
  });

  it('can query bucket lps', async () => {
    const lps = await getBucketLps(4156n);
    expect(lps).toBe(0n);
  });

  it('can update interest', async () => {
    // testing that it doesn't revert
    await updateInterest();
  });
});
