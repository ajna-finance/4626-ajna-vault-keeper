import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type Signature,
  type TransactionSerializable,
} from 'viem';
import { Agent } from 'undici';

const ORIGINAL_ENV = { ...process.env };

function jsonResponseHeaders(value: string = 'application/json') {
  return {
    get: (name: string) => (name.toLowerCase() === 'content-type' ? value : null),
  };
}

function jsonRpcMockResponse(body: unknown, contentType: string = 'application/json') {
  return {
    headers: jsonResponseHeaders(contentType),
    json: async () => body,
    ok: true,
    status: 200,
    statusText: 'OK',
  };
}

function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setClientTestEnv(overrides: Record<string, string | undefined>): void {
  restoreEnv(ORIGINAL_ENV);

  process.env.RPC_URL = 'https://rpc.example';
  process.env.SUBGRAPH_URL = 'https://subgraph.example';
  process.env.TEST_ENV = 'false';

  delete process.env.PRIVATE_KEY;
  delete process.env.KEYSTORE_PATH;
  delete process.env.REMOTE_SIGNER_URL;
  delete process.env.REMOTE_SIGNER_ADDRESS;
  delete process.env.REMOTE_SIGNER_AUTH_TOKEN;
  delete process.env.REMOTE_SIGNER_TLS_CLIENT_CERT;
  delete process.env.REMOTE_SIGNER_TLS_CLIENT_KEY;
  delete process.env.REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD;
  delete process.env.REMOTE_SIGNER_TLS_CA;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.doUnmock('dotenv/config');
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/utils/logger.ts');
});

describe('client credential selection', () => {
  it('uses the raw private key account when PRIVATE_KEY is configured', async () => {
    vi.doMock('dotenv/config', () => ({}));
    vi.doMock('../../src/utils/config.ts', () => ({
      config: { chainId: 1, remoteSigner: { requestTimeoutMs: 30000 } },
    }));
    vi.doMock('../../src/utils/logger.ts', () => ({ log: { warn: vi.fn() } }));

    const privateKey =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
    setClientTestEnv({ PRIVATE_KEY: privateKey });

    const { client } = await import('../../src/utils/client.ts');

    expect(client.account.address).toBe(privateKeyToAccount(privateKey).address);
  });

  it('uses the configured remote signer account when remote signer mode is configured', async () => {
    vi.doMock('dotenv/config', () => ({}));
    vi.doMock('../../src/utils/config.ts', () => ({
      config: { chainId: 1, remoteSigner: { requestTimeoutMs: 30000 } },
    }));
    vi.doMock('../../src/utils/logger.ts', () => ({ log: { warn: vi.fn() } }));

    setClientTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    const { client } = await import('../../src/utils/client.ts');

    expect(client.account.address).toBe('0x00000000000000000000000000000000000000A1');
  });
});

describe('remote signer account', () => {
  it('signs keeper transactions through eth_signTransaction and serializes them locally', async () => {
    const signer = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const transaction = {
      chainId: 1,
      data: '0x1234',
      gas: 21000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      nonce: 7,
      to: '0x00000000000000000000000000000000000000b2',
      type: 'eip1559',
      value: 0n,
    } satisfies TransactionSerializable;
    const signedTransaction = await signer.signTransaction(transaction);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        id: 1,
        jsonrpc: '2.0',
        result: signedTransaction,
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { createRemoteSignerAccount } = await import('../../src/utils/remoteSigner.ts');

    const account = createRemoteSignerAccount({
      address: signer.address,
      timeoutMs: 30000,
      url: 'https://signer.example',
    });
    const serializer = vi.fn((request: TransactionSerializable, signature?: Signature) => {
      expect(request).toMatchObject(transaction);
      expect(signature).toEqual(
        expect.objectContaining({
          r: expect.stringMatching(/^0x[0-9a-f]+$/),
          s: expect.stringMatching(/^0x[0-9a-f]+$/),
        }),
      );

      return serializeTransaction(request, signature);
    });

    const serialized = await account.signTransaction(transaction, {
      serializer: serializer as typeof import('viem').serializeTransaction,
    });
    const request = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);

    expect(serializer).toHaveBeenCalledTimes(1);
    expect(serialized).toBe(serializer.mock.results[0]!.value);
    expect(request).toEqual({
      id: 1,
      jsonrpc: '2.0',
      method: 'eth_signTransaction',
      params: [
        {
          chainId: '0x1',
          data: '0x1234',
          from: signer.address,
          gas: '0x5208',
          maxFeePerGas: '0x14',
          maxPriorityFeePerGas: '0x2',
          nonce: '0x7',
          to: '0x00000000000000000000000000000000000000b2',
          type: '0x2',
          value: '0x0',
        },
      ],
    });
  });

  it('rejects transaction signatures that recover to a different address', async () => {
    const configuredAddress = '0x00000000000000000000000000000000000000A1' as const;
    const wrongSigner = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f094538c5f6d2e7d31be9c4754b150f8f7f7b1d8',
    );
    const transaction = {
      chainId: 1,
      data: '0x1234',
      gas: 21000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      nonce: 7,
      to: '0x00000000000000000000000000000000000000b2',
      type: 'eip1559',
      value: 0n,
    } satisfies TransactionSerializable;
    const signedTransaction = await wrongSigner.signTransaction(transaction);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        id: 1,
        jsonrpc: '2.0',
        result: signedTransaction,
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { createRemoteSignerAccount } = await import('../../src/utils/remoteSigner.ts');

    const account = createRemoteSignerAccount({
      address: configuredAddress,
      timeoutMs: 30000,
      url: 'https://signer.example',
    });

    await expect(account.signTransaction(transaction)).rejects.toThrow(
      `Remote signer transaction signature recovered ${wrongSigner.address}, expected ${configuredAddress}`,
    );
  });

  it('accepts a Web3Signer-shaped RLP response and broadcasts the locally re-serialized transaction', async () => {
    const signer = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const transaction = {
      chainId: 1,
      data: '0x1234',
      gas: 21000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      nonce: 7,
      to: '0x00000000000000000000000000000000000000b2',
      type: 'eip1559',
      value: 0n,
    } satisfies TransactionSerializable;
    const signedTransaction = await signer.signTransaction(transaction);
    const parsedTransaction = parseTransaction(signedTransaction);
    const expectedSignature: Signature = {
      r: parsedTransaction.r!,
      s: parsedTransaction.s!,
      yParity: parsedTransaction.yParity!,
    };
    const expectedBroadcast = serializeTransaction(transaction, expectedSignature);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        id: 1,
        jsonrpc: '2.0',
        result: signedTransaction,
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { createRemoteSignerAccount } = await import('../../src/utils/remoteSigner.ts');

    const account = createRemoteSignerAccount({
      address: signer.address,
      timeoutMs: 30000,
      url: 'https://signer.example',
    });

    const broadcast = await account.signTransaction(transaction);

    expect(broadcast).toBe(expectedBroadcast);
  });

  it('verifies and broadcasts using the same custom serializer', async () => {
    const signer = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const transaction = {
      chainId: 1,
      data: '0x1234',
      gas: 21000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      nonce: 7,
      to: '0x00000000000000000000000000000000000000b2',
      type: 'eip1559',
      value: 0n,
    } satisfies TransactionSerializable;
    const signedTransaction = await signer.signTransaction(transaction);
    const parsedTransaction = parseTransaction(signedTransaction);
    const expectedSignature: Signature = {
      r: parsedTransaction.r!,
      s: parsedTransaction.s!,
      yParity: parsedTransaction.yParity!,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        id: 1,
        jsonrpc: '2.0',
        result: signedTransaction,
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { createRemoteSignerAccount } = await import('../../src/utils/remoteSigner.ts');

    const account = createRemoteSignerAccount({
      address: signer.address,
      timeoutMs: 30000,
      url: 'https://signer.example',
    });
    const serializer = vi.fn((request: TransactionSerializable, signature?: Signature) =>
      serializeTransaction(request, signature),
    );

    const broadcast = await account.signTransaction(transaction, {
      serializer: serializer as typeof import('viem').serializeTransaction,
    });

    expect(serializer).toHaveBeenCalledTimes(1);
    expect(serializer).toHaveBeenCalledWith(transaction, expectedSignature);
    expect(broadcast).toBe(serializer.mock.results[0]!.value);
  });

  it('rejects a Web3Signer response whose embedded signature recovers to a different address', async () => {
    const configuredAddress = '0x00000000000000000000000000000000000000A1' as const;
    const wrongSigner = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f094538c5f6d2e7d31be9c4754b150f8f7f7b1d8',
    );
    const transaction = {
      chainId: 1,
      data: '0x1234',
      gas: 21000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      nonce: 7,
      to: '0x00000000000000000000000000000000000000b2',
      type: 'eip1559',
      value: 0n,
    } satisfies TransactionSerializable;
    const signedTransaction = await wrongSigner.signTransaction(transaction);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        id: 1,
        jsonrpc: '2.0',
        result: signedTransaction,
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { createRemoteSignerAccount } = await import('../../src/utils/remoteSigner.ts');

    const account = createRemoteSignerAccount({
      address: configuredAddress,
      timeoutMs: 30000,
      url: 'https://signer.example',
    });

    await expect(account.signTransaction(transaction)).rejects.toThrow(
      `Remote signer transaction signature recovered ${wrongSigner.address}, expected ${configuredAddress}`,
    );
  });

  it('rejects a Web3Signer response signed with the correct key but for a different transaction', async () => {
    const signer = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const original = {
      chainId: 1,
      data: '0x1234',
      gas: 21000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      nonce: 7,
      to: '0x00000000000000000000000000000000000000b2',
      type: 'eip1559',
      value: 0n,
    } satisfies TransactionSerializable;
    const mutated = {
      ...original,
      to: '0x00000000000000000000000000000000000000c3',
      value: 1_000_000_000_000_000_000n,
    } satisfies TransactionSerializable;
    const signedMutatedTransaction = await signer.signTransaction(mutated);
    const parsedMutated = parseTransaction(signedMutatedTransaction);
    const mutatedSignature: Signature = {
      r: parsedMutated.r!,
      s: parsedMutated.s!,
      yParity: parsedMutated.yParity!,
    };
    const expectedRecovered = await recoverTransactionAddress({
      serializedTransaction: serializeTransaction(original, mutatedSignature),
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        id: 1,
        jsonrpc: '2.0',
        result: signedMutatedTransaction,
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { createRemoteSignerAccount } = await import('../../src/utils/remoteSigner.ts');

    const account = createRemoteSignerAccount({
      address: signer.address,
      timeoutMs: 30000,
      url: 'https://signer.example',
    });

    await expect(account.signTransaction(original)).rejects.toThrow(
      `Remote signer transaction signature recovered ${expectedRecovered}, expected ${signer.address}`,
    );
  });
});

describe('remote signer JSON-RPC error handling', () => {
  const signerAddress = '0x00000000000000000000000000000000000000A1' as const;

  it('includes code and primitive data in the thrown error message', async () => {
    vi.doMock('dotenv/config', () => ({}));

    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        error: { code: -32602, data: 'missing chainId', message: 'invalid params' },
        id: 1,
        jsonrpc: '2.0',
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { verifyRemoteSignerIdentity } = await import('../../src/utils/remoteSigner.ts');

    await expect(
      verifyRemoteSignerIdentity({
        address: signerAddress,
        timeoutMs: 30000,
        url: 'https://signer.example',
      }),
    ).rejects.toThrow(
      'Remote signer request failed (eth_sign): invalid params (code -32602, data missing chainId)',
    );
  });

  it('attaches non-primitive error data via the rpcError property without inlining it', async () => {
    vi.doMock('dotenv/config', () => ({}));

    const errorPayload = {
      code: -32000,
      data: { details: 'foo' },
      message: 'execution failed',
    };
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        error: errorPayload,
        id: 1,
        jsonrpc: '2.0',
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { verifyRemoteSignerIdentity } = await import('../../src/utils/remoteSigner.ts');

    let caught: unknown;

    try {
      await verifyRemoteSignerIdentity({
        address: signerAddress,
        timeoutMs: 30000,
        url: 'https://signer.example',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Remote signer request failed (eth_sign): execution failed (code -32000)',
    );
    expect((caught as Error).message).not.toContain('details');
    expect((caught as { rpcError?: unknown }).rpcError).toEqual(errorPayload);
  });

  it('throws an id-mismatch error when the response id does not match the request id', async () => {
    vi.doMock('dotenv/config', () => ({}));

    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        id: 9999,
        jsonrpc: '2.0',
        result: '0x00',
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { verifyRemoteSignerIdentity } = await import('../../src/utils/remoteSigner.ts');

    await expect(
      verifyRemoteSignerIdentity({
        address: signerAddress,
        timeoutMs: 30000,
        url: 'https://signer.example',
      }),
    ).rejects.toThrow('Remote signer request id mismatch (eth_sign): expected 1, got 9999');
  });

  it('treats a null response id as a mismatch', async () => {
    vi.doMock('dotenv/config', () => ({}));

    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        id: null,
        jsonrpc: '2.0',
        result: '0x00',
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { verifyRemoteSignerIdentity } = await import('../../src/utils/remoteSigner.ts');

    await expect(
      verifyRemoteSignerIdentity({
        address: signerAddress,
        timeoutMs: 30000,
        url: 'https://signer.example',
      }),
    ).rejects.toThrow('Remote signer request id mismatch (eth_sign): expected 1, got null');
  });
});

describe('remote signer response validation', () => {
  const signerAddress = '0x00000000000000000000000000000000000000A1' as const;

  it('throws a non-JSON content-type error when the signer responds with HTML', async () => {
    vi.doMock('dotenv/config', () => ({}));

    const fetchMock = vi.fn().mockResolvedValue({
      headers: jsonResponseHeaders('text/html'),
      json: async () => ({}),
      ok: true,
      status: 200,
      statusText: 'OK',
    });

    vi.stubGlobal('fetch', fetchMock);

    const { verifyRemoteSignerIdentity } = await import('../../src/utils/remoteSigner.ts');

    await expect(
      verifyRemoteSignerIdentity({
        address: signerAddress,
        timeoutMs: 30000,
        url: 'https://signer.example',
      }),
    ).rejects.toThrow(
      'Remote signer request returned non-JSON content type (eth_sign): expected application/json, got text/html',
    );
  });

  it('throws an invalid-JSON error when the response body cannot be parsed as JSON', async () => {
    vi.doMock('dotenv/config', () => ({}));

    const cause = new SyntaxError('Unexpected token < in JSON at position 0');
    const fetchMock = vi.fn().mockResolvedValue({
      headers: jsonResponseHeaders(),
      json: async () => {
        throw cause;
      },
      ok: true,
      status: 200,
      statusText: 'OK',
    });

    vi.stubGlobal('fetch', fetchMock);

    const { verifyRemoteSignerIdentity } = await import('../../src/utils/remoteSigner.ts');

    let caught: unknown;

    try {
      await verifyRemoteSignerIdentity({
        address: signerAddress,
        timeoutMs: 30000,
        url: 'https://signer.example',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Remote signer request returned invalid JSON (eth_sign)',
    );
    expect((caught as Error).cause).toBe(cause);
  });

  it('throws an unexpected-shape error when the JSON payload has neither result nor error', async () => {
    vi.doMock('dotenv/config', () => ({}));

    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        id: 1,
        jsonrpc: '2.0',
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { verifyRemoteSignerIdentity } = await import('../../src/utils/remoteSigner.ts');

    await expect(
      verifyRemoteSignerIdentity({
        address: signerAddress,
        timeoutMs: 30000,
        url: 'https://signer.example',
      }),
    ).rejects.toThrow(
      "Remote signer request returned an unexpected response shape (eth_sign): missing both 'result' and 'error'",
    );
  });

  it('passes redirect: "error" to fetch so the signer cannot redirect the call', async () => {
    const signer = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const message = '4626-ajna-vault-keeper remote signer identity check';
    const signature = await signer.signMessage({ message });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        id: 1,
        jsonrpc: '2.0',
        result: signature,
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { verifyRemoteSignerIdentity } = await import('../../src/utils/remoteSigner.ts');

    await verifyRemoteSignerIdentity({
      address: signer.address,
      timeoutMs: 30000,
      url: 'https://signer.example',
    });

    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.redirect).toBe('error');
  });

  it('accepts application/json with a charset suffix as a valid content type', async () => {
    const signer = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const message = '4626-ajna-vault-keeper remote signer identity check';
    const signature = await signer.signMessage({ message });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse(
        {
          id: 1,
          jsonrpc: '2.0',
          result: signature,
        },
        'application/json; charset=utf-8',
      ),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { verifyRemoteSignerIdentity } = await import('../../src/utils/remoteSigner.ts');

    await expect(
      verifyRemoteSignerIdentity({
        address: signer.address,
        timeoutMs: 30000,
        url: 'https://signer.example',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('remote signer request timeout', () => {
  const signerAddress = '0x00000000000000000000000000000000000000A1' as const;

  it('throws a remote-signer-specific timeout error when fetch never resolves', async () => {
    vi.doMock('dotenv/config', () => ({}));

    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    const { verifyRemoteSignerIdentity } = await import('../../src/utils/remoteSigner.ts');

    await expect(
      verifyRemoteSignerIdentity({
        address: signerAddress,
        timeoutMs: 50,
        url: 'https://signer.example',
      }),
    ).rejects.toThrow('Remote signer request timed out (eth_sign) after 50ms');
  });
});

describe('remote signer startup verification', () => {
  it('fails initClient when the remote signer message signature does not match the configured address', async () => {
    vi.doMock('dotenv/config', () => ({}));
    vi.doMock('../../src/utils/config.ts', () => ({
      config: { chainId: 1, remoteSigner: { requestTimeoutMs: 30000 } },
    }));
    vi.doMock('../../src/utils/logger.ts', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

    setClientTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    const wrongSigner = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f094538c5f6d2e7d31be9c4754b150f8f7f7b1d8',
    );
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        id: 1,
        jsonrpc: '2.0',
        result: await wrongSigner.signMessage({
          message: '4626-ajna-vault-keeper remote signer identity check',
        }),
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { initClient } = await import('../../src/utils/client.ts');

    await expect(initClient()).rejects.toThrow(
      `Remote signer message signature recovered ${wrongSigner.address}, expected 0x00000000000000000000000000000000000000A1`,
    );
  });
});

describe('remote signer bearer token', () => {
  const signerAddress = '0x00000000000000000000000000000000000000A1' as const;

  it('sends an Authorization header when an auth token is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        error: { code: -32600, message: 'unused' },
        id: 1,
        jsonrpc: '2.0',
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { verifyRemoteSignerIdentity } = await import('../../src/utils/remoteSigner.ts');

    await expect(
      verifyRemoteSignerIdentity({
        address: signerAddress,
        authToken: 'super-secret-token',
        timeoutMs: 30000,
        url: 'https://signer.example',
      }),
    ).rejects.toThrow();

    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers).toEqual(
      expect.objectContaining({ authorization: 'Bearer super-secret-token' }),
    );
  });

  it('omits the Authorization header when no auth token is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        error: { code: -32600, message: 'unused' },
        id: 1,
        jsonrpc: '2.0',
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { verifyRemoteSignerIdentity } = await import('../../src/utils/remoteSigner.ts');

    await expect(
      verifyRemoteSignerIdentity({
        address: signerAddress,
        timeoutMs: 30000,
        url: 'https://signer.example',
      }),
    ).rejects.toThrow();

    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers).not.toHaveProperty('authorization');
    expect(init.headers).not.toHaveProperty('Authorization');
  });
});

describe('remote signer mTLS dispatcher wiring', () => {
  let tmpDir: string;
  let certPath: string;
  let keyPath: string;
  let caPath: string;

  function createTlsFiles(): void {
    tmpDir = mkdtempSync(join(tmpdir(), 'remote-signer-test-'));
    certPath = join(tmpDir, 'client.pem');
    keyPath = join(tmpDir, 'client.key');
    caPath = join(tmpDir, 'ca.pem');
    writeFileSync(
      certPath,
      '-----BEGIN CERTIFICATE-----\nplaceholder\n-----END CERTIFICATE-----\n',
    );
    writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----\n');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nplaceholder\n-----END CERTIFICATE-----\n');
  }

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { force: true, recursive: true });
  });

  it('passes an undici Agent dispatcher to fetch when TLS env vars are set', async () => {
    createTlsFiles();
    vi.doMock('dotenv/config', () => ({}));
    vi.doMock('../../src/utils/config.ts', () => ({
      config: { chainId: 1, remoteSigner: { requestTimeoutMs: 30000 } },
    }));
    vi.doMock('../../src/utils/logger.ts', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

    setClientTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_TLS_CA: caPath,
      REMOTE_SIGNER_TLS_CLIENT_CERT: certPath,
      REMOTE_SIGNER_TLS_CLIENT_KEY: keyPath,
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        error: { code: -32600, message: 'unused' },
        id: 1,
        jsonrpc: '2.0',
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { initClient } = await import('../../src/utils/client.ts');

    await expect(initClient()).rejects.toThrow();

    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.dispatcher).toBeInstanceOf(Agent);
  });

  it('does not pass a dispatcher to fetch when TLS env vars are not set', async () => {
    vi.doMock('dotenv/config', () => ({}));
    vi.doMock('../../src/utils/config.ts', () => ({
      config: { chainId: 1, remoteSigner: { requestTimeoutMs: 30000 } },
    }));
    vi.doMock('../../src/utils/logger.ts', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

    setClientTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcMockResponse({
        error: { code: -32600, message: 'unused' },
        id: 1,
        jsonrpc: '2.0',
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const { initClient } = await import('../../src/utils/client.ts');

    await expect(initClient()).rejects.toThrow();

    const init = fetchMock.mock.calls[0]![1]!;
    expect(init).not.toHaveProperty('dispatcher');
  });
});

describe('remote signer typed-data signing', () => {
  const SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as const;
  // CoW-shaped order: exercises bigint serialization and a realistic types set.
  const typedData = {
    domain: {
      name: 'Gnosis Protocol',
      version: 'v2',
      chainId: 1,
      verifyingContract: SETTLEMENT,
    },
    types: {
      Order: [
        { name: 'sellToken', type: 'address' },
        { name: 'buyToken', type: 'address' },
        { name: 'receiver', type: 'address' },
        { name: 'sellAmount', type: 'uint256' },
        { name: 'buyAmount', type: 'uint256' },
        { name: 'validTo', type: 'uint32' },
        { name: 'appData', type: 'bytes32' },
        { name: 'feeAmount', type: 'uint256' },
        { name: 'kind', type: 'string' },
        { name: 'partiallyFillable', type: 'bool' },
        { name: 'sellTokenBalance', type: 'string' },
        { name: 'buyTokenBalance', type: 'string' },
      ],
    },
    primaryType: 'Order',
    message: {
      sellToken: '0x00000000000000000000000000000000000000c1',
      buyToken: '0x6b175474e89094c44da98b954eedeac495271d0f',
      receiver: '0x00000000000000000000000000000000000000a1',
      sellAmount: 10n ** 18n,
      buyAmount: 9950n,
      validTo: 1234567890,
      appData: '0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d',
      feeAmount: 0n,
      kind: 'sell',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    },
  } as const;

  it('signs through eth_signTypedData_v4 with the full EIP-712 JSON payload', async () => {
    const signer = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const signature = await signer.signTypedData(typedData);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonRpcMockResponse({ id: 1, jsonrpc: '2.0', result: signature }));
    vi.stubGlobal('fetch', fetchMock);

    const { createRemoteSignerAccount } = await import('../../src/utils/remoteSigner.ts');
    const account = createRemoteSignerAccount({
      address: signer.address,
      timeoutMs: 30000,
      url: 'https://signer.example',
    });

    const result = await account.signTypedData(typedData);
    expect(result).toBe(signature);

    const request = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(request.method).toBe('eth_signTypedData_v4');
    expect(request.params[0]).toBe(signer.address);

    const payload = JSON.parse(request.params[1]);
    expect(payload.primaryType).toBe('Order');
    // eth_signTypedData_v4 consumers require the domain type listed explicitly.
    expect(payload.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ]);
    expect(payload.types.Order).toHaveLength(12);
    // bigints must serialize as decimal strings, not fail JSON.stringify.
    expect(payload.message.sellAmount).toBe('1000000000000000000');
    expect(payload.message.feeAmount).toBe('0');
    expect(payload.domain.verifyingContract).toBe(SETTLEMENT);
  });

  it('rejects typed-data signatures that recover to a different address', async () => {
    const configuredAddress = '0x00000000000000000000000000000000000000A1' as const;
    const wrongSigner = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    );
    const signature = await wrongSigner.signTypedData(typedData);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonRpcMockResponse({ id: 1, jsonrpc: '2.0', result: signature }));
    vi.stubGlobal('fetch', fetchMock);

    const { createRemoteSignerAccount } = await import('../../src/utils/remoteSigner.ts');
    const account = createRemoteSignerAccount({
      address: configuredAddress,
      timeoutMs: 30000,
      url: 'https://signer.example',
    });

    await expect(account.signTypedData(typedData)).rejects.toThrow(
      /typed data signature recovered/,
    );
  });

  it('rejects a signature from the right key over a different struct than requested', async () => {
    const signer = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    // Signed a tampered order (different buyAmount): recovery over OUR payload
    // must not come back to the configured address.
    const tampered = {
      ...typedData,
      message: { ...typedData.message, buyAmount: 1n },
    } as const;
    const signature = await signer.signTypedData(tampered);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonRpcMockResponse({ id: 1, jsonrpc: '2.0', result: signature }));
    vi.stubGlobal('fetch', fetchMock);

    const { createRemoteSignerAccount } = await import('../../src/utils/remoteSigner.ts');
    const account = createRemoteSignerAccount({
      address: signer.address,
      timeoutMs: 30000,
      url: 'https://signer.example',
    });

    await expect(account.signTypedData(typedData)).rejects.toThrow(
      /typed data signature recovered/,
    );
  });
});
