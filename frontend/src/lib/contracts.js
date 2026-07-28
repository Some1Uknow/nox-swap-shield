export const ADDRESSES = {
  tokenIn: import.meta.env.VITE_TOKEN_IN_ADDRESS,
  tokenOut: import.meta.env.VITE_TOKEN_OUT_ADDRESS,
  shieldedTokenIn: import.meta.env.VITE_SHIELDED_TOKEN_IN_ADDRESS,
  shieldedTokenOut: import.meta.env.VITE_SHIELDED_TOKEN_OUT_ADDRESS,
  router: import.meta.env.VITE_SWAP_SHIELD_ROUTER_ADDRESS,
};

export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || 11155111);
export const POOL_FEE = Number(import.meta.env.VITE_POOL_FEE || 3000);

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export const SHIELDED_TOKEN_ABI = [
  'function wrap(address to, uint256 amount) returns (bytes32)',
  'function unwrap(address from, address to, bytes32 encryptedAmount, bytes inputProof) returns (bytes32)',
  'function finalizeUnwrap(bytes32 unwrapRequestId, bytes decryptedAmountAndProof)',
  'function unwrapRequester(bytes32 unwrapRequestId) view returns (address)',
  'function setOperator(address operator, uint48 until)',
  'function isOperator(address holder, address spender) view returns (bool)',
  'function confidentialBalanceOf(address account) view returns (bytes32)',
  'event UnwrapRequested(address indexed receiver, bytes32 amount)',
];

export const ROUTER_ABI = [
  'function submitOrder(bytes32 encryptedAmount, bytes inputProof, uint256 minOut, uint48 deadline) returns (uint256)',
  'function validateOrder(uint256 orderId, bytes fundingProof)',
  'function cancelOrder(uint256 orderId)',
  'function nextOrderId() view returns (uint256)',
  'function minBatchSize() view returns (uint256)',
  'function maxBatchSize() view returns (uint256)',
  'function poolFee() view returns (uint24)',
  'function tokenIn() view returns (address)',
  'function tokenOut() view returns (address)',
  'function shieldedTokenIn() view returns (address)',
  'function shieldedTokenOut() view returns (address)',
  'function settlementExecutor() view returns (address)',
  'function orders(uint256 orderId) view returns (address trader, bytes32 inputAmount, bytes32 fundingCheck, uint256 minOut, uint48 deadline, uint256 batchId, uint8 status)',
  'event OrderSubmitted(uint256 indexed orderId, address indexed trader, uint48 deadline)',
  'event OrderActivated(uint256 indexed orderId, address indexed trader)',
  'event OrderRejected(uint256 indexed orderId, address indexed trader)',
  'event OrderCancelled(uint256 indexed orderId, address indexed trader)',
  'event BatchPrepared(uint256 indexed batchId, uint32 orderCount, uint256 totalMinOut, uint48 deadline)',
  'event BatchSettled(uint256 indexed batchId)',
  'event BatchRefunded(uint256 indexed batchId)',
];

export function configuredAddressEntries() {
  return Object.entries(ADDRESSES).filter(([, value]) => !value);
}
