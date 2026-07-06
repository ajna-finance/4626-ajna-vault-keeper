import net from 'net';
import { spawn, spawnSync } from 'child_process';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { createTestConfigPath, loadTestEnv, removeTestConfigPath } from './testEnv.ts';

loadTestEnv('.env');
process.env.TEST_ENV = 'true';
if (!process.env.MAINNET_RPC_URL) {
  process.env.MAINNET_RPC_URL = 'https://eth.drpc.org';
}
process.env.RPC_URL = 'http://127.0.0.1:8545';
process.env.PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env.CONFIG_PATH = createTestConfigPath();

let anvilProcess: ReturnType<typeof spawn>;

async function deployContracts(): Promise<void> {
  let forgePath = 'forge';

  if (process.env.CI) {
    const pathDirs = process.env.PATH?.split(':') || [];
    const foundryDir = pathDirs.find((dir) => dir.includes('/tmp/') && dir.includes('-'));
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
      id: 1,
    }),
  });

  const scripts = [];

  if (process.env.INTEGRATION === 'true') {
    scripts[0] = 'test/script/deploy.integration.s.sol:DeployScript';
  } else if (process.env.METAVAULT === 'true') {
    scripts[0] = 'test/script/deploy.metavault-arks.s.sol:DeployScript';
    scripts[1] = 'test/script/deploy.metavault-external.s.sol:DeployScript';
  } else {
    scripts[0] = 'test/script/deploy.unit.s.sol:DeployScript';
  }

  const addressesFile = path.join(process.cwd(), './test/script/test-addresses.env');
  fs.writeFileSync(addressesFile, '');

  for (let i = 0; i < scripts.length; i++) {
    const scriptAddresses =
      i > 0 && fs.existsSync(addressesFile)
        ? dotenv.parse(fs.readFileSync(addressesFile, 'utf-8'))
        : {};

    const res = spawnSync(
      forgePath,
      [
        'script',
        scripts[i] as string,
        '--rpc-url',
        'http://127.0.0.1:8545',
        '--broadcast',
        '--skip-simulation',
        '--private-key',
        process.env.PRIVATE_KEY!,
        '--json',
        '-vvvv',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...scriptAddresses, FOUNDRY_PROFILE: 'default' },
        stdio: process.env.TESTS === 'verbose' ? 'inherit' : 'pipe',
        maxBuffer: 100 * 1024 * 1024,
      },
    );

    if (res.status !== 0) {
      throw new Error(
        `forge script failed (${res.status}).\nstdout:\n${res.stdout?.toString()}\nstderr:\n${res.stderr?.toString()}`,
      );
    }
  }

  if (fs.existsSync(addressesFile)) {
    const addressesContent = fs.readFileSync(addressesFile, 'utf-8');
    const addresses = dotenv.parse(addressesContent);

    if (process.env.METAVAULT !== 'true') {
      process.env.MOCK_VAULT_ADDRESS = addresses.MOCK_VAULT_ADDRESS;
      process.env.MOCK_VAULT_AUTH_ADDRESS = addresses.MOCK_VAULT_AUTH_ADDRESS;
      process.env.MOCK_CHRONICLE_ADDRESS = addresses.MOCK_CHRONICLE_ADDRESS;
      process.env.INTEGRATION_TEST = 'true';

      const testConfig = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'config.test.json'), 'utf-8'),
      );

      testConfig.oracle.onchainMaxStaleness = null;

      for (const ark of testConfig.arks) {
        ark.vaultAddress = addresses.VAULT_ADDRESS;
        ark.vaultAuthAddress = addresses.VAULT_AUTH_ADDRESS;
      }
      fs.writeFileSync(process.env.CONFIG_PATH!, JSON.stringify(testConfig, null, 2));
    } else {
      process.env.AAVE_VAULT_ADDRESS = addresses.AAVE_VAULT_ADDRESS;
      process.env.ARK_1_ADDRESS = addresses.ARK_1_ADDRESS;
      process.env.ARK_2_ADDRESS = addresses.ARK_2_ADDRESS;
      process.env.ARK_3_ADDRESS = addresses.ARK_3_ADDRESS;
      process.env.ARK_AUTH_1_ADDRESS = addresses.ARK_AUTH_1_ADDRESS;
      process.env.ARK_AUTH_2_ADDRESS = addresses.ARK_AUTH_2_ADDRESS;
      process.env.ARK_AUTH_3_ADDRESS = addresses.ARK_AUTH_3_ADDRESS;

      const testConfig = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'config.test.json'), 'utf-8'),
      );

      testConfig.oracle.onchainMaxStaleness = null;
      testConfig.metavaultAddress = addresses.METAVAULT_ADDRESS;
      testConfig.arks[0].address = addresses.ARK_1_ADDRESS;
      testConfig.arks[1].address = addresses.ARK_2_ADDRESS;
      testConfig.arks[2].address = addresses.ARK_3_ADDRESS;
      testConfig.arks[0].vaultAddress = addresses.ARK_1_ADDRESS;
      testConfig.arks[1].vaultAddress = addresses.ARK_2_ADDRESS;
      testConfig.arks[2].vaultAddress = addresses.ARK_3_ADDRESS;
      testConfig.arks[0].vaultAuthAddress = addresses.ARK_AUTH_1_ADDRESS;
      testConfig.arks[1].vaultAuthAddress = addresses.ARK_AUTH_2_ADDRESS;
      testConfig.arks[2].vaultAuthAddress = addresses.ARK_AUTH_3_ADDRESS;
      testConfig.buffer.address = addresses.AAVE_VAULT_ADDRESS;
      fs.writeFileSync(process.env.CONFIG_PATH!, JSON.stringify(testConfig, null, 2));
    }
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

    anvilProcess = spawn(
      'anvil',
      [
        '--fork-url',
        forkUrl,
        '--chain-id',
        '1',
        '--fork-block-number',
        '23227726',
        '--port',
        port.toString(),
      ],
      {
        stdio: process.env.TESTS === 'verbose' ? 'inherit' : 'pipe',
      },
    );
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
      id: 1,
    }),
  });

  await fetch('http://localhost:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'anvil_setBalance',
      params: ['0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf', '0x1000000000000000000000'],
      id: 1,
    }),
  });

  await fetch('http://localhost:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_sendTransaction',
      params: [
        {
          from: '0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf',
          to: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
          data:
            '0xa9059cbb' +
            '000000000000000000000000f39Fd6e51aad88F6F4ce6aB8827279cffFb92266' +
            '00000000000000000000000000000000000000000000021e19e0c9bab2400000',
          gas: '0x186A0',
          maxFeePerGas: '0x77359400',
          maxPriorityFeePerGas: '0x3B9ACA00',
          value: '0x0',
        },
      ],
      id: 2,
    }),
  });

  await fetch('http://localhost:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'evm_mine',
      params: [],
      id: 3,
    }),
  });
}

export async function teardown() {
  anvilProcess?.kill();
  removeTestConfigPath(process.env.CONFIG_PATH);
}
