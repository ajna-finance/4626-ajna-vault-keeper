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
import { privateKeyToAccount } from 'viem/accounts';
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

function createImmediateAccount(): Account | null {
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
}
