# Swap Shield

Swap Shield is an iExec Nox integration for Ethereum Sepolia. It batches confidential ERC-7984 swap intents against an existing Uniswap V3-compatible AMM without modifying the AMM.

This repository is a public, reproducible **Sepolia hackathon build**, not a mainnet financial product. Do not deploy it with valuable assets without an independent smart-contract, infrastructure, and private-relay review.

## What is private — and what is not

Protected by Nox:

- The input amount in each submitted order is encrypted.
- A nonzero ERC-7984 transfer must be proved before an order becomes batchable; the proof reveals only funded/not-funded, never the amount.
- The router requires validated orders from at least three distinct wallet addresses per batch.
- Individual output allocations are re-wrapped as confidential ERC-7984 balances.

Public by design:

- Wallet addresses, order timing, token pair, deadlines, and the user's minimum-output calldata are public.
- Funding an ERC-20 balance into a confidential wrapper is public. Fund separately from a specific order.
- Distinct wallet addresses improve the batch anonymity set but do not prove distinct people; one party can still control multiple addresses.
- The aggregate input and AMM execution become public when a prepared batch is unwrapped and settled.
- prepareBatch creates a publicly decryptable aggregate request once it is mined. A private relay reduces transaction-mempool exposure, but it does **not** guarantee aggregate secrecy or eliminate post-preparation MEV. Do not market this build as an atomic MEV-protection system without a purpose-built atomic builder/TEE integration.

The provided keeper sends both preparation and settlement through a private relay and has no public settlement fallback. It sends an explicit empty privacy-hint list and authenticates the exact relay payload with a dedicated auth key. Its normal RPC is never asked to estimate or broadcast the settlement calldata, because the Nox decryption proof carries the aggregate plaintext. The relay and any builder it uses remain trusted infrastructure parties.

## Safety properties

- The router pulls encrypted funds from msg.sender; it never accepts a caller-supplied unwrap request ID.
- ERC-7984 safe transfers that resolve to encrypted zero are proof-gated and rejected before they can enter a batch.
- Traders can cancel pending or active orders and receive confidential input back.
- Anyone can refund an expired prepared batch; refunds are fixed to the original traders.
- The executor cannot redirect output recipients.
- AMM output is measured from actual ERC-20 balance deltas, and a partial input pull reverts atomically.
- ERC-20 approvals to the AMM and wrappers are reset to zero after use.
- The production deploy script accepts existing Sepolia contracts only; it will not deploy the bundled faucet or demo AMM.

## Architecture

~~~text
user
  ├─ public ERC-20 -> ShieldedTokenIn.wrap()        (fund separately)
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
- Existing Sepolia ERC-20s and a liquid Uniswap V3-compatible router/pool
- Standard, non-rebasing ERC-20s with no transfer tax or fee-on-transfer behavior
- A funded EOA used only by the private settlement keeper plus a separate unfunded relay-auth EOA
- An HTTPS private relay that supports eth_sendPrivateTransaction and returns a canonical transaction hash

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
- TOKEN_IN_ADDRESS, TOKEN_OUT_ADDRESS, AMM_ROUTER_ADDRESS, AMM_POOL_ADDRESS, and POOL_FEE
- SETTLEMENT_EXECUTOR_ADDRESS, an EOA matching SETTLEMENT_EXECUTOR_PRIVATE_KEY
- MIN_BATCH_SIZE (at least 3) and MAX_BATCH_SIZE (at most 12). The router also enforces a five-minute minimum settlement window before an order can enter a batch.
- PRIVATE_RELAY_URL, PRIVATE_RELAY_AUTH_PRIVATE_KEY, and the server-only private transaction gas limits

Then deploy:

~~~bash
npm run compile
npm run deploy:sepolia
~~~

The script refuses non-Sepolia networks, missing code at the configured token/router addresses, a contract executor, malformed values, same-token pairs, and unsupported batch bounds. It deliberately never deploys TestERC20 or DemoAMM.

Copy the three printed public addresses into frontend/.env using [frontend/.env.example](frontend/.env.example). Never put an RPC credential, relay URL, or private key in a VITE_ variable.

Before publishing, run the read-only deployment preflight and a strict browser build:

~~~bash
npm run release:preflight
~~~

The preflight sends no transactions. It verifies Sepolia chain identity, bytecode,
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

The UI is loopback-only in development/preview, verifies deployed bytecode and immutable router/wrapper wiring after wallet connection, requests Ethereum Sepolia, and clears its session if the wallet account or chain changes. It separates public funding from encrypted order submission and never exposes a public settlement control. It can decrypt a user's confidential output balance locally and supports an explicit, two-step public withdrawal; a pending withdrawal is retained in browser storage so it can be finalized after gateway propagation. The frontend CSP permits only the pinned Nox Sepolia gateway/subgraph origins; update the CSP with any intentional Nox SDK endpoint upgrade. Configure equivalent HTTPS security headers on hosts that do not honor the bundled _headers file.

## Run the private keeper

The root .env must contain:

- SWAP_SHIELD_ROUTER_ADDRESS
- SEPOLIA_RPC_URL
- SETTLEMENT_EXECUTOR_PRIVATE_KEY
- PRIVATE_RELAY_URL
- PRIVATE_RELAY_AUTH_PRIVATE_KEY
- PRIVATE_PREPARE_GAS_LIMIT, PRIVATE_SETTLEMENT_GAS_LIMIT, and MIN_PRIVATE_PRIORITY_FEE_WEI

Then run:

~~~bash
npm run keeper
~~~

On startup the keeper scans every order and batch by default (`KEEPER_RECOVERY_SCAN_LIMIT=0`) and rescans the short interval between that recovery and its event subscription, avoiding a restart-time stale-order gap. A positive scan limit is allowed only for operators with durable indexing and an explicit full-recovery process. Run it as a single serialized process or replace the simple recovery loop with durable queue/indexer infrastructure before operating at scale.

## Optional scripted Sepolia order

After deployment, configure the optional TRADER_PRIVATE_KEY and amount values in
the root .env, then run:

~~~bash
npm run demo:submit
~~~

The helper encrypts against the router, sets a short-lived ERC-7984 operator,
submits the order, and immediately revokes that operator. It does not settle an
order or bypass the keeper's proof-gated validation.

## User flow

1. Fund a confidential input balance at a time unrelated to a trade.
2. Submit an encrypted input amount and a nonzero public minimum output.
3. The keeper validates only the nonzero-funding proof; unfunded orders are rejected.
4. The keeper privately prepares a batch from at least three distinct active trader addresses and privately submits settlement.
5. Users receive confidential ShieldedTokenOut balances. They can reveal that balance locally in the UI or deliberately unwrap a chosen amount to their public wallet; an unwrap amount is public on-chain.

A trader can cancel while an order is pending or active. If a prepared batch reaches its deadline without settlement, anyone can finalize the aggregate request and refund each original trader confidentially.

## Test-only fixtures

contracts/testdex/ contains an unlimited-faucet ERC-20 and minimal AMM solely for Docker-backed local tests. Neither is deployed by scripts/deploy.ts and neither is acceptable for public trading or a no-mock-data demo.

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

Swap Shield was built for the iExec Nox WTF Hackathon as a new integration.
The application-specific router, private keeper, Sepolia deployment/preflight
tooling, browser interface, tests, and documentation in this repository are the
hackathon work. It uses the open-source iExec Nox packages, OpenZeppelin
contracts, Hardhat, React, Ethers, and Viem listed in the lockfiles; it does not
copy or reuse an entry from the previous Vibe Coding Hackathon.

Before final submission, the team should retain written organizer confirmation
if any unpublished precursor or shared component could reasonably be considered
prior hackathon work.

## Beta deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the Sepolia release sequence, Railway
repository-linked services, required variables, health checks, rollback, and
evidence that must be recorded before the public beta is announced.

## Feedback

See [feedback.md](feedback.md) for iExec Nox developer-experience feedback.

## License

MIT
