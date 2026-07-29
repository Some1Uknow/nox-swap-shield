# Swap Shield

Swap Shield is an iExec Nox integration for Ethereum Sepolia. It encrypts WETH order sizing, batches confidential ERC-7984 swap intents, and settles the aggregate through an existing Uniswap V3 pool. A minimal adapter bridges the expiry-protected router interface to Uniswap's deployed `SwapRouter02` ABI.

This repository is a public, reproducible **Sepolia hackathon build** for developers and evaluators.

## How Swap Shield works

- Users add WETH to a confidential ERC-7984 balance and submit an encrypted order amount with a minimum USDC receive amount.
- The keeper validates encrypted funding, groups at least three distinct active wallets, and relays batch preparation and settlement.
- One aggregate WETH amount settles through Uniswap V3 while per-wallet USDC allocations return as confidential ERC-7984 balances.
- Users reveal their own private balances locally and can send a chosen WETH or USDC amount to their wallet.

## Execution model

- Each submitted order carries an encrypted input amount and a proof-gated funding check.
- A batch contains three to twelve distinct wallet addresses and produces one aggregate Uniswap settlement.
- Standard Sepolia transactions carry wallet addresses, timing, token pair, deadlines, and minimum-output calldata.
- Funding adds WETH to a confidential wrapper, and batch settlement records the aggregate AMM execution on Sepolia.

The keeper sends preparation and settlement through a private relay. Signed-relay mode authenticates the exact relay payload with a dedicated auth key; `flashbots-protect` mode sends the signed transaction through Flashbots Protect's Sepolia private RPC. The keeper uses its normal RPC for reads and the private relay for settlement delivery.

## Safety properties

- The router pulls encrypted funds from the submitting wallet and binds each order to its own encrypted transfer handle.
- ERC-7984 funding is proof-gated before an order enters a batch.
- Traders can cancel pending or active orders and receive confidential input back.
- Anyone can refund an expired prepared batch; refunds are fixed to the original traders.
- The executor delivers output to the original trader addresses.
- AMM output is measured from actual ERC-20 balance deltas, and a partial input pull reverts atomically.
- ERC-20 approvals to the AMM and wrappers are reset to zero after use.
- The production deploy script uses existing Sepolia token, router, and pool addresses.

## Architecture

~~~text
user
  ├─ WETH -> ShieldedTokenIn.wrap()                 (private balance)
  └─ encrypted amount -> SwapShieldRouter.submitOrder()
                              │
                    proof-gated funded/zero validation
                              │
                     validated encrypted ERC-7984 inputs
                              │
             private-relay prepare >= 3 distinct addresses
                              │
                 aggregate unwrap + transparent AMM swap
                              │
                    ShieldedTokenOut.wrap() output
                              │
                   encrypted allocations to traders
~~~

## Prerequisites

- Node >=22.12 <27 and npm 11.12.1
- Docker for the Nox Hardhat integration tests
- An Ethereum Sepolia RPC endpoint
- Existing Sepolia ERC-20s, the official Sepolia Uniswap `SwapRouter02`, and a liquid Uniswap V3 pool
- Standard, non-rebasing ERC-20s without transfer taxes or fees
- A funded EOA used only by the private settlement keeper plus a separate unfunded relay-auth EOA
- An HTTPS private relay: either one supporting authenticated `eth_sendPrivateTransaction`, or Flashbots Protect's private RPC (`eth_sendRawTransaction`) for Sepolia

## Install and verify

~~~bash
npm ci
cd frontend && npm ci
cd ..
npm run typecheck
npm run compile
npm test
npm run audit
cd frontend && npm run build && npm run audit
~~~

Direct dependencies and both lockfiles are pinned. CI repeats the typecheck, compilation, Docker-backed Nox test suite, frontend build, and full high-severity dependency audits.

## Configure and deploy to Sepolia

~~~bash
cp .env.example .env
~~~

Set these values:

- SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY
- TOKEN_IN_ADDRESS, TOKEN_OUT_ADDRESS, AMM_ROUTER_ADDRESS (official `SwapRouter02`), AMM_POOL_ADDRESS, and POOL_FEE
- SETTLEMENT_EXECUTOR_ADDRESS, an EOA matching SETTLEMENT_EXECUTOR_PRIVATE_KEY
- MIN_BATCH_SIZE (at least 3) and MAX_BATCH_SIZE (at most 12). The router also enforces a five-minute minimum settlement window before an order can enter a batch.
- PRIVATE_RELAY_URL, PRIVATE_RELAY_MODE, PRIVATE_RELAY_AUTH_PRIVATE_KEY, and the server-only private transaction gas limits

Then deploy:

~~~bash
npm run compile
npm run deploy:sepolia
~~~

The script validates Sepolia network identity, deployed token/router bytecode, an EOA executor, configuration values, token-pair compatibility, and supported batch bounds. It deploys the Swap Shield contracts against the configured Sepolia infrastructure.

Copy the three printed public addresses into frontend/.env using [frontend/.env.example](frontend/.env.example). Keep RPC credentials, relay URLs, and private keys in server-only variables.

Before publishing, run the read-only deployment preflight and a strict browser build:

~~~bash
npm run release:preflight
~~~

The read-only preflight verifies Sepolia chain identity, bytecode,
router/wrapper immutables, executor-key binding, the NoxCompute deployment, and
the configured V3 pool pair, fee, and nonzero liquidity. It also requires the
browser configuration to contain only the seven documented public `VITE_` values
and to match the deployed stack.

## Run the frontend

~~~bash
cd frontend
cp .env.example .env
npm run build
npm run preview
~~~

The UI verifies deployed bytecode and immutable router/wrapper wiring after wallet connection, requests Ethereum Sepolia, and refreshes its session when the wallet account or chain changes. It guides users from WETH funding through encrypted order submission, batch status, private WETH recovery, private USDC balance reveal, and a two-step wallet claim. Pending claims remain in browser storage so they can be finalized after gateway propagation. The frontend CSP pins the Nox Sepolia gateway/subgraph origins; update the CSP with any intentional Nox SDK endpoint upgrade.

## Run the private keeper

The root .env must contain:

- SWAP_SHIELD_ROUTER_ADDRESS
- SEPOLIA_RPC_URL
- SETTLEMENT_EXECUTOR_PRIVATE_KEY
- PRIVATE_RELAY_URL
- PRIVATE_RELAY_MODE
- PRIVATE_RELAY_AUTH_PRIVATE_KEY
- PRIVATE_PREPARE_GAS_LIMIT, PRIVATE_SETTLEMENT_GAS_LIMIT, and MIN_PRIVATE_PRIORITY_FEE_WEI

Then run:

~~~bash
npm run keeper
~~~

On startup the keeper scans every order and batch by default (`KEEPER_RECOVERY_SCAN_LIMIT=0`) and rescans the interval between recovery and event subscription. Run it as a single serialized process, or use durable queue/indexer infrastructure for scaled operation.

## Optional scripted Sepolia order

After deployment, configure the optional TRADER_PRIVATE_KEY and amount values in
the root .env, then run:

~~~bash
npm run demo:submit
~~~

The helper encrypts against the router, sets a short-lived ERC-7984 operator,
submits the order, and immediately revokes that operator. The keeper then validates funding and settles eligible batches.

## User flow

1. Add WETH to a confidential input balance.
2. Submit an encrypted WETH amount and a minimum USDC receive amount.
3. The keeper validates encrypted funding.
4. The keeper privately prepares a batch from at least three distinct active trader addresses and submits settlement.
5. Users receive confidential ShieldedTokenOut balances. They can reveal a balance locally or unwrap a chosen amount to their wallet.

Traders can cancel pending or active orders, returning the encrypted input to their Private WETH balance. Expired prepared batches return encrypted input to the original traders.

## Test-only fixtures

`contracts/testdex/` contains an unlimited-faucet ERC-20 and minimal AMM for Docker-backed local tests. Sepolia deployment uses the configured token, router, and pool contracts.

## Sepolia release gate

Before publishing a live demo or repository link:

1. Run the full Docker-backed npm test suite and `npm run audit` in both the root and frontend, then record the results.
2. Verify deployed bytecode and constructor arguments on Sepolia.
3. Test the exact configured private relay with a three-order Sepolia batch.
4. Confirm the configured AMM pool has real liquidity for the selected pair and fee tier.
5. Run `npm run release:preflight`; it checks the actual on-chain wiring and fails if frontend/.env contains an unexpected or secret-bearing `VITE_` variable.
6. Record deployment addresses and successful transaction hashes in the project release notes/demo.

## Hackathon demo checklist

1. Show a real Sepolia token/router configuration and verified deployment addresses.
2. Fund three confidential user balances in advance.
3. Submit three encrypted orders, then show funding validation without revealing input values.
4. Show public order events contain no input amount.
5. Show the private-relay preparation/settlement flow and the one aggregate AMM transaction.
6. Show confidential output balances plus a cancellation or expired-batch refund.

## Hackathon work and originality

Swap Shield was built for the iExec Nox WTF Hackathon as an original integration.
The application-specific router, private keeper, Sepolia deployment/preflight
tooling, browser interface, tests, and documentation in this repository are the
hackathon work. It uses the open-source iExec Nox packages, OpenZeppelin
contracts, Hardhat, React, Ethers, and Viem listed in the lockfiles.

Before final submission, the team should retain written organizer confirmation
if any unpublished precursor or shared component could reasonably be considered
prior hackathon work.

## Beta deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the Sepolia release sequence, Railway
repository-linked services, required variables, health checks, rollback, and
evidence that must be recorded before the public beta is announced. See
[BETA_LAUNCH.md](BETA_LAUNCH.md) for the final Vercel, keeper, three-wallet,
and submission checklist.

## Feedback

See [feedback.md](feedback.md) for iExec Nox developer-experience feedback.

## License

MIT
