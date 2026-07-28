import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isAddress, isHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const envPath = resolve(process.cwd(), '.env');
const DEFAULT_SEPOLIA_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
const DEFAULT_PRIVATE_RELAY_URL = 'https://relay-sepolia.flashbots.net';

function valueFor(source: string, key: string) {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(source);
  return match?.[1].trim() ?? '';
}

function upsert(source: string, key: string, value: string) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  return pattern.test(source)
    ? source.replace(pattern, line)
    : `${source.trimEnd()}\n${line}\n`;
}

function configuredPrivateKey(source: string, key: string) {
  const existing = valueFor(source, key);
  if (!existing) return generatePrivateKey();
  if (!isHex(existing, { strict: true }) || existing.length !== 66) {
    throw new Error(`${key} must be a 32-byte 0x-prefixed private key.`);
  }
  return existing;
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Configured endpoint returned a non-success HTTP response.');
  return response.json() as Promise<{ result?: string; error?: { code?: number } }>;
}

async function validateEndpoints(rpcUrl: string, relayUrl: string) {
  const chain = await postJson(rpcUrl, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_chainId',
    params: [],
  });
  if (chain.result?.toLowerCase() !== '0xaa36a7') {
    throw new Error('SEPOLIA_RPC_URL is not connected to Ethereum Sepolia (chain ID 11155111).');
  }

  // Do not submit a transaction here. An empty request distinguishes a relay
  // that recognizes the private-transaction method from a generic RPC node.
  const relay = await postJson(relayUrl, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_sendPrivateTransaction',
    params: [],
  });
  if (relay.error?.code === -32601 || !relay.error) {
    throw new Error('PRIVATE_RELAY_URL does not recognize eth_sendPrivateTransaction.');
  }
}

async function main() {
  let source: string;
  try {
    source = await readFile(envPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('Missing .env. Copy .env.example first.');
    }
    throw error;
  }

  const deployerKey = configuredPrivateKey(source, 'DEPLOYER_PRIVATE_KEY');
  const executorKey = configuredPrivateKey(source, 'SETTLEMENT_EXECUTOR_PRIVATE_KEY');
  const relayAuthKey = configuredPrivateKey(source, 'PRIVATE_RELAY_AUTH_PRIVATE_KEY');
  const executorAddress = privateKeyToAccount(executorKey).address;
  const configuredExecutorAddress = valueFor(source, 'SETTLEMENT_EXECUTOR_ADDRESS');
  if (configuredExecutorAddress && (!isAddress(configuredExecutorAddress) || configuredExecutorAddress.toLowerCase() !== executorAddress.toLowerCase())) {
    throw new Error('SETTLEMENT_EXECUTOR_ADDRESS does not match SETTLEMENT_EXECUTOR_PRIVATE_KEY.');
  }

  const rpcUrl = valueFor(source, 'SEPOLIA_RPC_URL') || DEFAULT_SEPOLIA_RPC_URL;
  const relayUrl = valueFor(source, 'PRIVATE_RELAY_URL') || DEFAULT_PRIVATE_RELAY_URL;
  await validateEndpoints(rpcUrl, relayUrl);

  source = upsert(source, 'SEPOLIA_RPC_URL', rpcUrl);
  source = upsert(source, 'PRIVATE_RELAY_URL', relayUrl);
  source = upsert(source, 'DEPLOYER_PRIVATE_KEY', deployerKey);
  source = upsert(source, 'SETTLEMENT_EXECUTOR_PRIVATE_KEY', executorKey);
  source = upsert(source, 'PRIVATE_RELAY_AUTH_PRIVATE_KEY', relayAuthKey);
  source = upsert(source, 'SETTLEMENT_EXECUTOR_ADDRESS', executorAddress);
  await writeFile(envPath, source, { mode: 0o600 });
  await chmod(envPath, 0o600);

  const deployer = privateKeyToAccount(deployerKey).address;
  const relayAuth = privateKeyToAccount(relayAuthKey).address;
  console.log('Created or validated Sepolia-only local accounts in the ignored .env file.');
  console.log(`Fund deployer: ${deployer}`);
  console.log(`Fund executor: ${executorAddress}`);
  console.log(`Relay-auth account (keep unfunded): ${relayAuth}`);
  console.log('No private keys were printed. Do not use these accounts on Ethereum mainnet.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
