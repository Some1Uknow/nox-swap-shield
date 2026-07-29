import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createViemHandleClient } from '@iexec-nox/handle';

const ROUTER_ADDRESS = process.env.SWAP_SHIELD_ROUTER_ADDRESS as Address;
const RPC_URL = process.env.SEPOLIA_RPC_URL;
const PRIVATE_RELAY_URL = process.env.PRIVATE_RELAY_URL;
const EXECUTOR_PRIVATE_KEY = process.env.SETTLEMENT_EXECUTOR_PRIVATE_KEY as Hex;
const PRIVATE_RELAY_AUTH_PRIVATE_KEY = process.env.PRIVATE_RELAY_AUTH_PRIVATE_KEY as Hex;
const BATCH_WINDOW_MS = Number(process.env.BATCH_WINDOW_MS ?? 20_000);
const PRIVATE_TX_TIMEOUT_MS = Number(process.env.PRIVATE_TX_TIMEOUT_MS ?? 120_000);
const PRIVATE_TX_TTL_BLOCKS = BigInt(process.env.PRIVATE_TX_TTL_BLOCKS ?? '5');
const PRIVATE_PREPARE_GAS_LIMIT = BigInt(process.env.PRIVATE_PREPARE_GAS_LIMIT ?? '1800000');
const PRIVATE_SETTLEMENT_GAS_LIMIT = BigInt(process.env.PRIVATE_SETTLEMENT_GAS_LIMIT ?? '3500000');
const MIN_PRIVATE_PRIORITY_FEE_WEI = BigInt(process.env.MIN_PRIVATE_PRIORITY_FEE_WEI ?? '1000000000');
// Zero is intentional: favor complete restart recovery over a silent stale
// order backlog. Operators with a durable indexer can set a positive bounded
// window and accept the documented recovery trade-off.
const KEEPER_RECOVERY_SCAN_LIMIT = Number(process.env.KEEPER_RECOVERY_SCAN_LIMIT ?? 0);

const ORDER_STATUS = {
  Pending: 1,
  Active: 2,
  Prepared: 3,
} as const;

const BATCH_STATUS = {
  Prepared: 1,
} as const;

const ROUTER_ABI = parseAbi([
  'event OrderSubmitted(uint256 indexed orderId, address indexed trader, uint48 deadline)',
  'function nextOrderId() view returns (uint256)',
  'function nextBatchId() view returns (uint256)',
  'function minBatchSize() view returns (uint256)',
  'function maxBatchSize() view returns (uint256)',
  'function MIN_BATCH_SETTLEMENT_WINDOW() view returns (uint48)',
  'function settlementExecutor() view returns (address)',
  'function orders(uint256) view returns (address trader, bytes32 inputAmount, bytes32 fundingCheck, uint256 minOut, uint48 deadline, uint256 batchId, uint8 status)',
  'function batches(uint256) view returns (bytes32 unwrapRequestId, uint256 totalMinOut, uint48 deadline, uint32 orderCount, uint8 status)',
  'function validateOrder(uint256 orderId, bytes fundingProof)',
  'function cancelOrder(uint256 orderId)',
  'function prepareBatch(uint256[] orderIds) returns (uint256)',
  'function settleBatch(uint256 batchId, bytes decryptedAmountAndProof)',
]);

// Viem decodes public struct getters as positional tuples on some transports.
// Read these by index throughout the keeper so an RPC/client representation
// change cannot turn a real encrypted handle into `undefined` at runtime.
type RouterOrder = readonly [
  trader: Address,
  inputAmount: Hex,
  fundingCheck: Hex,
  minOut: bigint,
  deadline: bigint | number,
  batchId: bigint | number,
  status: bigint | number,
];

type RouterBatch = readonly [
  unwrapRequestId: Hex,
  totalMinOut: bigint,
  deadline: bigint | number,
  orderCount: bigint | number,
  status: bigint | number,
];

type RelayAuthAccount = ReturnType<typeof privateKeyToAccount>;

function requireHttpsUrl(name: string, value: string) {
  try {
    if (new URL(value).protocol !== 'https:') throw new Error('not HTTPS');
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL for Sepolia operation`);
  }
}

function requiredConfiguration() {
  if (
    !isAddress(ROUTER_ADDRESS) ||
    !RPC_URL ||
    !PRIVATE_RELAY_URL ||
    !EXECUTOR_PRIVATE_KEY ||
    !PRIVATE_RELAY_AUTH_PRIVATE_KEY
  ) {
    throw new Error(
      'Set SWAP_SHIELD_ROUTER_ADDRESS, SEPOLIA_RPC_URL, PRIVATE_RELAY_URL, SETTLEMENT_EXECUTOR_PRIVATE_KEY, and PRIVATE_RELAY_AUTH_PRIVATE_KEY in .env',
    );
  }
  if (!isHex(EXECUTOR_PRIVATE_KEY, { strict: true }) || EXECUTOR_PRIVATE_KEY.length !== 66) {
    throw new Error('SETTLEMENT_EXECUTOR_PRIVATE_KEY must be a 32-byte 0x-prefixed private key');
  }
  if (!isHex(PRIVATE_RELAY_AUTH_PRIVATE_KEY, { strict: true }) || PRIVATE_RELAY_AUTH_PRIVATE_KEY.length !== 66) {
    throw new Error('PRIVATE_RELAY_AUTH_PRIVATE_KEY must be a 32-byte 0x-prefixed private key');
  }
  requireHttpsUrl('SEPOLIA_RPC_URL', RPC_URL);
  requireHttpsUrl('PRIVATE_RELAY_URL', PRIVATE_RELAY_URL);
  if (!Number.isFinite(BATCH_WINDOW_MS) || BATCH_WINDOW_MS < 5_000) {
    throw new Error('BATCH_WINDOW_MS must be at least 5000');
  }
  if (!Number.isFinite(PRIVATE_TX_TIMEOUT_MS) || PRIVATE_TX_TIMEOUT_MS < 15_000) {
    throw new Error('PRIVATE_TX_TIMEOUT_MS must be at least 15000');
  }
  if (PRIVATE_TX_TTL_BLOCKS < 1n || PRIVATE_TX_TTL_BLOCKS > 64n) {
    throw new Error('PRIVATE_TX_TTL_BLOCKS must be between 1 and 64');
  }
  if (PRIVATE_PREPARE_GAS_LIMIT < 21_000n || PRIVATE_SETTLEMENT_GAS_LIMIT < 21_000n) {
    throw new Error('PRIVATE_PREPARE_GAS_LIMIT and PRIVATE_SETTLEMENT_GAS_LIMIT must be realistic gas limits');
  }
  if (MIN_PRIVATE_PRIORITY_FEE_WEI <= 0n) {
    throw new Error('MIN_PRIVATE_PRIORITY_FEE_WEI must be greater than zero for private-relay inclusion');
  }
  if (!Number.isSafeInteger(KEEPER_RECOVERY_SCAN_LIMIT) || KEEPER_RECOVERY_SCAN_LIMIT < 0) {
    throw new Error('KEEPER_RECOVERY_SCAN_LIMIT must be a non-negative safe integer (0 scans all orders)');
  }
}

async function sendPrivateTransaction(
  signedTransaction: Hex,
  maxBlockNumber: bigint,
  relayAuthAccount: RelayAuthAccount,
): Promise<Hex> {
  const requestBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_sendPrivateTransaction',
    params: [{
      tx: signedTransaction,
      maxBlockNumber: toHex(maxBlockNumber),
      // Avoid opting into relay defaults that may share transaction hints with
      // searchers. The relay/builder still remains a trusted infrastructure
      // party, so this is not a cryptographic privacy guarantee.
      preferences: { fast: false, privacy: { hints: [] } },
    }],
  });
  // Flashbots-compatible relays authenticate the exact JSON-RPC body using an
  // EIP-191 signature. Keep this auth key separate from the funded executor.
  const signature = await relayAuthAccount.signMessage({
    message: { raw: keccak256(stringToHex(requestBody)) },
  });
  const response = await fetch(PRIVATE_RELAY_URL!, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(PRIVATE_TX_TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      'X-Flashbots-Signature': `${relayAuthAccount.address}:${signature}`,
    },
    body: requestBody,
  });
  if (!response.ok) throw new Error(`Private relay returned HTTP ${response.status}`);

  const payload = (await response.json()) as { result?: Hex; error?: { message?: string } };
  if (payload.error || !payload.result || !isHex(payload.result, { strict: true }) || payload.result.length !== 66) {
    throw new Error(`Private relay rejected transaction: ${payload.error?.message ?? 'missing canonical transaction hash'}`);
  }
  return payload.result;
}

async function main() {
  requiredConfiguration();

  const account = privateKeyToAccount(EXECUTOR_PRIVATE_KEY);
  const relayAuthAccount = privateKeyToAccount(PRIVATE_RELAY_AUTH_PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC_URL) });
  if (await publicClient.getChainId() !== sepolia.id) {
    throw new Error('Refusing to run keeper: SEPOLIA_RPC_URL is not connected to Ethereum Sepolia (chain ID 11155111)');
  }
  if (relayAuthAccount.address.toLowerCase() === account.address.toLowerCase()) {
    throw new Error('PRIVATE_RELAY_AUTH_PRIVATE_KEY must be a separate account from SETTLEMENT_EXECUTOR_PRIVATE_KEY');
  }
  const routerCode = await publicClient.getCode({ address: ROUTER_ADDRESS });
  if (!routerCode || routerCode === '0x') {
    throw new Error('SWAP_SHIELD_ROUTER_ADDRESS has no deployed bytecode on Ethereum Sepolia');
  }
  const handleClient = await createViemHandleClient(walletClient);

  const configuredExecutor = (await publicClient.readContract({
    address: ROUTER_ADDRESS,
    abi: ROUTER_ABI,
    functionName: 'settlementExecutor',
  })) as Address;
  if (configuredExecutor.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error('SETTLEMENT_EXECUTOR_PRIVATE_KEY does not match router.settlementExecutor()');
  }

  const [minBatchSize, maxBatchSize, minBatchSettlementWindow] = await Promise.all([
    publicClient.readContract({ address: ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: 'minBatchSize' }),
    publicClient.readContract({ address: ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: 'maxBatchSize' }),
    publicClient.readContract({ address: ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: 'MIN_BATCH_SETTLEMENT_WINDOW' }),
  ]);
  if (maxBatchSize > 12n || minBatchSize < 3n || minBatchSize > maxBatchSize) {
    throw new Error('Router batch configuration is outside the supported safety bounds');
  }
  const minBatchSettlementWindowSeconds = Number(minBatchSettlementWindow);
  if (
    !Number.isSafeInteger(minBatchSettlementWindowSeconds) ||
    minBatchSettlementWindowSeconds < 60 ||
    minBatchSettlementWindowSeconds > 30 * 60
  ) {
    throw new Error('Router settlement window is outside the supported safety bounds');
  }

  const trackedOrderIds = new Set<bigint>();
  const activeOrderIds = new Set<bigint>();
  const preparedBatchIds = new Set<bigint>();
  let running = false;

  async function readOrder(orderId: bigint): Promise<RouterOrder> {
    return (await publicClient.readContract({
      address: ROUTER_ADDRESS,
      abi: ROUTER_ABI,
      functionName: 'orders',
      args: [orderId],
    })) as RouterOrder;
  }

  async function sendPublicValidation(orderId: bigint, fundingProof: Hex) {
    const hash = await walletClient.writeContract({
      address: ROUTER_ADDRESS,
      abi: ROUTER_ABI,
      functionName: 'validateOrder',
      args: [orderId, fundingProof],
    });
    await publicClient.waitForTransactionReceipt({ hash, timeout: PRIVATE_TX_TIMEOUT_MS });
  }

  async function sendPublicExpiryCancellation(orderId: bigint) {
    const hash = await walletClient.writeContract({
      address: ROUTER_ADDRESS,
      abi: ROUTER_ABI,
      functionName: 'cancelOrder',
      args: [orderId],
    });
    await publicClient.waitForTransactionReceipt({ hash, timeout: PRIVATE_TX_TIMEOUT_MS });
  }

  async function sendPrivateContractCall(
    functionName: 'prepareBatch' | 'settleBatch',
    args: readonly unknown[],
    gas: bigint,
  ): Promise<Hex> {
    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName,
      args: args as never,
    });
    const [nonce, fees, blockNumber, latestBlock] = await Promise.all([
      publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      publicClient.estimateFeesPerGas(),
      publicClient.getBlockNumber(),
      publicClient.getBlock(),
    ]);
    const maxPriorityFeePerGas = (fees.maxPriorityFeePerGas ?? 0n) > MIN_PRIVATE_PRIORITY_FEE_WEI
      ? fees.maxPriorityFeePerGas!
      : MIN_PRIVATE_PRIORITY_FEE_WEI;
    const minimumMaxFeePerGas = (latestBlock.baseFeePerGas ?? 0n) + maxPriorityFeePerGas;
    const maxFeePerGas = (fees.maxFeePerGas ?? 0n) > minimumMaxFeePerGas
      ? fees.maxFeePerGas!
      : minimumMaxFeePerGas;
    const signedTransaction = await walletClient.signTransaction({
      account,
      chain: sepolia,
      to: ROUTER_ADDRESS,
      data,
      nonce,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    return sendPrivateTransaction(
      signedTransaction,
      blockNumber + PRIVATE_TX_TTL_BLOCKS,
      relayAuthAccount,
    );
  }

  async function waitForPrivateReceipt(transactionHash: Hex) {
    return publicClient.waitForTransactionReceipt({
      hash: transactionHash,
      timeout: PRIVATE_TX_TIMEOUT_MS,
      pollingInterval: 1_000,
    });
  }

  async function reconcileOrders() {
    const latestBlock = await publicClient.getBlock();
    const now = Number(latestBlock.timestamp);

    for (const orderId of [...trackedOrderIds]) {
      try {
        const order = await readOrder(orderId);

        if (Number(order[6]) === ORDER_STATUS.Pending) {
          if (Number(order[4]) <= now) {
            await sendPublicExpiryCancellation(orderId);
            trackedOrderIds.delete(orderId);
            continue;
          }
          const { value, decryptionProof } = await handleClient.publicDecrypt(order[2]);
          await sendPublicValidation(orderId, decryptionProof);
          if (value) {
            activeOrderIds.add(orderId);
          } else {
            trackedOrderIds.delete(orderId);
          }
          continue;
        }

        if (Number(order[6]) === ORDER_STATUS.Active) {
          if (Number(order[4]) <= now) {
            await sendPublicExpiryCancellation(orderId);
            activeOrderIds.delete(orderId);
            trackedOrderIds.delete(orderId);
          } else {
            activeOrderIds.add(orderId);
          }
          continue;
        }

        activeOrderIds.delete(orderId);
        if (Number(order[6]) === ORDER_STATUS.Prepared) {
          preparedBatchIds.add(BigInt(order[5]));
        }
        trackedOrderIds.delete(orderId);
      } catch (error) {
        // Handle-gateway propagation can lag a freshly submitted encrypted
        // order. Isolate failures so one pending handle does not stall every
        // other validation or batch on the next keeper tick.
        console.error(`Order #${orderId} reconciliation failed:`, error);
      }
    }
  }

  async function settlePreparedBatch(batchId: bigint) {
    const batch = (await publicClient.readContract({
      address: ROUTER_ADDRESS,
      abi: ROUTER_ABI,
      functionName: 'batches',
      args: [batchId],
    })) as RouterBatch;
    if (Number(batch[4]) !== BATCH_STATUS.Prepared) {
      preparedBatchIds.delete(batchId);
      return;
    }

    const latestBlock = await publicClient.getBlock();
    if (Number(batch[2]) < Number(latestBlock.timestamp)) {
      preparedBatchIds.delete(batchId);
      console.error(
        `Batch #${batchId} expired before private settlement. Use the permissionless refund path; do not broadcast a public settlement fallback.`,
      );
      return;
    }

    const { decryptionProof } = await handleClient.publicDecrypt(batch[0]);
    // Do not call eth_estimateGas with this calldata: Nox's public
    // decryption proof contains the aggregate plaintext. The explicit gas
    // limit is intentionally configured server-side instead.
    const settleHash = await sendPrivateContractCall(
      'settleBatch',
      [batchId, decryptionProof],
      PRIVATE_SETTLEMENT_GAS_LIMIT,
    );
    const settleReceipt = await waitForPrivateReceipt(settleHash);
    if (settleReceipt.status !== 'success') throw new Error('Private settlement reverted');
    preparedBatchIds.delete(batchId);
    console.log(`Batch #${batchId} settled through the private relay: ${settleHash}`);
  }

  async function settlePreparedBatches() {
    for (const batchId of [...preparedBatchIds]) {
      try {
        await settlePreparedBatch(batchId);
      } catch (error) {
        console.error(
          `Batch #${batchId} is prepared but was not privately settled. Retry only through the private relay before its deadline; otherwise use the permissionless refund path.`,
          error,
        );
      }
    }
  }

  async function flushBatch() {
    if (activeOrderIds.size < Number(minBatchSize)) return;

    const latestBlock = await publicClient.getBlock();
    const earliestSafeDeadline = Number(latestBlock.timestamp) + minBatchSettlementWindow;
    const selected: bigint[] = [];
    const selectedTraders = new Set<string>();
    for (const orderId of activeOrderIds) {
      const order = await readOrder(orderId);
      if (Number(order[6]) !== ORDER_STATUS.Active) {
        activeOrderIds.delete(orderId);
        trackedOrderIds.add(orderId);
        continue;
      }
      if (Number(order[4]) <= earliestSafeDeadline) continue;
      const normalizedTrader = order[0].toLowerCase();
      if (selectedTraders.has(normalizedTrader)) continue;
      selected.push(orderId);
      selectedTraders.add(normalizedTrader);
      if (selected.length === Number(maxBatchSize)) break;
    }
    if (selected.length < Number(minBatchSize)) return;
    for (const orderId of selected) activeOrderIds.delete(orderId);

    let preparedBatchId: bigint | undefined;
    try {
      const batchId = (await publicClient.readContract({
        address: ROUTER_ADDRESS,
        abi: ROUTER_ABI,
        functionName: 'nextBatchId',
      })) as bigint;

      // Batch preparation creates the aggregate public-decryption request, so
      // it is also private-relay-only. Never expose it via eth_sendTransaction.
      const prepareHash = await sendPrivateContractCall(
        'prepareBatch',
        [selected],
        PRIVATE_PREPARE_GAS_LIMIT,
      );
      const prepareReceipt = await waitForPrivateReceipt(prepareHash);
      if (prepareReceipt.status !== 'success') throw new Error('Private batch preparation reverted');
      preparedBatchId = batchId;
      preparedBatchIds.add(batchId);
      await settlePreparedBatch(batchId);
    } catch (error) {
      console.error('Batch preparation/settlement failed:', error);
      if (preparedBatchId === undefined) {
        // A failed/unincluded prepare leaves selected orders active. Requeue
        // them after their chain status is rechecked on the next tick.
        for (const orderId of selected) activeOrderIds.add(orderId);
      } else {
        preparedBatchIds.add(preparedBatchId);
      }
    }
  }

  async function recoverOrders(firstUnscannedOrderId?: number): Promise<number> {
    const orderCount = (await publicClient.readContract({
      address: ROUTER_ADDRESS,
      abi: ROUTER_ABI,
      functionName: 'nextOrderId',
    })) as bigint;
    if (orderCount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Router order count exceeds this keeper\'s safe recovery range');
    }
    const count = Number(orderCount);
    const firstOrderId = firstUnscannedOrderId ?? (
      KEEPER_RECOVERY_SCAN_LIMIT === 0 ? 0 : Math.max(0, count - KEEPER_RECOVERY_SCAN_LIMIT)
    );
    if (firstOrderId > 0 && firstUnscannedOrderId === undefined) {
      console.warn(
        `Recovery scans the newest ${KEEPER_RECOVERY_SCAN_LIMIT} orders. Set KEEPER_RECOVERY_SCAN_LIMIT >= ${count} for a complete restart recovery.`,
      );
    }
    for (let orderId = firstOrderId; orderId < count; orderId += 1) trackedOrderIds.add(BigInt(orderId));
    return count;
  }

  async function recoverPreparedBatches() {
    const batchCount = (await publicClient.readContract({
      address: ROUTER_ADDRESS,
      abi: ROUTER_ABI,
      functionName: 'nextBatchId',
    })) as bigint;
    if (batchCount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Router batch count exceeds this keeper\'s safe recovery range');
    }
    const count = Number(batchCount);
    const firstBatchId = KEEPER_RECOVERY_SCAN_LIMIT === 0
      ? 0
      : Math.max(0, count - KEEPER_RECOVERY_SCAN_LIMIT);
    if (firstBatchId > 0) {
      console.warn(
        `Prepared-batch recovery scans the newest ${KEEPER_RECOVERY_SCAN_LIMIT} batches. Set KEEPER_RECOVERY_SCAN_LIMIT >= ${count} for a complete restart recovery.`,
      );
    }
    for (let batchId = firstBatchId; batchId < count; batchId += 1) {
      const batch = (await publicClient.readContract({
        address: ROUTER_ADDRESS,
        abi: ROUTER_ABI,
        functionName: 'batches',
        args: [BigInt(batchId)],
      })) as RouterBatch;
      if (Number(batch[4]) === BATCH_STATUS.Prepared) preparedBatchIds.add(BigInt(batchId));
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      await reconcileOrders();
      await settlePreparedBatches();
      await flushBatch();
    } catch (error) {
      console.error('Keeper tick failed:', error);
    } finally {
      running = false;
    }
  }

  const recoveredOrderCount = await recoverOrders();
  await recoverPreparedBatches();
  publicClient.watchContractEvent({
    address: ROUTER_ADDRESS,
    abi: ROUTER_ABI,
    eventName: 'OrderSubmitted',
    // A standard HTTPS RPC endpoint can load-balance successive requests.
    // Viem's default filter watcher stores an eth_newFilter ID on one node and
    // then may poll another, which returns "filter not found". Polling logs is
    // stateless and works with public Sepolia providers as well as paid RPCs.
    poll: true,
    pollingInterval: BATCH_WINDOW_MS,
    onLogs: (logs) => {
      for (const log of logs) {
        if (log.args.orderId !== undefined) trackedOrderIds.add(log.args.orderId);
      }
    },
    onError: (error) => console.error('Order event watcher error:', error),
  });
  // Scan the small interval that could have been submitted while the initial
  // scan was running, so no order is lost between restart recovery and the
  // live event watcher.
  await recoverOrders(recoveredOrderCount);

  console.log(`Private settlement keeper running as ${account.address}`);
  console.log(`Collecting ${minBatchSize.toString()}-${maxBatchSize.toString()} validated orders before each private batch.`);
  await tick();
  setInterval(() => {
    void tick();
  }, BATCH_WINDOW_MS);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
