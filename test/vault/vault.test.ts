import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  getAssetDecimals,
  getBuckets,
  move,
  moveToBuffer,
  moveFromBuffer,
  isPaused,
  getBufferAddress,
  getPoolInfoUtilsAddress,
  getPoolAddress,
  drain,
  getDustThreshold,
} from '../../src/vault/vault';
import { getBufferTotal } from '../../src/vault/buffer';
import { getHtp, getPriceToIndex, getQtValue } from '../../src/ajna/poolInfoUtils';
import { handleTransaction } from '../../src/utils/transaction';
import { client } from '../../src/utils/client.ts';
import { setBufferRatio } from '../helpers/vaultHelpers.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('vault interface', () => {
  it('can query buckets', async () => {
    const buckets = await getBuckets();
    expect(buckets).toSatisfy((val) => (val.length === 1 && val[0] === 4161n) || val.length === 0);
  });

  it('can query asset decimals', async () => {
    const decimals = await getAssetDecimals();
    expect(decimals).toBe(18);
  });

  it('can calculate dust threshold', async () => {
    const dustThreshold = await getDustThreshold();
    expect(dustThreshold).toBe(1000001n);
  });

  it('can query paused status', async () => {
    const paused = await isPaused();
    expect(paused).toBe(false);
  });

  it('can query contract addresses', async () => {
    const buffer = await getBufferAddress();
    const info = await getPoolInfoUtilsAddress();
    const pool = await getPoolAddress();

    expect(buffer).toBe('0x787B797Ed807E5882d1a7bE68C4D742289df32a5');
    expect(info).toBe('0x30c5eF2997d6a882DE52c4ec01B6D0a5e5B4fAAE');
    expect(pool).toBe('0x34bC3D3d274A355f3404c5dEe2a96335540234de');
  });

  it('can drain bucket', async () => {
    // Test that it doesn't revert
    await drain(4156n);
  });
});

// These operations may intermittently fail in CI due to Anvil timing issues.
// Occasionally this occurs locally, but rarely. As a result, these tests have been
// designed run exclusively in a local environment.
if (!process.env.CI) {
  describe('vault operations', () => {
    let snapshot: string;
    let htp;
    let htpIndex: bigint;
    let assets;
    let initialBufferBalance: bigint;
    let initialHtpQts: bigint;

    beforeAll(async () => {
      htp = await getHtp();
      htpIndex = await getPriceToIndex(htp);
      assets = BigInt(2e10);

      [initialBufferBalance, initialHtpQts] = await Promise.all([
        getBufferTotal(),
        getQtValue(htpIndex),
      ]);

      await handleTransaction(moveFromBuffer(htpIndex, assets), {
        action: 'MoveFromBuffer',
        to: htpIndex,
        amount: assets,
      });

      snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
      await setBufferRatio(0n);
    });

    beforeEach(async () => {
      await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
      snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
    });

    afterAll(async () => {
      await setBufferRatio(5000n);
    });

    it('can move between buckets', async () => {
      const toIndex = htpIndex - 1n;

      const [beforeHtpQts, beforeToQts] = await Promise.all([
        getQtValue(htpIndex),
        getQtValue(toIndex),
      ]);

      const toAssets = 19999721737n;
      await handleTransaction(move(htpIndex, toIndex, toAssets), {
        action: 'Move',
        from: htpIndex,
        to: toIndex,
        amount: toAssets,
      });

      const [afterHtpQts, afterToQts] = await Promise.all([
        getQtValue(htpIndex),
        getQtValue(toIndex),
      ]);

      const htpDelta = beforeHtpQts - afterHtpQts;
      const toDelta = afterToQts - beforeToQts;
      const deltaDiff = toDelta - htpDelta;

      expect(deltaDiff).toBeLessThan(2n);
      expect(toDelta).toBeGreaterThan(0n);
    });

    it('can move from bucket to buffer', async () => {
      await setBufferRatio(0n);

      const [beforeBufferBalance, beforeHtpQts] = await Promise.all([
        getBufferTotal(),
        getQtValue(htpIndex),
      ]);

      const toAssets = BigInt(1e10);
      await handleTransaction(moveToBuffer(htpIndex, toAssets), {
        action: 'MoveToBuffer',
        from: htpIndex,
        amount: toAssets,
      });

      const [afterBufferBalance, afterHtpQts] = await Promise.all([
        getBufferTotal() as bigint,
        getQtValue(htpIndex),
      ]);

      const bufferDelta: bigint = afterBufferBalance - beforeBufferBalance;
      const htpDelta = beforeHtpQts - afterHtpQts;
      const deltaDiff = htpDelta - bufferDelta;

      expect(deltaDiff).toBeLessThan(3n);
      expect(bufferDelta).toBeGreaterThan(0n);
    });

    it('can move from buffer to bucket', async () => {
      const [afterBufferBalance, afterHtpQts] = await Promise.all([
        getBufferTotal(),
        getQtValue(htpIndex),
      ]);

      const htpDelta = afterHtpQts - initialHtpQts;
      const bufferDelta = initialBufferBalance - afterBufferBalance;
      const deltaDiff = bufferDelta - htpDelta;

      expect(deltaDiff).toBeLessThan(300000);
      expect(htpDelta).toBeGreaterThan(0n);
    });
  });
}
