import type { Dispatcher } from 'undici';
import {
  bytesToHex,
  getTransactionType,
  isAddressEqual,
  parseTransaction,
  recoverMessageAddress,
  recoverTransactionAddress,
  serializeTransaction,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type Signature,
  type SignableMessage,
  type TransactionSerializable,
  type TypedData,
  type TypedDataDefinition,
} from 'viem';
import { toAccount } from 'viem/accounts';

type RemoteSignerConfig = {
  address: Address;
  authToken?: string | undefined;
  dispatcher?: Dispatcher | undefined;
  timeoutMs: number;
  url: string;
};

type JsonRpcSuccess<T> = {
  id: number;
  jsonrpc: '2.0';
  result: T;
};

type JsonRpcFailure = {
  error: {
    code: number;
    data?: unknown;
    message: string;
  };
  id: number;
  jsonrpc: '2.0';
};

type JsonRpcResponse<T> = JsonRpcFailure | JsonRpcSuccess<T>;

let requestId = 0;
const REMOTE_SIGNER_IDENTITY_MESSAGE = '4626-ajna-vault-keeper remote signer identity check';

function toSignableHex(message: SignableMessage): Hex {
  if (typeof message === 'string') return stringToHex(message);
  if (typeof message.raw === 'string') return message.raw;
  return bytesToHex(message.raw);
}

function getRemoteSignerTransactionType(transaction: TransactionSerializable) {
  const type = getTransactionType(transaction);

  if (type === 'legacy' || type === 'eip1559') {
    return type;
  }

  throw new Error(`Remote signer does not support ${type} transactions in this keeper`);
}

function toRemoteSignerType(type: 'legacy' | 'eip1559'): Hex | undefined {
  if (type === 'eip1559') return '0x2';
  return undefined;
}

function toRemoteSignerTransaction(address: Address, transaction: TransactionSerializable) {
  const type = getRemoteSignerTransactionType(transaction);

  if (transaction.accessList && transaction.accessList.length > 0) {
    throw new Error('Remote signer does not support access lists in this keeper');
  }

  return {
    chainId: transaction.chainId != null ? toHex(transaction.chainId) : undefined,
    data: transaction.data,
    from: address,
    gas: transaction.gas != null ? toHex(transaction.gas) : undefined,
    gasPrice: transaction.gasPrice != null ? toHex(transaction.gasPrice) : undefined,
    maxFeePerGas: transaction.maxFeePerGas != null ? toHex(transaction.maxFeePerGas) : undefined,
    maxPriorityFeePerGas:
      transaction.maxPriorityFeePerGas != null
        ? toHex(transaction.maxPriorityFeePerGas)
        : undefined,
    nonce: transaction.nonce != null ? toHex(transaction.nonce) : undefined,
    to: transaction.to ?? null,
    type: toRemoteSignerType(type),
    value: transaction.value != null ? toHex(transaction.value) : undefined,
  };
}

function isPrimitiveErrorData(data: unknown): data is bigint | boolean | number | string {
  const type = typeof data;
  return type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint';
}

function hasJsonContentType(contentType: string | null | undefined): boolean {
  if (contentType == null) return false;
  return contentType.toLowerCase().split(';')[0]!.trim() === 'application/json';
}

function isJsonRpcResponse<T>(payload: unknown): payload is JsonRpcResponse<T> {
  if (payload == null || typeof payload !== 'object') return false;
  return 'result' in payload || 'error' in payload;
}

async function requestRemoteSigner<T>(
  config: RemoteSignerConfig,
  method: string,
  params: unknown[],
): Promise<T> {
  const { authToken, dispatcher, timeoutMs, url } = config;
  const id = ++requestId;
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
  }

  const fetchOptions = {
    body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
    headers,
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    ...(dispatcher ? { dispatcher } : {}),
  } as unknown as RequestInit;

  let response: Response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Remote signer request timed out (${method}) after ${timeoutMs}ms`, {
        cause: err,
      });
    }
    throw err;
  }

  if (!response.ok) {
    throw new Error(
      `Remote signer request failed (${method}): HTTP ${response.status} ${response.statusText}`,
    );
  }

  const contentType = response.headers.get('content-type');

  if (!hasJsonContentType(contentType)) {
    throw new Error(
      `Remote signer request returned non-JSON content type (${method}): expected application/json, got ${contentType ?? 'no content-type header'}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new Error(`Remote signer request returned invalid JSON (${method})`, { cause });
  }

  if (!isJsonRpcResponse<T>(payload)) {
    throw new Error(
      `Remote signer request returned an unexpected response shape (${method}): missing both 'result' and 'error'`,
    );
  }

  if ('error' in payload) {
    const { code, data, message } = payload.error;
    const detail = isPrimitiveErrorData(data)
      ? ` (code ${code}, data ${String(data)})`
      : ` (code ${code})`;

    throw Object.assign(
      new Error(`Remote signer request failed (${method}): ${message}${detail}`),
      {
        rpcError: payload.error,
      },
    );
  }

  if (payload.id !== id) {
    throw new Error(
      `Remote signer request id mismatch (${method}): expected ${id}, got ${String(payload.id)}`,
    );
  }

  return payload.result;
}

function assertRecoveredAddressMatchesExpected(
  expectedAddress: Address,
  recoveredAddress: Address,
  scope: 'message' | 'transaction',
) {
  if (!isAddressEqual(recoveredAddress, expectedAddress)) {
    throw new Error(
      `Remote signer ${scope} signature recovered ${recoveredAddress}, expected ${expectedAddress}`,
    );
  }
}

function extractSignatureFromSignedTransaction(signedTransactionHex: Hex): Signature {
  let parsed;
  try {
    parsed = parseTransaction(signedTransactionHex);
  } catch (cause) {
    throw new Error(
      `Remote signer eth_signTransaction response is not a valid RLP-encoded signed transaction`,
      { cause },
    );
  }

  const { r, s, yParity, v } = parsed;

  if (r == null || s == null) {
    throw new Error(
      `Remote signer eth_signTransaction response is missing signature fields (r, s)`,
    );
  }

  if (parsed.type === 'legacy') {
    if (v == null) {
      throw new Error(`Remote signer eth_signTransaction response is missing signature fields (v)`);
    }
    return { r, s, v };
  }

  if (yParity != null) {
    return { r, s, yParity };
  }

  if (v != null) {
    return { r, s, v };
  }

  throw new Error(
    `Remote signer eth_signTransaction response is missing signature fields (yParity, v)`,
  );
}

async function requestVerifiedMessageSignature(
  config: RemoteSignerConfig,
  message: SignableMessage,
): Promise<Hex> {
  // eth_sign is safe here: the EIP-191 prefix prevents the signature from being reinterpreted as a transaction or typed data.
  const signature = await requestRemoteSigner<Hex>(config, 'eth_sign', [
    config.address,
    toSignableHex(message),
  ]);
  const recoveredAddress = await recoverMessageAddress({ message, signature });

  assertRecoveredAddressMatchesExpected(config.address, recoveredAddress, 'message');
  return signature;
}

export async function verifyRemoteSignerIdentity(config: RemoteSignerConfig): Promise<void> {
  await requestVerifiedMessageSignature(config, REMOTE_SIGNER_IDENTITY_MESSAGE);
}

export function createRemoteSignerAccount(config: RemoteSignerConfig) {
  const { address } = config;

  return toAccount({
    address,
    async signMessage({ message }) {
      return requestVerifiedMessageSignature(config, message);
    },
    async signTransaction(transaction, { serializer } = {}) {
      const signedTransactionHex = await requestRemoteSigner<Hex>(config, 'eth_signTransaction', [
        toRemoteSignerTransaction(address, transaction),
      ]);
      const signature = extractSignatureFromSignedTransaction(signedTransactionHex);
      const serialize = serializer ?? serializeTransaction;
      const signedTransaction = serialize(transaction, signature) as Parameters<
        typeof recoverTransactionAddress
      >[0]['serializedTransaction'];
      const recoveredAddress = await recoverTransactionAddress({
        serializedTransaction: signedTransaction,
      });

      assertRecoveredAddressMatchesExpected(address, recoveredAddress, 'transaction');
      return signedTransaction;
    },
    async signTypedData<
      const typedData extends TypedData | Record<string, unknown>,
      primaryType extends keyof typedData | 'EIP712Domain' = keyof typedData,
    >(_typedData: TypedDataDefinition<typedData, primaryType>) {
      throw new Error('Remote signer typed-data signing is not supported by this keeper');
    },
  });
}
