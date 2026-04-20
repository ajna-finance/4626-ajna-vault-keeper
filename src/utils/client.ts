import { readFileSync } from 'fs';
import {
  createWalletClient,
  createPublicClient,
  http,
  publicActions,
  type Account,
  type Chain,
} from 'viem';
import * as allChains from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Agent } from 'undici';
import { credentialMode, env } from './env.ts';
import { config } from './config.ts';
import { log } from './logger.ts';
import { loadPrivateKeyFromKeystore } from './keystore.ts';
import { createRemoteSignerAccount, verifyRemoteSignerIdentity } from './remoteSigner.ts';

const transport = process.env.TEST_ENV === 'true' ? 'http://127.0.0.1:8545' : env.RPC_URL;

function getChain(chainId: number): Chain {
  for (const chain of Object.values(allChains)) {
    if ('id' in chain && chain.id === chainId) {
      return chain as Chain;
    }
  }

  log.warn(
    { event: 'unknown_chain_id', chainId: chainId },
    `Unknown Chain ID ${chainId}, using custom configuration.`,
  );

  return {
    id: chainId,
    name: 'Custom Chain',
    nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    rpcUrls: {
      default: { http: [env.RPC_URL as string] },
      public: { http: [env.RPC_URL as string] },
    },
  } as Chain;
}

const targetChain = getChain(config.chainId);

function buildClients(account: Account) {
  const walletClient = createWalletClient({
    account,
    chain: targetChain,
    transport: http(transport),
  }).extend(publicActions);

  const publicClient = createPublicClient({
    chain: targetChain,
    transport: http(transport),
  });

  return { walletClient, publicClient } as const;
}

type Clients = ReturnType<typeof buildClients>;

export let client: Clients['walletClient'];
export let readOnlyClient: Clients['publicClient'];
let remoteSignerIdentityVerified = false;
let remoteSignerDispatcher: Agent | undefined;

function getRemoteSignerDispatcher(): Agent | undefined {
  if (remoteSignerDispatcher !== undefined) return remoteSignerDispatcher;

  const cert = env.REMOTE_SIGNER_TLS_CLIENT_CERT;
  const key = env.REMOTE_SIGNER_TLS_CLIENT_KEY;
  const ca = env.REMOTE_SIGNER_TLS_CA;

  if (!cert && !key && !ca) return undefined;

  const connect: Record<string, unknown> = {};
  if (cert) connect.cert = readFileSync(cert);
  if (key) connect.key = readFileSync(key);
  if (env.REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD) {
    connect.passphrase = env.REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD;
  }
  if (ca) connect.ca = readFileSync(ca);

  remoteSignerDispatcher = new Agent({ connect });
  return remoteSignerDispatcher;
}

function buildRemoteSignerConfig() {
  return {
    address: env.REMOTE_SIGNER_ADDRESS as `0x${string}`,
    authToken: env.REMOTE_SIGNER_AUTH_TOKEN,
    dispatcher: getRemoteSignerDispatcher(),
    timeoutMs: config.remoteSigner.requestTimeoutMs,
    url: env.REMOTE_SIGNER_URL!,
  };
}

function setClients(account: Account): void {
  const built = buildClients(account);
  client = built.walletClient;
  readOnlyClient = built.publicClient;
}

function createEphemeralReadOnlyAccount(): Account {
  log.info(
    { event: 'client_readonly_mode' },
    'recovery-detect mode: using ephemeral key, no txs will be signed',
  );
  return privateKeyToAccount(generatePrivateKey());
}

function createImmediateAccount(): Account | null {
  if (env.BOT_MODE === 'recovery-detect') {
    return createEphemeralReadOnlyAccount();
  }

  if (credentialMode === 'privateKey') {
    return privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
  }

  if (credentialMode === 'remoteSigner') {
    return createRemoteSignerAccount(buildRemoteSignerConfig());
  }

  return null;
}

async function loadAccount(): Promise<Account> {
  const immediateAccount = createImmediateAccount();
  if (immediateAccount) return immediateAccount;

  if (credentialMode === 'keystore') {
    log.info(
      { event: 'keystore_load', path: env.KEYSTORE_PATH },
      'Loading private key from keystore',
    );
    const privateKey = await loadPrivateKeyFromKeystore(env.KEYSTORE_PATH!);
    const account = privateKeyToAccount(privateKey);
    log.info(
      { event: 'keystore_decrypted', address: account.address },
      'Keystore decrypted successfully',
    );
    return account;
  }

  throw new Error(`Unsupported credential mode: ${credentialMode}`);
}

const immediateAccount = createImmediateAccount();

if (immediateAccount) {
  setClients(immediateAccount);
}

async function assertChainMatch(): Promise<void> {
  // Catches the case where RPC_URL serves a different chain than config.chainId
  // declares. On a mismatch we'd send txs on the wrong chain. Retries transient RPC
  // errors so a short startup hiccup doesn't crash the bot; a genuine
  // mismatch fails immediately without retrying.
  if (!readOnlyClient) {
    throw new Error('assertChainMatch called before client was initialized');
  }
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  let onchainId: number | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      onchainId = await readOnlyClient.getChainId();
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = 500 * attempt;
        log.warn(
          { event: 'chain_check_retry', attempt, backoffMs, err },
          `RPC chainId check failed, retrying in ${backoffMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  if (onchainId === undefined) {
    log.fatal(
      { event: 'chain_check_exhausted', err: lastErr },
      'RPC chainId check failed after retries',
    );
    throw lastErr;
  }
  if (onchainId !== config.chainId) {
    const msg = `chain mismatch: RPC reports chainId=${onchainId} but config.chainId=${config.chainId}`;
    log.fatal({ event: 'chain_mismatch', onchainId, configChainId: config.chainId }, msg);
    throw new Error(msg);
  }
}

export async function initClient(): Promise<void> {
  if (!client) {
    setClients(await loadAccount());
  }

  if (credentialMode === 'remoteSigner' && !remoteSignerIdentityVerified) {
    await verifyRemoteSignerIdentity(buildRemoteSignerConfig());
    log.info(
      { event: 'remote_signer_identity_verified', address: env.REMOTE_SIGNER_ADDRESS },
      'Remote signer identity verified',
    );
    remoteSignerIdentityVerified = true;
  }

  await assertChainMatch();
}
