import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestError } from 'viem';

const SECRET = 'SUPER_SECRET_KEY';
const SECRET_URL = `https://eth-mainnet.example/v2/${SECRET}`;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
});

async function loadSerializeError() {
  vi.doMock('../../src/utils/config.ts', () => ({ config: { keeper: { logLevel: 'info' } } }));
  const { serializeError } = await import('../../src/utils/logger.ts');
  return serializeError;
}

describe('serializeError redaction', () => {
  it('strips a secret RPC URL carried on a viem HttpRequestError', async () => {
    const serializeError = await loadSerializeError();
    const serialized = serializeError(new HttpRequestError({ url: SECRET_URL, status: 500 }));

    expect(JSON.stringify(serialized)).not.toContain(SECRET);
    expect(serialized).not.toHaveProperty('url');
    expect(serialized).not.toHaveProperty('raw');
    expect(String((serialized as { message: string }).message)).toContain('[redacted-url]');
  });

  it('strips a secret URL nested in an error cause chain', async () => {
    const serializeError = await loadSerializeError();
    const wrapped = new Error('offchain price query failed', {
      cause: new HttpRequestError({ url: SECRET_URL, status: 500 }),
    });

    expect(JSON.stringify(serializeError(wrapped))).not.toContain(SECRET);
  });

  it('leaves non-URL diagnostic text intact', async () => {
    const serializeError = await loadSerializeError();
    const serialized = serializeError(new Error('bad state at file:///app/src/foo.ts'));

    expect(String((serialized as { message: string }).message)).toContain('bad state');
  });
});
