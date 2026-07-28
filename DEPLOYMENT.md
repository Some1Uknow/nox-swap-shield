# Swap Shield beta deployment

This runbook deploys the public frontend and private settlement keeper from the
same public GitHub repository. Every push to `main` should pass GitHub Actions
before Railway deploys it.

## 1. Deploy the Sepolia contracts

Create a local root `.env` from `.env.example`. Use real Sepolia ERC-20
contracts and a liquid Uniswap V3-compatible pool; never use
`contracts/testdex/` for the public beta.

Run:

```bash
npm run release:check
npm run deploy:sepolia
```

Record the deployed wrapper/router addresses, constructor arguments, deployment
transactions, selected token pair, pool fee, and pool address. Verify the source
on the Sepolia explorer before inviting users.

## 2. Configure the repository-linked frontend service

Create a Railway service named `swap-shield-web` from the GitHub repository:

- branch: `main`
- root directory: `/`
- config file path: `/frontend/railway.json`
- public port: `8080`
- Wait for CI: enabled

Set only these public build variables:

```text
VITE_TOKEN_IN_ADDRESS
VITE_TOKEN_OUT_ADDRESS
VITE_SHIELDED_TOKEN_IN_ADDRESS
VITE_SHIELDED_TOKEN_OUT_ADDRESS
VITE_SWAP_SHIELD_ROUTER_ADDRESS
VITE_CHAIN_ID=11155111
VITE_POOL_FEE
```

Generate a Railway domain on port `8080`. A healthy deployment must return
`200 ok` from `/healthz` and include the CSP/security headers defined in
`frontend/nginx.conf`.

## 3. Configure the private keeper service

Create a Railway service named `swap-shield-keeper` from the same repository:

- branch: `main`
- root directory: `/`
- config file path: `/railway.keeper.json`
- no public domain
- one replica only
- Wait for CI: enabled

Set the server-only variables from `.env.example`:

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

Do not add any private value to a `VITE_` variable. Keep the executor and relay
authentication accounts separate. Do not expose a public domain for the keeper.

## 4. Release preflight

With the same production values available locally, run:

```bash
npm run release:preflight
```

The preflight must pass before the frontend is announced. It verifies Sepolia,
deployed bytecode, router and wrapper wiring, executor binding, the NoxCompute
contract, pool pair/fee/liquidity, and the browser configuration.

## 5. Real end-to-end smoke test

Use three distinct test wallets:

1. Fund each confidential input balance separately from its order.
2. Submit one encrypted order from each wallet.
3. Confirm each order activates without exposing its input amount.
4. Confirm the keeper privately prepares and settles one batch.
5. Confirm one aggregate AMM swap on Sepolia.
6. Decrypt each confidential output balance locally.
7. Test one cancellation or an expired-batch refund.

Save every relevant explorer transaction and the keeper deployment identifier.
Do not label the beta ready based only on local DemoAMM tests.

## 6. Monitoring and rollback

- Subscribe to the Nox status page and monitor keeper logs.
- Keep exactly one keeper replica unless the queue is redesigned for distributed
  coordination.
- If the keeper repeatedly fails, stop accepting new beta orders, preserve the
  private-relay-only rule, and use the permissionless expired-batch refund path.
- Roll back the web service to the last successful Railway deployment.
- Never add a public settlement fallback.

## Release evidence

Complete this table before publishing:

| Evidence | Value |
| --- | --- |
| Public repository | Pending |
| Live frontend | Pending |
| Router | Pending |
| Shielded input token | Pending |
| Shielded output token | Pending |
| AMM router/pool/fee | Pending |
| Deployment transactions | Pending |
| Three-wallet settlement | Pending |
| GitHub Actions run | Pending |
| Railway web deployment | Pending |
| Railway keeper deployment | Pending |
| Demo video | Pending |
| X submission post | Pending |
