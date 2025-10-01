# AJNA 4626 Keeper

This keeper is a permissioned off-chain agent that periodically rebalances the ERC-4626 Ajna Vault by moving quote tokens between Ajna buckets and the Buffer based on bucket price (derived from market price) and vault policy. This mechanism effectively channels liquidity into the bucket that offers optimal yield within predefined bounds. The keeper is authorised in `VaultAuth`, runs on a fixed interval and follows strict bail-out conditions to avoid unsafe actions.

## Set up

#### Install:

```
pnpm install --frozen-lockfile --ignore-scripts
```

#### Install submodules:

```
git submodule update --init --recursive
```

#### Build:

```
pnpm build
```

#### Docker:

If using Docker, the above steps can be skipped. Instead, build locally with:

```
pnpm docker:build:local
```

Or build for production using:

```
pnpm docker:build:prod
```

Note that local builds inject `.env`, while production builds expect environment variables to be provided at runtime.

After building, run the keeper locally with:

```
pnpm docker:run:local
```

There is no default script for running the keeper in production, since this is likely to be environment-specific.

## Configure environment

Locally, you can define necessary values in `.env`. In production, these should be provided at runtime from the deployment environment.

To do this locally:

```
cp .env.example .env
```

Then replace the placeholder values in `.env`.

## Run tests

First, complete the above steps for local configuration and set up. Then, install `foundryup`:

```
curl -L https://foundry.paradigm.xyz | bash
```

After following the instructions that will appear from `foundryup`, run the tests:

```
pnpm test
```
