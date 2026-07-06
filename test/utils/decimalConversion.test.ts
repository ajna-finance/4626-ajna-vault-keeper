import { describe, expect, it } from 'vitest';
import { toAsset, toWad, toWadTokenUnit } from '../../src/utils/decimalConversion.ts';

describe('decimal conversion helpers', () => {
  it('scales asset amounts into WAD using asset decimals', () => {
    expect(toWad(1_000_000n, 6)).toBe(1_000_000_000_000_000_000n);
  });

  it('computes the WAD value of one token base unit', () => {
    expect(toWadTokenUnit(6)).toBe(1_000_000_000_000n);
    expect(toWadTokenUnit(18)).toBe(1n);
  });

  it('parses human-readable prices into Ajna WAD prices exactly', () => {
    expect(toAsset('0.999870478245824934', 18)).toBe(999870478245824934n);
  });

  it('handles decimal inputs that previously relied on lossy JS number math', () => {
    expect(toAsset(1.1, 18)).toBe(1_100_000_000_000_000_000n);
    expect(toAsset('1e-6', 18)).toBe(1_000_000_000_000n);
  });
});
