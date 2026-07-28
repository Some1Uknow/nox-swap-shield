# Security policy

## Scope

Swap Shield is currently supported only as an Ethereum Sepolia hackathon build.
It is not approved for mainnet funds or production custody.

## Reporting a vulnerability

Do not open a public issue with exploit steps, private keys, relay credentials,
or a live-user transaction. Use the repository's private security-advisory
feature, or contact the project maintainers through the hackathon submission
channel and include:

- affected commit and file/function;
- a minimal reproducible proof of concept;
- impact, preconditions, and suggested mitigation;
- whether any secret or user fund is exposed.

## Operational requirements

- Keep all .env files and private relay credentials out of source control.
- Use a separate, unfunded relay-auth key; never reuse a user or treasury key
  for the private-relay authentication header.
- Deploy only to Ethereum Sepolia using the pinned Nox package set.
- Run the Docker-backed Nox suite and a three-order private-relay smoke test
  before publishing a deployment.
- Treat any public-settlement fallback as a security incident for this app's
  stated privacy model.
