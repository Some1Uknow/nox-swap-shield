import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createViemHandleClient } from '@iexec-nox/handle';
import { handleGatewayUrl, NOX_COMPUTE_ADDRESS, nox } from '@iexec-nox/nox-hardhat-plugin';
import { parseAbiItem, type Hex } from 'viem';

const WAD = 10n ** 18n;
const USDC = 10n ** 6n;
const ZERO_HANDLE = `0x${'00'.repeat(32)}`;
const LOCAL_HANDLE_CONFIG = {
  smartContractAddress: NOX_COMPUTE_ADDRESS,
  gatewayUrl: handleGatewayUrl(),
  // The local tests do not query the subgraph, but the Handle SDK requires a
  // syntactically valid URL when constructing a local-chain client.
  subgraphUrl: 'https://example.com/subgraphs/id/none' as const,
};
const RESOLUTION_RETRY_ATTEMPTS = 4;
const RESOLUTION_RETRY_DELAY_MS = 500;

// Hardhat's local RPC returns every funded account from eth_accounts, while
// @iexec-nox/handle picks the first entry when deriving an encrypted input's
// owner. Bind that RPC method to the WalletClient's selected account so each
// test submits a proof owned by the same trader that sends the transaction.
function ownerBoundWalletClient(walletClient: any) {
  const accountAddress = walletClient.account?.address;
  if (!accountAddress) throw new Error('Expected a local WalletClient account');
  return new Proxy(walletClient, {
    get(target, property, receiver) {
      if (property === 'getAddresses') return async () => [accountAddress];
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// Hardhat Viem decodes public Solidity struct getters as positional tuples.
// Keep these layouts explicit so the test never accidentally sends an
// undefined handle to the Nox gateway.
type OrderRecord = readonly [
  trader: `0x${string}`,
  inputAmount: Hex,
  fundingCheck: Hex,
  minOut: bigint,
  deadline: bigint,
  batchId: bigint,
  status: bigint,
];

type BatchRecord = readonly [
  unwrapRequestId: Hex,
  totalMinOut: bigint,
  deadline: bigint,
  orderCount: bigint,
  status: bigint,
];

async function deployFixture() {
  const { viem } = await nox.connect();
  const [executor, alice, bob, carol, outsider] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const tokenIn = await viem.deployContract('TestERC20', ['Test Wrapped Ether', 'tWETH', 18]);
  const tokenOut = await viem.deployContract('TestERC20', ['Test USD Coin', 'tUSDC', 6]);
  const pool = await viem.deployContract('DemoAMM', [tokenIn.address, tokenOut.address]);
  const shieldedIn = await viem.deployContract('ShieldedToken', [tokenIn.address, 'Shielded tWETH', 'stWETH']);
  const shieldedOut = await viem.deployContract('ShieldedToken', [tokenOut.address, 'Shielded tUSDC', 'stUSDC']);
  const router = await viem.deployContract('SwapShieldRouter', [
    shieldedIn.address,
    shieldedOut.address,
    tokenIn.address,
    tokenOut.address,
    pool.address,
    3000,
    executor.account.address,
    3,
    8,
  ]);

  const seedIn = 100n * WAD;
  const seedOut = 200_000n * USDC;
  await tokenIn.write.faucet([seedIn], { account: executor.account });
  await tokenOut.write.faucet([seedOut], { account: executor.account });
  await tokenIn.write.approve([pool.address, seedIn], { account: executor.account });
  await tokenOut.write.approve([pool.address, seedOut], { account: executor.account });
  await pool.write.addLiquidity([seedIn, seedOut], { account: executor.account });

  return { viem, publicClient, executor, alice, bob, carol, outsider, tokenIn, tokenOut, shieldedIn, shieldedOut, router };
}

async function submitEncryptedOrder(
  trader: any,
  shieldedIn: any,
  tokenIn: any,
  router: any,
  amount = WAD,
  minOut = 1_850n * USDC,
  fundedAmount = amount,
  deadlineOffsetSeconds = 15 * 60,
) {
  // Derive deadlines from the simulated chain, not the host clock. A local
  // test can advance EVM time independently of wall time.
  const { viem } = await nox.connect();
  const latestBlock = await (await viem.getPublicClient()).getBlock();
  const deadline = Number(latestBlock.timestamp) + deadlineOffsetSeconds;
  if (fundedAmount > 0n) {
    await tokenIn.write.faucet([fundedAmount], { account: trader.account });
    await tokenIn.write.approve([shieldedIn.address, fundedAmount], { account: trader.account });
    await shieldedIn.write.wrap([trader.account.address, fundedAmount], { account: trader.account });
  }
  await shieldedIn.write.setOperator([router.address, deadline], { account: trader.account });

  // The proof binds the input to this trader and SwapShieldRouter. The router
  // grants ShieldedToken transaction-scoped access before it transfers the
  // balance, then proves only whether the transfer was nonzero.
  const handleClient = await createViemHandleClient(ownerBoundWalletClient(trader), LOCAL_HANDLE_CONFIG);
  const { handle, handleProof } = await handleClient.encryptInput(amount, 'uint256', router.address);
  await router.write.submitOrder([handle, handleProof, minOut, deadline], { account: trader.account });
}

// The Docker Nox stack processes handles asynchronously. Keep the test suite
// serial (below) and retry only the plugin's documented resolution timeout so
// a cold local runner cannot turn a valid protocol flow into a flaky test.
async function publicDecryptWithRetry(handle: Hex) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RESOLUTION_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await nox.publicDecrypt(handle);
    } catch (error) {
      lastError = error;
      const unresolved = error instanceof Error && error.message.startsWith('Handles not resolved after');
      if (!unresolved || attempt === RESOLUTION_RETRY_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, RESOLUTION_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

async function validateOrder(router: any, validator: any, orderId: bigint) {
  const order = (await router.read.orders([orderId])) as OrderRecord;
  const { value, decryptionProof } = await publicDecryptWithRetry(order[2]);
  await router.write.validateOrder([orderId, decryptionProof], { account: validator.account });
  return Boolean(value);
}

describe('SwapShieldRouter', { concurrency: false }, () => {
  it('adapts the deadline-bearing router interface to SwapRouter02 without retaining input', async () => {
    const { viem } = await nox.connect();
    const [trader, recipient] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const tokenIn = await viem.deployContract('TestERC20', ['Test Wrapped Ether', 'tWETH', 18]);
    const tokenOut = await viem.deployContract('TestERC20', ['Test USD Coin', 'tUSDC', 6]);
    const swapRouter02 = await viem.deployContract('MockSwapRouter02', [tokenIn.address, tokenOut.address]);
    const adapter = await viem.deployContract('UniswapV3SwapRouter02Adapter', [swapRouter02.address]);

    const inputLiquidity = 100n * WAD;
    const outputLiquidity = 200_000n * USDC;
    await tokenIn.write.faucet([inputLiquidity], { account: trader.account });
    await tokenOut.write.faucet([outputLiquidity], { account: trader.account });
    await tokenIn.write.approve([swapRouter02.address, inputLiquidity], { account: trader.account });
    await tokenOut.write.approve([swapRouter02.address, outputLiquidity], { account: trader.account });
    await swapRouter02.write.addLiquidity([inputLiquidity, outputLiquidity], { account: trader.account });

    const amountIn = WAD;
    await tokenIn.write.faucet([amountIn], { account: trader.account });
    await tokenIn.write.approve([adapter.address, amountIn], { account: trader.account });
    const latestBlock = await publicClient.getBlock();
    await adapter.write.exactInputSingle(
      [{
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        fee: 3000,
        recipient: recipient.account.address,
        deadline: latestBlock.timestamp + 60n,
        amountIn,
        amountOutMinimum: 1n,
        sqrtPriceLimitX96: 0n,
      }],
      { account: trader.account },
    );

    assert.equal(await tokenIn.read.balanceOf([adapter.address]), 0n);
    assert.equal(await tokenIn.read.allowance([adapter.address, swapRouter02.address]), 0n);
    const recipientOutput = (await tokenOut.read.balanceOf([recipient.account.address])) as bigint;
    assert.ok(recipientOutput > 0n);
  });

  it('only activates funded encrypted orders, then batches and allocates confidential output balances', async () => {
    const { executor, alice, bob, carol, shieldedIn, shieldedOut, tokenIn, router } = await deployFixture();

    await submitEncryptedOrder(alice, shieldedIn, tokenIn, router);
    await submitEncryptedOrder(bob, shieldedIn, tokenIn, router);
    await submitEncryptedOrder(carol, shieldedIn, tokenIn, router);
    for (const orderId of [0n, 1n, 2n]) {
      assert.equal(await validateOrder(router, executor, orderId), true);
    }

    await router.write.prepareBatch([[0n, 1n, 2n]], { account: executor.account });
    const batch = (await router.read.batches([0n])) as BatchRecord;
    const { decryptionProof } = await publicDecryptWithRetry(batch[0]);
    await router.write.settleBatch([0n, decryptionProof], { account: executor.account });

    for (const orderId of [0n, 1n, 2n]) {
      const order = (await router.read.orders([orderId])) as OrderRecord;
      assert.equal(Number(order[6]), 4, `order ${orderId} should be settled`);
    }
    const aliceOutput = await shieldedOut.read.confidentialBalanceOf([alice.account.address]);
    const bobOutput = await shieldedOut.read.confidentialBalanceOf([bob.account.address]);
    const carolOutput = await shieldedOut.read.confidentialBalanceOf([carol.account.address]);
    assert.notEqual(aliceOutput, ZERO_HANDLE);
    assert.notEqual(bobOutput, ZERO_HANDLE);
    assert.notEqual(carolOutput, ZERO_HANDLE);
  });

  it('rejects an insufficient confidential transfer instead of allowing it into a batch', async () => {
    const { executor, alice, shieldedIn, tokenIn, router } = await deployFixture();

    // The trader owns 1 token but asks the ERC-7984 safe transfer to move 2.
    // ERC-7984 returns an encrypted zero; proof-gated activation rejects it.
    await submitEncryptedOrder(alice, shieldedIn, tokenIn, router, 2n * WAD, 1_850n * USDC, WAD);
    assert.equal(await validateOrder(router, executor, 0n), false);

    const order = (await router.read.orders([0n])) as OrderRecord;
    assert.equal(Number(order[6]), 5, 'unfunded order should be cancelled');
  });

  it('lets a recipient voluntarily unwrap a chosen confidential output amount', async () => {
    const { publicClient, executor, alice, bob, carol, shieldedIn, shieldedOut, tokenIn, tokenOut, router } = await deployFixture();

    await submitEncryptedOrder(alice, shieldedIn, tokenIn, router);
    await submitEncryptedOrder(bob, shieldedIn, tokenIn, router);
    await submitEncryptedOrder(carol, shieldedIn, tokenIn, router);
    for (const orderId of [0n, 1n, 2n]) await validateOrder(router, executor, orderId);
    await router.write.prepareBatch([[0n, 1n, 2n]], { account: executor.account });
    const batch = (await router.read.batches([0n])) as BatchRecord;
    const { decryptionProof: batchProof } = await publicDecryptWithRetry(batch[0]);
    await router.write.settleBatch([0n, batchProof], { account: executor.account });

    const withdrawal = 100n * USDC;
    const aliceHandleClient = await createViemHandleClient(ownerBoundWalletClient(alice), LOCAL_HANDLE_CONFIG);
    const { handle, handleProof } = await aliceHandleClient.encryptInput(withdrawal, 'uint256', shieldedOut.address);
    const requestHash = await shieldedOut.write.unwrap(
      [alice.account.address, alice.account.address, handle, handleProof],
      { account: alice.account },
    );
    const requestReceipt = await publicClient.waitForTransactionReceipt({ hash: requestHash });
    const unwrapEvents = await publicClient.getLogs({
      address: shieldedOut.address,
      event: parseAbiItem('event UnwrapRequested(address indexed receiver, bytes32 amount)'),
      fromBlock: requestReceipt.blockNumber,
      toBlock: requestReceipt.blockNumber,
    });
    const unwrapRequestId = unwrapEvents.at(-1)?.args.amount;
    assert.ok(unwrapRequestId, 'unwrap request event should expose the public-decryption handle');

    const outputBefore = (await tokenOut.read.balanceOf([alice.account.address])) as bigint;
    const { decryptionProof } = await publicDecryptWithRetry(unwrapRequestId);
    await shieldedOut.write.finalizeUnwrap([unwrapRequestId, decryptionProof], { account: executor.account });
    const outputAfter = (await tokenOut.read.balanceOf([alice.account.address])) as bigint;
    assert.equal(outputAfter - outputBefore, withdrawal);
  });

  it('binds encrypted input to the submitting trader and blocks a non-executor batch attempt', async () => {
    const { executor, alice, bob, carol, outsider, shieldedIn, tokenIn, router } = await deployFixture();

    await submitEncryptedOrder(alice, shieldedIn, tokenIn, router);
    await submitEncryptedOrder(bob, shieldedIn, tokenIn, router);
    await submitEncryptedOrder(carol, shieldedIn, tokenIn, router);
    for (const orderId of [0n, 1n, 2n]) await validateOrder(router, executor, orderId);

    const firstOrder = (await router.read.orders([0n])) as OrderRecord;
    assert.equal(firstOrder[0].toLowerCase(), alice.account.address.toLowerCase());
    await assert.rejects(
      router.write.prepareBatch([[0n, 1n, 2n]], { account: outsider.account }),
      /UnauthorizedExecutor|reverted|execution reverted/i,
    );

    await router.write.prepareBatch([[0n, 1n, 2n]], { account: executor.account });
    const preparedOrder = (await router.read.orders([0n])) as OrderRecord;
    assert.equal(Number(preparedOrder[6]), 3);
  });

  it('requires distinct trader addresses in a batch', async () => {
    const { executor, alice, bob, shieldedIn, tokenIn, router } = await deployFixture();

    await submitEncryptedOrder(alice, shieldedIn, tokenIn, router);
    await submitEncryptedOrder(alice, shieldedIn, tokenIn, router);
    await submitEncryptedOrder(bob, shieldedIn, tokenIn, router);
    for (const orderId of [0n, 1n, 2n]) await validateOrder(router, executor, orderId);

    await assert.rejects(
      router.write.prepareBatch([[0n, 1n, 2n]], { account: executor.account }),
      /DuplicateTraderInBatch|reverted|execution reverted/i,
    );
    for (const orderId of [0n, 1n, 2n]) {
      const order = (await router.read.orders([orderId])) as OrderRecord;
      assert.equal(Number(order[6]), 2, `order ${orderId} should remain active`);
    }
  });

  it('refuses to prepare an almost-expired batch that cannot safely complete', async () => {
    const { executor, alice, bob, carol, shieldedIn, tokenIn, router } = await deployFixture();

    for (const trader of [alice, bob, carol]) {
      await submitEncryptedOrder(
        trader,
        shieldedIn,
        tokenIn,
        router,
        WAD,
        1_850n * USDC,
        WAD,
        2 * 60,
      );
    }
    for (const orderId of [0n, 1n, 2n]) await validateOrder(router, executor, orderId);

    await assert.rejects(
      router.write.prepareBatch([[0n, 1n, 2n]], { account: executor.account }),
      /BatchDeadlineTooSoon|reverted|execution reverted/i,
    );
  });

  it('allows an active order to be confidentially cancelled by its trader', async () => {
    const { executor, alice, shieldedIn, tokenIn, router } = await deployFixture();

    await submitEncryptedOrder(alice, shieldedIn, tokenIn, router);
    await validateOrder(router, executor, 0n);
    await router.write.cancelOrder([0n], { account: alice.account });

    const order = (await router.read.orders([0n])) as OrderRecord;
    assert.equal(Number(order[6]), 5);
    const restoredBalance = await shieldedIn.read.confidentialBalanceOf([alice.account.address]);
    assert.notEqual(restoredBalance, ZERO_HANDLE);
  });

  it('permissionlessly refunds an expired prepared batch to its original traders', async () => {
    const { viem, executor, alice, bob, carol, outsider, shieldedIn, tokenIn, router } = await deployFixture();

    await submitEncryptedOrder(alice, shieldedIn, tokenIn, router);
    await submitEncryptedOrder(bob, shieldedIn, tokenIn, router);
    await submitEncryptedOrder(carol, shieldedIn, tokenIn, router);
    for (const orderId of [0n, 1n, 2n]) await validateOrder(router, executor, orderId);
    await router.write.prepareBatch([[0n, 1n, 2n]], { account: executor.account });

    const batch = (await router.read.batches([0n])) as BatchRecord;
    const { decryptionProof } = await publicDecryptWithRetry(batch[0]);
    const testClient = await viem.getTestClient();
    await testClient.setNextBlockTimestamp({ timestamp: BigInt(batch[2]) + 1n });
    await testClient.mine({ blocks: 1 });

    await router.write.refundExpiredBatch([0n, decryptionProof], { account: outsider.account });
    const refundedBatch = (await router.read.batches([0n])) as BatchRecord;
    assert.equal(Number(refundedBatch[4]), 3);
    for (const orderId of [0n, 1n, 2n]) {
      const order = (await router.read.orders([orderId])) as OrderRecord;
      assert.equal(Number(order[6]), 5);
    }
  });
});
