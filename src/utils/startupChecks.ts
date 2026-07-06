import { type Address } from 'viem';
import { config } from './config.ts';
import { contract } from './contract.ts';
import { client, readOnlyClient } from './client.ts';
import { log } from './logger.ts';

type MetavaultStrategyConfig = {
  balance: bigint;
  cap: bigint;
  enabled: boolean;
  removableAt: bigint;
};

export async function runStartupChecks(): Promise<void> {
  await verifyChainId();
  if (config.metavaultAddress) {
    await verifyMetavaultDeployment(config.metavaultAddress);
  }
  log.info({ event: 'startup_checks_passed' }, 'startup checks passed');
}

async function verifyChainId(): Promise<void> {
  const connectedChainId = await readOnlyClient.getChainId();
  if (connectedChainId !== config.chainId) {
    throw new Error(
      `chain id mismatch: config.chainId is ${config.chainId} but RPC reports ${connectedChainId}`,
    );
  }
}

async function verifyMetavaultDeployment(metavaultAddress: Address): Promise<void> {
  const metavault = contract('metavault', metavaultAddress)();

  const [asset, owner, curator, isAllocator] = (await Promise.all([
    metavault.read.asset(),
    metavault.read.owner(),
    metavault.read.curator(),
    metavault.read.isAllocator([client.account.address]),
  ])) as [Address, Address, Address, boolean];

  if (asset.toLowerCase() !== config.quoteTokenAddress.toLowerCase()) {
    throw new Error(
      `metavault asset (${asset}) does not match config.quoteTokenAddress (${config.quoteTokenAddress})`,
    );
  }

  const caller = client.account.address.toLowerCase();
  const authorized =
    isAllocator || caller === owner.toLowerCase() || caller === curator.toLowerCase();
  if (!authorized) {
    throw new Error(
      `keeper account ${client.account.address} is not authorized to allocate on metavault ${metavaultAddress}`,
    );
  }

  const strategyTargets: Array<{ path: string; address: Address }> = [
    { path: 'buffer', address: config.buffer.address },
    ...config.arks.map((ark, i) => ({ path: `arks[${i}]`, address: ark.address })),
  ];

  for (const target of strategyTargets) {
    const strategy = (await metavault.read.config([target.address])) as MetavaultStrategyConfig;
    if (!strategy.enabled) {
      throw new Error(`metavault strategy for ${target.path} (${target.address}) is not enabled`);
    }
    if (strategy.cap === 0n) {
      throw new Error(
        `metavault strategy for ${target.path} (${target.address}) has zero supply cap`,
      );
    }
  }

  for (const [i, ark] of config.arks.entries()) {
    const vaultAuth = contract('vaultAuth', ark.vaultAuthAddress)();
    const bufferRatio = (await vaultAuth.read.bufferRatio()) as bigint;
    if (bufferRatio !== 0n) {
      throw new Error(
        `metavault-managed arks[${i}] (${ark.vaultAddress}) has non-zero bufferRatio ${bufferRatio}; managed arks must use bufferRatio 0`,
      );
    }
  }
}
