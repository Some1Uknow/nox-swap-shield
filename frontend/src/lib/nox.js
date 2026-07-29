import {
  ADDRESSES,
  CHAIN_ID,
  POOL_FEE,
  ROUTER_ABI,
  SHIELDED_TOKEN_ABI,
  UNISWAP_V3_QUOTER_V2,
} from './contracts.js';

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
let ethersModulePromise;

function loadEthers() {
  ethersModulePromise ??= import('ethers');
  return ethersModulePromise;
}

function looksLikeAddress(value) {
  return typeof value === 'string' && ADDRESS_PATTERN.test(value);
}

export function configurationError() {
  const invalid = Object.entries(ADDRESSES)
    .filter(([, value]) => !looksLikeAddress(value))
    .map(([name]) => name);

  if (!Number.isSafeInteger(CHAIN_ID) || CHAIN_ID <= 0) invalid.push('chainId');
  if (!Number.isSafeInteger(POOL_FEE) || POOL_FEE <= 0) invalid.push('poolFee');
  return invalid.length ? `Missing or invalid public deployment configuration: ${invalid.join(', ')}` : null;
}

function addressMatches(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

async function requireCode(provider, address, label) {
  const code = await provider.getCode(address);
  if (!code || code === '0x') throw new Error(`${label} has no deployed bytecode on Sepolia.`);
}

export async function verifyDeployment(provider) {
  const { Contract, ZeroAddress } = await loadEthers();
  await Promise.all([
    requireCode(provider, ADDRESSES.tokenIn, 'Configured input token'),
    requireCode(provider, ADDRESSES.tokenOut, 'Configured output token'),
    requireCode(provider, ADDRESSES.shieldedTokenIn, 'Configured ShieldedTokenIn'),
    requireCode(provider, ADDRESSES.shieldedTokenOut, 'Configured ShieldedTokenOut'),
    requireCode(provider, ADDRESSES.router, 'Configured router'),
    requireCode(provider, UNISWAP_V3_QUOTER_V2, 'Uniswap QuoterV2'),
  ]);

  const router = new Contract(ADDRESSES.router, ROUTER_ABI, provider);
  const shieldedIn = new Contract(ADDRESSES.shieldedTokenIn, SHIELDED_TOKEN_ABI, provider);
  const shieldedOut = new Contract(ADDRESSES.shieldedTokenOut, SHIELDED_TOKEN_ABI, provider);
  const [
    tokenIn,
    tokenOut,
    routerShieldedIn,
    routerShieldedOut,
    poolFee,
    minBatchSize,
    maxBatchSize,
    executor,
    shieldedInUnderlying,
    shieldedOutUnderlying,
  ] = await Promise.all([
    router.tokenIn(),
    router.tokenOut(),
    router.shieldedTokenIn(),
    router.shieldedTokenOut(),
    router.poolFee(),
    router.minBatchSize(),
    router.maxBatchSize(),
    router.settlementExecutor(),
    shieldedIn.underlying(),
    shieldedOut.underlying(),
  ]);

  if (
    !addressMatches(tokenIn, ADDRESSES.tokenIn) ||
    !addressMatches(tokenOut, ADDRESSES.tokenOut) ||
    !addressMatches(routerShieldedIn, ADDRESSES.shieldedTokenIn) ||
    !addressMatches(routerShieldedOut, ADDRESSES.shieldedTokenOut) ||
    !addressMatches(shieldedInUnderlying, ADDRESSES.tokenIn) ||
    !addressMatches(shieldedOutUnderlying, ADDRESSES.tokenOut) ||
    Number(poolFee) !== POOL_FEE ||
    minBatchSize < 3n ||
    maxBatchSize < minBatchSize ||
    maxBatchSize > 12n ||
    addressMatches(executor, ZeroAddress)
  ) {
    throw new Error('The public frontend configuration does not match the deployed NoxSwap stack. Rebuild with the current Sepolia addresses.');
  }
}

export async function connectWallet() {
  const configurationIssue = configurationError();
  if (configurationIssue) throw new Error(configurationIssue);
  if (!window.ethereum) {
    throw new Error('No wallet found. Install MetaMask, Rabby, or another EIP-1193 wallet.');
  }

  const [{ BrowserProvider, toBeHex }, { createEthersHandleClient }] = await Promise.all([
    loadEthers(),
    import('@iexec-nox/handle'),
  ]);
  const provider = new BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);

  let network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: toBeHex(CHAIN_ID) }],
      });
    } catch {
      throw new Error(`Switch your wallet to chain ${CHAIN_ID} before continuing.`);
    }
    network = await provider.getNetwork();
    if (Number(network.chainId) !== CHAIN_ID) {
      throw new Error(`Wallet is connected to chain ${network.chainId.toString()}, not ${CHAIN_ID}.`);
    }
  }

  const signer = await provider.getSigner();
  await verifyDeployment(provider);
  const handleClient = await createEthersHandleClient(provider);
  return { provider, signer, handleClient, address: await signer.getAddress() };
}

export async function getContract(address, abi, signerOrProvider) {
  const { Contract, isAddress } = await loadEthers();
  if (!isAddress(address || '')) throw new Error('The dApp has invalid deployment configuration.');
  return new Contract(address, abi, signerOrProvider);
}
