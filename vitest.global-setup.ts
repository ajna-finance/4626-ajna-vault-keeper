import net from 'net';
import { spawn, spawnSync } from 'child_process';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: '.env.test' });
process.env.TEST_ENV = 'true';
process.env.MAINNET_RPC_URL = process.env.RPC_URL;
process.env.RPC_URL = 'http://127.0.0.1:8545';
process.env.PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env.CHAIN_NAME = 'Ethereum';
process.env.OPTIMAL_BUCKET_DIFF = '1';
process.env.ONCHAIN_ORACLE_PRIMARY = 'true';
process.env.MIN_MOVE_AMOUNT = '1000000';
process.env.LOG_LEVEL = 'warn';
process.env.KEEPER_INTERVAL_MS = '43200000';
process.env.ORACLE_API_URL = 'https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=0x6B175474E89094C44Da98b954EedeAC495271d0F&vs_currencies=usd';
process.env.QUOTE_TOKEN_ADDRESS = '0x6b175474e89094c44da98b954eedeac495271d0f';

let anvilProcess: ReturnType<typeof spawn>;

async function deployContracts(): Promise<void> {
  let forgePath = 'forge';
  
  if (process.env.CI) {
    const pathDirs = process.env.PATH?.split(':') || [];
    const foundryDir = pathDirs.find(dir => dir.includes('/tmp/') && dir.includes('-'));
    if (foundryDir) {
      forgePath = `${foundryDir}/forge`;
    }
  }

  await fetch(process.env.RPC_URL ?? 'http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'anvil_setNonce',
      params: ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x0'],
      id: 1
    })
  });

  const script = process.env.INTEGRATION === 'true' ? 'test/script/deploy.integration.s.sol:DeployScript' : 'test/script/deploy.unit.s.sol:DeployScript';

  const res = spawnSync(forgePath, [
    'script',
    script,
    '--rpc-url', 'http://127.0.0.1:8545',
    '--broadcast',
    '--skip-simulation',
    '--private-key', process.env.PRIVATE_KEY!,
    '--json',
    '-vvvv'
  ], {
    cwd: process.cwd(),
    env: { ...process.env, FOUNDRY_PROFILE: 'default' },
    stdio: process.env.TESTS === 'verbose' ? 'inherit' : 'pipe'
  });

  if (res.status !== 0) {
    throw new Error(
      `forge script failed (${res.status}).\nstdout:\n${res.stdout?.toString()}\nstderr:\n${res.stderr?.toString()}`
    );
  }

  const addressesFile = path.join(process.cwd(), './test/script/test-addresses.env');
  if (fs.existsSync(addressesFile)) {
    const addressesContent = fs.readFileSync(addressesFile, 'utf-8');
    const addresses = dotenv.parse(addressesContent);
    process.env.VAULT_ADDRESS = addresses.VAULT_ADDRESS;
    process.env.VAULT_AUTH_ADDRESS = addresses.VAULT_AUTH_ADDRESS;
    process.env.MOCK_VAULT_ADDRESS = addresses.MOCK_VAULT_ADDRESS;
    process.env.MOCK_VAULT_AUTH_ADDRESS = addresses.MOCK_VAULT_AUTH_ADDRESS;
    process.env.MOCK_CHRONICLE_ADDRESS = addresses.MOCK_CHRONICLE_ADDRESS;
  } else {
    throw new Error('Deployment addresses file not found');
  }
}

function waitForPort(port: number, host = '127.0.0.1', timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const check = () => {
      const socket = net.createConnection(port, host, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('Timed out waiting for Anvil'));
        setTimeout(check, 100);
      });
    };
    check();
  });
}

export async function setup() {
  if (!process.env.CI) {
    const forkUrl = process.env.MAINNET_RPC_URL;
    const rpcUrl = process.env.RPC_URL;
    
    if (!forkUrl || !rpcUrl) {
      throw new Error('Missing required env vars');
    }
    
    const port = parseInt(rpcUrl.split(':').pop() || '8545');
    
    anvilProcess = spawn('anvil', [
      '--fork-url', forkUrl,
      '--chain-id', '1',
      '--fork-block-number', '23227726',
      '--port', port.toString()
    ], {
      stdio: process.env.TESTS === 'verbose' ? 'inherit' : 'pipe',
    });
  }
  await waitForPort(8545);
  if (process.env.INTEGRATION !== 'true') await fundTestAccount();
  await deployContracts();
}

async function fundTestAccount() {
  await fetch('http://localhost:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'anvil_impersonateAccount',
      params: ['0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf'],
      id: 1
    })
  });

  await fetch('http://localhost:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'anvil_setBalance',
      params: [
        '0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf',
        '0x1000000000000000000000'
      ],
      id: 1
    })
  });

  await fetch('http://localhost:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_sendTransaction',
      params: [{
        from: '0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf',
        to: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
        data: '0xa9059cbb' +
              '000000000000000000000000f39Fd6e51aad88F6F4ce6aB8827279cffFb92266' +
              '00000000000000000000000000000000000000000000021e19e0c9bab2400000',
        gas: '0x186A0',
        maxFeePerGas: '0x77359400',
        maxPriorityFeePerGas: '0x3B9ACA00',
        value: '0x0'
      }],
      id: 2
    })
  });

  await fetch('http://localhost:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'evm_mine',
      params: [],
      id: 3
    })
  });
}

export async function teardown() {
  anvilProcess?.kill();
}
