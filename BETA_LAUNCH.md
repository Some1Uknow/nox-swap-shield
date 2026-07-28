# Swap Shield beta-launch guide

This is the release order for the public Sepolia beta. The repository, GitHub
Actions, branch protection, and Vercel project are ready. Do not announce the
application until every release gate below passes.

## Current hosting state

- The Vercel project is `nox-swap-shield-web`, linked to
  `Some1Uknow/nox-swap-shield`.
- `https://nox-swap-shield-web.vercel.app` returns `DEPLOYMENT_NOT_FOUND`
  until the first successful Vercel build. This is expected: the release build
  rejects missing contract addresses rather than publishing a broken dApp.
- Railway web and keeper sources are paused. Reconnect only after the real
  configuration is ready, so placeholder deployments do not create misleading
  GitHub checks.

## 1. Provision Sepolia infrastructure

Run this once from the repository root:

```bash
npm run bootstrap:sepolia
```

It generates three fresh **Sepolia-only** EOAs in the ignored local `.env`,
derives the executor address, and validates the default standard Sepolia RPC
and Flashbots Sepolia relay. It prints only the public addresses that need
funding, never the private keys. You may replace either endpoint later with a
provider of your choice.

The `.env` then contains:

```text
SEPOLIA_RPC_URL
DEPLOYER_PRIVATE_KEY
SETTLEMENT_EXECUTOR_PRIVATE_KEY
PRIVATE_RELAY_URL
PRIVATE_RELAY_AUTH_PRIVATE_KEY
```

- Fund the printed deployer address with Sepolia ETH for contract deployment.
- Fund the printed settlement executor address with Sepolia ETH for private
  batch transactions.
- Keep the relay-auth account separate and unfunded.
- Use an HTTPS relay that supports Sepolia `eth_sendPrivateTransaction`.
- Select existing, non-demo ERC-20s and a liquid Uniswap V3-compatible Sepolia
  pool. The release preflight rejects zero pool liquidity.

## 2. Validate, deploy, and verify contracts

```bash
npm run release:check
npm run deploy:sepolia
```

Copy the three deployment outputs into root `.env`:

```text
SHIELDED_TOKEN_IN_ADDRESS
SHIELDED_TOKEN_OUT_ADDRESS
SWAP_SHIELD_ROUTER_ADDRESS
```

Copy the matching public values into `frontend/.env`:

```text
VITE_TOKEN_IN_ADDRESS
VITE_TOKEN_OUT_ADDRESS
VITE_SHIELDED_TOKEN_IN_ADDRESS
VITE_SHIELDED_TOKEN_OUT_ADDRESS
VITE_SWAP_SHIELD_ROUTER_ADDRESS
VITE_CHAIN_ID=11155111
VITE_POOL_FEE
```

Verify deployment code and constructor values on a Sepolia explorer, then run:

```bash
npm run release:preflight
```

## 3. Deploy the public frontend on Vercel

Set the seven `VITE_` values as Vercel **Production** environment variables.
They are public build-time configuration only. Then create the first production
deployment:

```bash
vercel --prod
```

Verify the Vercel domain serves the app, `/healthz` returns `200`, and the
headers in `vercel.json` are present. Later GitHub `main` pushes deploy the
frontend automatically.

## 4. Configure and reconnect the private keeper

Set these server-only Railway values on `swap-shield-keeper`:

```text
SWAP_SHIELD_ROUTER_ADDRESS
SEPOLIA_RPC_URL
SETTLEMENT_EXECUTOR_PRIVATE_KEY
PRIVATE_RELAY_URL
PRIVATE_RELAY_AUTH_PRIVATE_KEY
BATCH_WINDOW_MS
PRIVATE_TX_TIMEOUT_MS
PRIVATE_TX_TTL_BLOCKS
PRIVATE_PREPARE_GAS_LIMIT
PRIVATE_SETTLEMENT_GAS_LIMIT
MIN_PRIVATE_PRIORITY_FEE_WEI
KEEPER_RECOVERY_SCAN_LIMIT=0
```

Never add a key, RPC URL, or relay URL as a `VITE_` variable. Run one keeper
replica only, give it no public domain, and reconnect its GitHub source only
after the variables are present.

## 5. Complete the real beta proof

Use three distinct disposable trader wallets:

1. Fund and wrap each input balance separately from the eventual order.
2. Submit one encrypted order per wallet.
3. Confirm all three orders activate without revealing input amounts.
4. Confirm the keeper privately prepares and settles one batch.
5. Confirm one aggregate Sepolia AMM swap.
6. Decrypt each confidential output locally.
7. Test cancellation or an expired-batch refund.

Save explorer links, the Vercel URL, Railway keeper deployment ID, and redacted
keeper logs in `DEPLOYMENT.md`.

## 6. Submit the hackathon project

- Record a real demo of four minutes or less.
- Keep the privacy caveat visible: individual swap sizes are confidential, but
  transparent AMM settlement reveals the aggregate and distinct addresses do
  not prove distinct people.
- Publish the X post with the demo, GitHub repository, and `@iEx_ec` tag.
- Submit through Discord.
