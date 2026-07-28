import 'dotenv/config';
import { network } from 'hardhat';
import { isAddress, isHex, type Hex } from 'viem';

// Pinned Nox Protocol Contracts v0.2.4 resolves this address for Sepolia.
// Validate code before deployment so a stale/misconfigured network cannot
// produce a router that points at an absent confidential-compute contract.
const NOX_COMPUTE_SEPOLIA = '0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF' as `0x${string}`;

function requiredAddress(name: string): `0x${string}` {
  const value = process.env[name];
  if (!value || !isAddress(value)) {
    throw new Error(`Set ${name} to a valid deployed contract or executor address in .env`);
  }
  return value;
}

function requiredInteger(name: string, fallback?: number): number {
  const raw = process.env[name] ?? (fallback === undefined ? undefined : String(fallback));
  const value = raw === undefined ? NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Set ${name} to a positive integer in .env`);
  }
  return value;
}

function requiredHttpsUrl(name: string): string {
  const value = process.env[name];
  try {
    if (!value || new URL(value).protocol !== 'https:') throw new Error('not HTTPS');
  } catch {
    throw new Error(`Set ${name} to a valid HTTPS Sepolia endpoint in .env`);
  }
  return value;
}

function requiredPrivateKey(name: string): Hex {
  const value = process.env[name];
  if (!value || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`Set ${name} to a 32-byte 0x-prefixed private key in .env`);
  }
  return value;
}

async function requireDeployedContract(
  publicClient: { getCode: (request: { address: `0x${string}` }) => Promise<`0x${string}` | undefined> },
  name: string,
  address: `0x${string}`,
) {
  const code = await publicClient.getCode({ address });
  if (!code || code === '0x') {
    throw new Error(`${name} must be a deployed contract address on Ethereum Sepolia`);
  }
}

async function requireUniswapSwapRouter02(
  publicClient: { getCode: (request: { address: `0x${string}` }) => Promise<`0x${string}` | undefined> },
  address: `0x${string}`,
) {
  const code = await publicClient.getCode({ address });
  // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
  // is the SwapRouter02 selector. The legacy V3 SwapRouter includes a
  // deadline in this struct and therefore has a different selector.
  if (!code || code === '0x' || !code.toLowerCase().includes('04e45aaf')) {
    throw new Error('AMM_ROUTER_ADDRESS must expose the Uniswap SwapRouter02 exactInputSingle ABI on Ethereum Sepolia');
  }
}

/**
 * Deploys the production-shaped Sepolia stack. Token contracts and the AMM
 * router are intentionally supplied by configuration. A small adapter is
 * deployed alongside the Nox contracts because the public SwapRouter02 ABI
 * differs from the project's deadline-bearing AMM interface. This script
 * never deploys TestERC20 or DemoAMM outside the local test suite.
 */
async function main() {
  // Hardhat reads these variables while resolving the named network; validate
  // them here as well so this Sepolia-only script cannot silently use an
  // insecure endpoint or malformed deployer credential.
  requiredHttpsUrl('SEPOLIA_RPC_URL');
  requiredPrivateKey('DEPLOYER_PRIVATE_KEY');
  const tokenIn = requiredAddress('TOKEN_IN_ADDRESS');
  const tokenOut = requiredAddress('TOKEN_OUT_ADDRESS');
  const ammRouter = requiredAddress('AMM_ROUTER_ADDRESS');
  const settlementExecutor = requiredAddress('SETTLEMENT_EXECUTOR_ADDRESS');
  const poolFee = requiredInteger('POOL_FEE', 3000);
  const minBatchSize = requiredInteger('MIN_BATCH_SIZE', 3);
  const maxBatchSize = requiredInteger('MAX_BATCH_SIZE', 12);

  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    throw new Error('TOKEN_IN_ADDRESS and TOKEN_OUT_ADDRESS must be different');
  }
  if (poolFee > 2 ** 24 - 1) {
    throw new Error('POOL_FEE must fit in uint24');
  }
  if (minBatchSize < 3 || maxBatchSize < minBatchSize || maxBatchSize > 12) {
    throw new Error('Require 3 <= MIN_BATCH_SIZE <= MAX_BATCH_SIZE <= 12');
  }

  // `nox.connect()` always boots the plugin's injected local Nox network.
  // Deployments must explicitly use the configured Sepolia connection instead.
  const { viem } = await network.create<'l1'>('sepolia');
  const [walletClients, publicClient] = await Promise.all([viem.getWalletClients(), viem.getPublicClient()]);
  const [deployer] = walletClients;
  if (!deployer) throw new Error('No deployer account available. Set DEPLOYER_PRIVATE_KEY.');
  if (await publicClient.getChainId() !== 11155111) {
    throw new Error('Refusing deployment: the configured network is not Ethereum Sepolia (chain ID 11155111).');
  }
  await Promise.all([
    requireDeployedContract(publicClient, 'TOKEN_IN_ADDRESS', tokenIn),
    requireDeployedContract(publicClient, 'TOKEN_OUT_ADDRESS', tokenOut),
    requireUniswapSwapRouter02(publicClient, ammRouter),
    requireDeployedContract(publicClient, 'NoxCompute', NOX_COMPUTE_SEPOLIA),
  ]);
  const executorCode = await publicClient.getCode({ address: settlementExecutor });
  if (executorCode && executorCode !== '0x') {
    throw new Error('SETTLEMENT_EXECUTOR_ADDRESS must be an EOA because scripts/keeper.ts signs transactions with its private key.');
  }

  console.log('Deploying from:', deployer.account.address);
  console.log('Input token:', tokenIn);
  console.log('Output token:', tokenOut);
  console.log('Uniswap SwapRouter02:', ammRouter);
  console.log('NoxCompute:', NOX_COMPUTE_SEPOLIA);
  console.log('Private settlement executor:', settlementExecutor);

  const ammAdapter = await viem.deployContract('UniswapV3SwapRouter02Adapter', [ammRouter]);
  const shieldedTokenIn = await viem.deployContract('ShieldedToken', [
    tokenIn,
    'Shielded Input Token',
    'sIN',
  ]);
  const shieldedTokenOut = await viem.deployContract('ShieldedToken', [
    tokenOut,
    'Shielded Output Token',
    'sOUT',
  ]);
  const router = await viem.deployContract('SwapShieldRouter', [
    shieldedTokenIn.address,
    shieldedTokenOut.address,
    tokenIn,
    tokenOut,
    ammAdapter.address,
    poolFee,
    settlementExecutor,
    minBatchSize,
    maxBatchSize,
  ]);

  console.log('\n--- deployed Sepolia addresses ---');
  console.log(`AMM_ADAPTER_ADDRESS=${ammAdapter.address}`);
  console.log(`SHIELDED_TOKEN_IN_ADDRESS=${shieldedTokenIn.address}`);
  console.log(`SHIELDED_TOKEN_OUT_ADDRESS=${shieldedTokenOut.address}`);
  console.log(`SWAP_SHIELD_ROUTER_ADDRESS=${router.address}`);
  console.log('\nCopy only public addresses to frontend/.env. Keep private relay and executor keys server-side.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
