import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  http,
  isAddress,
  isHex,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

// Keep this in lockstep with the pinned Nox SDK. Nox.sol resolves this exact
// NoxCompute proxy for Ethereum Sepolia (chain ID 11155111).
const NOX_COMPUTE_SEPOLIA = '0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF' as Address;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const frontendDirectory = resolve(scriptDirectory, '..', 'frontend');
const frontendEnvFiles = ['.env', '.env.local', '.env.production', '.env.production.local'];
const frontendAllowedKeys = new Set([
  'VITE_TOKEN_IN_ADDRESS',
  'VITE_TOKEN_OUT_ADDRESS',
  'VITE_SHIELDED_TOKEN_IN_ADDRESS',
  'VITE_SHIELDED_TOKEN_OUT_ADDRESS',
  'VITE_SWAP_SHIELD_ROUTER_ADDRESS',
  'VITE_CHAIN_ID',
  'VITE_POOL_FEE',
]);

const ROUTER_ABI = parseAbi([
  'function tokenIn() view returns (address)',
  'function tokenOut() view returns (address)',
  'function shieldedTokenIn() view returns (address)',
  'function shieldedTokenOut() view returns (address)',
  'function ammRouter() view returns (address)',
  'function poolFee() view returns (uint24)',
  'function settlementExecutor() view returns (address)',
  'function minBatchSize() view returns (uint256)',
  'function maxBatchSize() view returns (uint256)',
  'function MIN_BATCH_SETTLEMENT_WINDOW() view returns (uint48)',
]);
const SHIELDED_TOKEN_ABI = parseAbi(['function underlying() view returns (address)']);
const AMM_ADAPTER_ABI = parseAbi(['function swapRouter02() view returns (address)']);
const ERC20_METADATA_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const V3_POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
]);

function requiredAddress(name: string): Address {
  const value = process.env[name];
  if (!value || !isAddress(value)) throw new Error(`Set ${name} to a valid Ethereum address in .env.`);
  return value;
}

function requiredPrivateKey(name: string): Hex {
  const value = process.env[name];
  if (!value || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`Set ${name} to a 32-byte 0x-prefixed private key in .env.`);
  }
  return value;
}

function requiredHttpsUrl(name: string): string {
  const value = process.env[name];
  try {
    if (!value || new URL(value).protocol !== 'https:') throw new Error('not HTTPS');
  } catch {
    throw new Error(`Set ${name} to a valid HTTPS URL in .env.`);
  }
  return value;
}

function requiredPoolFee(): number {
  const value = Number(process.env.POOL_FEE);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2 ** 24 - 1) {
    throw new Error('Set POOL_FEE to a positive uint24 integer in .env.');
  }
  return value;
}

function sameAddress(left: Address, right: Address) {
  return left.toLowerCase() === right.toLowerCase();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseEnv(source: string, fileName: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`${fileName}:${index + 1} is not a valid KEY=value entry.`);
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function loadPublicFrontendConfig() {
  const names = await readdir(frontendDirectory);
  const allowedFiles = new Set(frontendEnvFiles);
  const unexpectedFiles = names.filter((name) => name.startsWith('.env') && name !== '.env.example' && !allowedFiles.has(name));
  assert(
    unexpectedFiles.length === 0,
    `Unexpected frontend environment file(s): ${unexpectedFiles.join(', ')}. Keep release configuration in ${frontendEnvFiles.join(', ')} only.`,
  );

  const values: Record<string, string> = {};
  let sawConfigFile = false;
  for (const name of frontendEnvFiles) {
    try {
      const parsed = parseEnv(await readFile(resolve(frontendDirectory, name), 'utf8'), `frontend/${name}`);
      for (const key of Object.keys(parsed)) {
        assert(frontendAllowedKeys.has(key), `frontend/${name} contains ${key}; browser configuration may contain only approved public VITE_ values.`);
      }
      Object.assign(values, parsed);
      sawConfigFile = true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  assert(sawConfigFile, 'Missing frontend/.env. Copy frontend/.env.example and set the public deployment addresses.');
  return values;
}

function requireFrontendAddress(config: Record<string, string>, name: string): Address {
  const value = config[name];
  if (!value || !isAddress(value)) throw new Error(`Missing or invalid ${name} in frontend release configuration.`);
  return value;
}

async function main() {
  const rpcUrl = requiredHttpsUrl('SEPOLIA_RPC_URL');
  const tokenIn = requiredAddress('TOKEN_IN_ADDRESS');
  const tokenOut = requiredAddress('TOKEN_OUT_ADDRESS');
  const shieldedTokenIn = requiredAddress('SHIELDED_TOKEN_IN_ADDRESS');
  const shieldedTokenOut = requiredAddress('SHIELDED_TOKEN_OUT_ADDRESS');
  const router = requiredAddress('SWAP_SHIELD_ROUTER_ADDRESS');
  const ammRouter = requiredAddress('AMM_ROUTER_ADDRESS');
  const ammAdapter = requiredAddress('AMM_ADAPTER_ADDRESS');
  const ammPool = requiredAddress('AMM_POOL_ADDRESS');
  const configuredExecutor = requiredAddress('SETTLEMENT_EXECUTOR_ADDRESS');
  const poolFee = requiredPoolFee();
  const executor = privateKeyToAccount(requiredPrivateKey('SETTLEMENT_EXECUTOR_PRIVATE_KEY'));
  const relayAuth = privateKeyToAccount(requiredPrivateKey('PRIVATE_RELAY_AUTH_PRIVATE_KEY'));
  requiredHttpsUrl('PRIVATE_RELAY_URL');
  const privateRelayMode = process.env.PRIVATE_RELAY_MODE ?? 'signed-private-transaction';
  assert(
    privateRelayMode === 'signed-private-transaction' || privateRelayMode === 'flashbots-protect',
    'PRIVATE_RELAY_MODE must be signed-private-transaction or flashbots-protect.',
  );

  assert(!sameAddress(tokenIn, tokenOut), 'TOKEN_IN_ADDRESS and TOKEN_OUT_ADDRESS must differ.');
  assert(!sameAddress(shieldedTokenIn, shieldedTokenOut), 'SHIELDED_TOKEN_IN_ADDRESS and SHIELDED_TOKEN_OUT_ADDRESS must differ.');
  assert(sameAddress(configuredExecutor, executor.address), 'SETTLEMENT_EXECUTOR_ADDRESS does not match SETTLEMENT_EXECUTOR_PRIVATE_KEY.');
  assert(!sameAddress(executor.address, relayAuth.address), 'PRIVATE_RELAY_AUTH_PRIVATE_KEY must be a separate account from the settlement executor.');

  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl, { retryCount: 2, timeout: 15_000 }),
  });
  assert(await publicClient.getChainId() === sepolia.id, 'SEPOLIA_RPC_URL is not connected to Ethereum Sepolia (chain ID 11155111).');

  const deployedTargets: Array<[string, Address]> = [
    ['TOKEN_IN_ADDRESS', tokenIn],
    ['TOKEN_OUT_ADDRESS', tokenOut],
    ['SHIELDED_TOKEN_IN_ADDRESS', shieldedTokenIn],
    ['SHIELDED_TOKEN_OUT_ADDRESS', shieldedTokenOut],
    ['SWAP_SHIELD_ROUTER_ADDRESS', router],
    ['AMM_ROUTER_ADDRESS', ammRouter],
    ['AMM_ADAPTER_ADDRESS', ammAdapter],
    ['AMM_POOL_ADDRESS', ammPool],
    ['NoxCompute', NOX_COMPUTE_SEPOLIA],
  ];
  const codes = await Promise.all(deployedTargets.map(([, address]) => publicClient.getCode({ address })));
  for (let index = 0; index < deployedTargets.length; index += 1) {
    const [label] = deployedTargets[index];
    const code = codes[index];
    assert(code && code !== '0x', `${label} has no deployed bytecode on Ethereum Sepolia.`);
  }
  const ammRouterCode = codes[deployedTargets.findIndex(([label]) => label === 'AMM_ROUTER_ADDRESS')];
  assert(
    ammRouterCode?.toLowerCase().includes('04e45aaf'),
    'AMM_ROUTER_ADDRESS does not expose Uniswap SwapRouter02 exactInputSingle().',
  );
  const executorCode = await publicClient.getCode({ address: executor.address });
  assert(!executorCode || executorCode === '0x', 'SETTLEMENT_EXECUTOR_PRIVATE_KEY resolves to a contract account, not an EOA.');

  const [
    routerTokenIn,
    routerTokenOut,
    routerShieldedIn,
    routerShieldedOut,
    routerAmmRouter,
    adapterSwapRouter02,
    routerPoolFee,
    routerExecutor,
    minBatchSize,
    maxBatchSize,
    minSettlementWindow,
    inputUnderlying,
    outputUnderlying,
    inputDecimals,
    inputSymbol,
    outputDecimals,
    outputSymbol,
    poolToken0,
    poolToken1,
    poolFeeOnChain,
    poolLiquidity,
  ] = await Promise.all([
    publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'tokenIn' }),
    publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'tokenOut' }),
    publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'shieldedTokenIn' }),
    publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'shieldedTokenOut' }),
    publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'ammRouter' }),
    publicClient.readContract({ address: ammAdapter, abi: AMM_ADAPTER_ABI, functionName: 'swapRouter02' }),
    publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'poolFee' }),
    publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'settlementExecutor' }),
    publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'minBatchSize' }),
    publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'maxBatchSize' }),
    publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: 'MIN_BATCH_SETTLEMENT_WINDOW' }),
    publicClient.readContract({ address: shieldedTokenIn, abi: SHIELDED_TOKEN_ABI, functionName: 'underlying' }),
    publicClient.readContract({ address: shieldedTokenOut, abi: SHIELDED_TOKEN_ABI, functionName: 'underlying' }),
    publicClient.readContract({ address: tokenIn, abi: ERC20_METADATA_ABI, functionName: 'decimals' }),
    publicClient.readContract({ address: tokenIn, abi: ERC20_METADATA_ABI, functionName: 'symbol' }),
    publicClient.readContract({ address: tokenOut, abi: ERC20_METADATA_ABI, functionName: 'decimals' }),
    publicClient.readContract({ address: tokenOut, abi: ERC20_METADATA_ABI, functionName: 'symbol' }),
    publicClient.readContract({ address: ammPool, abi: V3_POOL_ABI, functionName: 'token0' }),
    publicClient.readContract({ address: ammPool, abi: V3_POOL_ABI, functionName: 'token1' }),
    publicClient.readContract({ address: ammPool, abi: V3_POOL_ABI, functionName: 'fee' }),
    publicClient.readContract({ address: ammPool, abi: V3_POOL_ABI, functionName: 'liquidity' }),
  ]);

  assert(sameAddress(routerTokenIn, tokenIn), 'Router tokenIn() does not match TOKEN_IN_ADDRESS.');
  assert(sameAddress(routerTokenOut, tokenOut), 'Router tokenOut() does not match TOKEN_OUT_ADDRESS.');
  assert(sameAddress(routerShieldedIn, shieldedTokenIn), 'Router shieldedTokenIn() does not match SHIELDED_TOKEN_IN_ADDRESS.');
  assert(sameAddress(routerShieldedOut, shieldedTokenOut), 'Router shieldedTokenOut() does not match SHIELDED_TOKEN_OUT_ADDRESS.');
  assert(sameAddress(routerAmmRouter, ammAdapter), 'Router ammRouter() does not match AMM_ADAPTER_ADDRESS.');
  assert(sameAddress(adapterSwapRouter02, ammRouter), 'AMM_ADAPTER_ADDRESS does not target AMM_ROUTER_ADDRESS.');
  assert(sameAddress(routerExecutor, executor.address), 'Router settlementExecutor() does not match SETTLEMENT_EXECUTOR_PRIVATE_KEY.');
  assert(sameAddress(inputUnderlying, tokenIn), 'ShieldedTokenIn underlying() does not match TOKEN_IN_ADDRESS.');
  assert(sameAddress(outputUnderlying, tokenOut), 'ShieldedTokenOut underlying() does not match TOKEN_OUT_ADDRESS.');
  assert(Number(routerPoolFee) === poolFee, 'Router poolFee() does not match POOL_FEE.');
  assert(Number(poolFeeOnChain) === poolFee, 'AMM_POOL_ADDRESS fee() does not match POOL_FEE.');
  assert(
    (sameAddress(poolToken0, tokenIn) && sameAddress(poolToken1, tokenOut)) ||
      (sameAddress(poolToken0, tokenOut) && sameAddress(poolToken1, tokenIn)),
    'AMM_POOL_ADDRESS does not contain the configured input/output token pair.',
  );
  assert(poolLiquidity > 0n, 'AMM_POOL_ADDRESS has zero liquidity. Supply a liquid Sepolia pool for the public demo.');
  assert(minBatchSize >= 3n && maxBatchSize >= minBatchSize && maxBatchSize <= 12n, 'Router batch-size configuration is outside supported safety bounds.');
  assert(minSettlementWindow >= 5n * 60n, 'Router minimum settlement window is below five minutes.');
  assert(inputDecimals <= 255 && outputDecimals <= 255, 'Configured tokens returned unsupported decimals.');
  assert(inputSymbol.length > 0 && outputSymbol.length > 0, 'Configured tokens returned empty symbols.');

  const frontendConfig = await loadPublicFrontendConfig();
  assert(sameAddress(requireFrontendAddress(frontendConfig, 'VITE_TOKEN_IN_ADDRESS'), tokenIn), 'VITE_TOKEN_IN_ADDRESS does not match TOKEN_IN_ADDRESS.');
  assert(sameAddress(requireFrontendAddress(frontendConfig, 'VITE_TOKEN_OUT_ADDRESS'), tokenOut), 'VITE_TOKEN_OUT_ADDRESS does not match TOKEN_OUT_ADDRESS.');
  assert(sameAddress(requireFrontendAddress(frontendConfig, 'VITE_SHIELDED_TOKEN_IN_ADDRESS'), shieldedTokenIn), 'VITE_SHIELDED_TOKEN_IN_ADDRESS does not match SHIELDED_TOKEN_IN_ADDRESS.');
  assert(sameAddress(requireFrontendAddress(frontendConfig, 'VITE_SHIELDED_TOKEN_OUT_ADDRESS'), shieldedTokenOut), 'VITE_SHIELDED_TOKEN_OUT_ADDRESS does not match SHIELDED_TOKEN_OUT_ADDRESS.');
  assert(sameAddress(requireFrontendAddress(frontendConfig, 'VITE_SWAP_SHIELD_ROUTER_ADDRESS'), router), 'VITE_SWAP_SHIELD_ROUTER_ADDRESS does not match SWAP_SHIELD_ROUTER_ADDRESS.');
  assert(Number(frontendConfig.VITE_CHAIN_ID) === sepolia.id, 'VITE_CHAIN_ID must be 11155111.');
  assert(Number(frontendConfig.VITE_POOL_FEE) === poolFee, 'VITE_POOL_FEE does not match POOL_FEE.');

  console.log('Sepolia release preflight passed. No transaction was signed or broadcast.');
  console.log(`Router: ${router}`);
  console.log(`Pool: ${ammPool} (${inputSymbol}/${outputSymbol}, fee ${poolFee}, liquidity ${poolLiquidity.toString()})`);
  console.log('Verified: code, SwapRouter02 adapter/wrapper wiring, executor binding, NoxCompute, pool pair/liquidity, and public frontend configuration.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
