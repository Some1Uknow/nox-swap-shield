import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  isHex,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createViemHandleClient } from '@iexec-nox/handle';

const TOKEN_IN = process.env.TOKEN_IN_ADDRESS as Address;
const SHIELDED_TOKEN_IN = process.env.SHIELDED_TOKEN_IN_ADDRESS as Address;
const ROUTER = process.env.SWAP_SHIELD_ROUTER_ADDRESS as Address;
const RPC_URL = process.env.SEPOLIA_RPC_URL;
const TRADER_PRIVATE_KEY = process.env.TRADER_PRIVATE_KEY as Hex;
const INPUT_DECIMALS = Number(process.env.INPUT_DECIMALS ?? 18);
const OUTPUT_DECIMALS = Number(process.env.OUTPUT_DECIMALS ?? 6);
const SELL_AMOUNT_TEXT = process.env.SELL_AMOUNT ?? '1';
const MIN_OUT_TEXT = process.env.MIN_OUT ?? '1900';
const FUND_BEFORE_SUBMIT_VALUE = process.env.FUND_BEFORE_SUBMIT ?? 'false';
const FUND_BEFORE_SUBMIT = FUND_BEFORE_SUBMIT_VALUE === 'true';

const ERC20_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const SHIELDED_TOKEN_ABI = parseAbi([
  'function wrap(address to, uint256 amount) returns (bytes32)',
  'function underlying() view returns (address)',
  'function setOperator(address operator, uint48 until)',
]);
const ROUTER_ABI = parseAbi([
  'function submitOrder(bytes32 encryptedAmount, bytes inputProof, uint256 minOut, uint48 deadline) returns (uint256)',
  'function shieldedTokenIn() view returns (address)',
]);

function requireHttpsUrl(name: string, value: string) {
  try {
    if (new URL(value).protocol !== 'https:') throw new Error('not HTTPS');
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL for Sepolia operation.`);
  }
}

function validateConfiguration() {
  if (!isAddress(TOKEN_IN) || !isAddress(SHIELDED_TOKEN_IN) || !isAddress(ROUTER) || !RPC_URL || !TRADER_PRIVATE_KEY) {
    throw new Error('Set TOKEN_IN_ADDRESS, SHIELDED_TOKEN_IN_ADDRESS, SWAP_SHIELD_ROUTER_ADDRESS, SEPOLIA_RPC_URL, and TRADER_PRIVATE_KEY.');
  }
  if (!isHex(TRADER_PRIVATE_KEY, { strict: true }) || TRADER_PRIVATE_KEY.length !== 66) {
    throw new Error('TRADER_PRIVATE_KEY must be a 32-byte 0x-prefixed private key.');
  }
  requireHttpsUrl('SEPOLIA_RPC_URL', RPC_URL);
  if (
    !Number.isInteger(INPUT_DECIMALS) || INPUT_DECIMALS < 0 || INPUT_DECIMALS > 255 ||
    !Number.isInteger(OUTPUT_DECIMALS) || OUTPUT_DECIMALS < 0 || OUTPUT_DECIMALS > 255
  ) {
    throw new Error('INPUT_DECIMALS and OUTPUT_DECIMALS must be integers between 0 and 255.');
  }
  if (FUND_BEFORE_SUBMIT_VALUE !== 'true' && FUND_BEFORE_SUBMIT_VALUE !== 'false') {
    throw new Error('FUND_BEFORE_SUBMIT must be exactly true or false.');
  }
}

async function main() {
  validateConfiguration();

  const account = privateKeyToAccount(TRADER_PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC_URL) });
  if (await publicClient.getChainId() !== sepolia.id) {
    throw new Error('Refusing demo submission: SEPOLIA_RPC_URL is not connected to Ethereum Sepolia (chain ID 11155111).');
  }
  const [tokenCode, shieldedTokenCode, routerCode] = await Promise.all([
    publicClient.getCode({ address: TOKEN_IN }),
    publicClient.getCode({ address: SHIELDED_TOKEN_IN }),
    publicClient.getCode({ address: ROUTER }),
  ]);
  if (!tokenCode || tokenCode === '0x' || !shieldedTokenCode || shieldedTokenCode === '0x' || !routerCode || routerCode === '0x') {
    throw new Error('TOKEN_IN_ADDRESS, SHIELDED_TOKEN_IN_ADDRESS, and SWAP_SHIELD_ROUTER_ADDRESS must all have deployed bytecode on Sepolia.');
  }
  const [shieldedUnderlying, routerShieldedTokenIn, latestBlock] = await Promise.all([
    publicClient.readContract({ address: SHIELDED_TOKEN_IN, abi: SHIELDED_TOKEN_ABI, functionName: 'underlying' }),
    publicClient.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: 'shieldedTokenIn' }),
    publicClient.getBlock(),
  ]);
  if (shieldedUnderlying.toLowerCase() !== TOKEN_IN.toLowerCase() || routerShieldedTokenIn.toLowerCase() !== SHIELDED_TOKEN_IN.toLowerCase()) {
    throw new Error('Configured token, ShieldedTokenIn, and router do not form the expected deployed stack.');
  }
  const handleClient = await createViemHandleClient(walletClient);
  const sellAmount = parseUnits(SELL_AMOUNT_TEXT, INPUT_DECIMALS);
  const minOut = parseUnits(MIN_OUT_TEXT, OUTPUT_DECIMALS);
  if (sellAmount <= 0n || minOut <= 0n) {
    throw new Error('SELL_AMOUNT and MIN_OUT must be positive.');
  }
  const deadline = Number(latestBlock.timestamp) + 15 * 60;

  if (FUND_BEFORE_SUBMIT) {
    console.warn('Funding is public. For privacy, fund the confidential balance well before placing a particular order.');
    let fundingApprovalGranted = false;
    try {
      const approveHash = await walletClient.writeContract({
        address: TOKEN_IN,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [SHIELDED_TOKEN_IN, sellAmount],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      fundingApprovalGranted = true;
      const wrapHash = await walletClient.writeContract({
        address: SHIELDED_TOKEN_IN,
        abi: SHIELDED_TOKEN_ABI,
        functionName: 'wrap',
        args: [account.address, sellAmount],
      });
      await publicClient.waitForTransactionReceipt({ hash: wrapHash });
    } finally {
      if (fundingApprovalGranted) {
        const revokeFundingHash = await walletClient.writeContract({
          address: TOKEN_IN,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [SHIELDED_TOKEN_IN, 0n],
        });
        await publicClient.waitForTransactionReceipt({ hash: revokeFundingHash });
      }
    }
  }

  let operatorGranted = false;
  let orderHash: Hex | undefined;
  try {
    const operatorHash = await walletClient.writeContract({
      address: SHIELDED_TOKEN_IN,
      abi: SHIELDED_TOKEN_ABI,
      functionName: 'setOperator',
      args: [ROUTER, deadline],
    });
    await publicClient.waitForTransactionReceipt({ hash: operatorHash });
    operatorGranted = true;

    // The proof is bound to this trader and the router. The router passes the
    // handle to ShieldedToken with transaction-scoped Nox permission, then
    // verifies only that a nonzero transfer occurred.
    const { handle, handleProof } = await handleClient.encryptInput(sellAmount, 'uint256', ROUTER);
    orderHash = await walletClient.writeContract({
      address: ROUTER,
      abi: ROUTER_ABI,
      functionName: 'submitOrder',
      args: [handle, handleProof, minOut, deadline],
    });
    await publicClient.waitForTransactionReceipt({ hash: orderHash });
  } finally {
    if (operatorGranted) {
      const revokeHash = await walletClient.writeContract({
        address: SHIELDED_TOKEN_IN,
        abi: SHIELDED_TOKEN_ABI,
        functionName: 'setOperator',
        args: [ROUTER, 0],
      });
      await publicClient.waitForTransactionReceipt({ hash: revokeHash });
    }
  }

  console.log(`Confidential order submitted: ${orderHash}`);
  console.log('The configured keeper will validate funding, then form a private-relay batch.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
