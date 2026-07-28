# iExec Nox developer feedback

Swap Shield uses Nox confidential ERC-7984 balances as a privacy layer over an unmodified AMM. Building the batch flow surfaced a few areas where the developer experience could be clearer.

## 1. Wrapper examples should show the complete balance lifecycle

The wrapper API has a clear `wrap()` / encrypted transfer / `unwrap()` model, but a canonical end-to-end example would help builders avoid two common mistakes:

- `unwrap()` burns a confidential balance; approving an ERC-20 alone does not create that balance.
- A transaction submission returns a transaction hash, not the Solidity return value of `unwrap()`.
- ERC-7984 safe transfers can resolve to encrypted zero instead of reverting for
  an insufficient confidential balance. A canonical order-flow example should
  show how to prove and gate that success bit before an order is batchable.

An official example that parses `UnwrapRequested` from a receipt and shows a cancel/refund lifecycle would make confidential DeFi integrations much safer.

## 2. Handle ACL persistence deserves a dedicated guide

When a contract receives an encrypted value from `confidentialTransferFrom`, it needs to preserve its own access before storing and reusing that handle across transactions. A short guide with safe patterns for `Nox.allowThis`, contract storage, batched arithmetic, and recipient permissions would reduce integration uncertainty.

## 3. Private settlement is an application-level requirement

Nox protects encrypted values, but an app that unwraps an aggregate amount for a transparent AMM must still avoid publishing the settlement transaction to the public mempool. A documented private-relay/reference-executor pattern would be valuable for builders combining confidential state with public DeFi execution.

## 4. Batch allocation examples would unlock more composable applications

The Nox arithmetic API supports encrypted addition, multiplication, and division, which makes confidential pro-rata allocation possible. A reference batch-swap or batch-auction example covering rounding, minimum-output guarantees, and expired-batch refunds would be particularly useful.

## 5. Versioned compatibility tables would help hackathon builders

Nox packages evolve quickly. A small table mapping compatible versions of the Hardhat plugin, Handle SDK, confidential contracts, protocol contracts, Hardhat, Viem, and Solidity would make a fresh install more deterministic.

## 6. Public-decryption timing needs an explicit MEV caveat

For an app that unwraps an aggregate before a transparent AMM call, the aggregate
becomes publicly decryptable after the unwrap request is mined. A private relay
can avoid public-mempool submission, but by itself it does not create atomic
front-run protection across a separate prepare/decrypt/settle sequence. A
reference pattern that states this limitation and shows an atomic-builder option
would keep integrations from overpromising privacy.
