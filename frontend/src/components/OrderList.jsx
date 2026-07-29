import { useEffect, useState } from 'react';
import { formatUnits } from 'ethers';
import { ADDRESSES, ERC20_ABI, ROUTER_ABI } from '../lib/contracts.js';
import { getContract } from '../lib/nox.js';

const STATUS_LABELS = ['Unknown', 'Verifying funds', 'Waiting for batch', 'Batching privately', 'Swapped privately', 'Cancelled'];
const MAX_VISIBLE_ORDERS = 50;

function statusLabel(order, activeWalletCount, minBatchSize) {
  if ((order.status === 1 || order.status === 2) && order.deadline <= order.now) {
    return 'Window closed';
  }
  if (order.status === 2) {
    return activeWalletCount >= minBatchSize ? 'Batching privately' : 'Queued for batch';
  }
  return STATUS_LABELS[order.status] ?? 'Unknown';
}

function readableError(error) {
  return error?.shortMessage || error?.reason || error?.message || 'Unable to load orders.';
}

export default function OrderList({ wallet, refreshKey, onOrderCancelled }) {
  const [orders, setOrders] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [metadata, setMetadata] = useState({ decimals: 18, symbol: 'output token' });
  const [status, setStatus] = useState('');
  const [cancellingId, setCancellingId] = useState(null);
  const [batchRequirement, setBatchRequirement] = useState(3);
  const [activeWalletCount, setActiveWalletCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [router, outputToken] = await Promise.all([
          getContract(ADDRESSES.router, ROUTER_ABI, wallet.provider),
          getContract(ADDRESSES.tokenOut, ERC20_ABI, wallet.provider),
        ]);
        const [countValue, decimals, symbol, minBatchSize, latestBlock] = await Promise.all([
          router.nextOrderId(),
          outputToken.decimals(),
          outputToken.symbol(),
          router.minBatchSize(),
          wallet.provider.getBlock('latest'),
        ]);
        if (!latestBlock) throw new Error('Could not read the latest Sepolia block.');
        const count = Number(countValue);
        if (!Number.isSafeInteger(count)) throw new Error("Order count exceeds this client's safe pagination range.");
        const firstId = Math.max(0, count - MAX_VISIBLE_ORDERS);
        const loaded = await Promise.all(
          Array.from({ length: count - firstId }, async (_, offset) => {
            const id = firstId + offset;
            const order = await router.orders(id);
            return {
              id,
              trader: order.trader,
              minOut: order.minOut,
              deadline: Number(order.deadline),
              batchId: order.batchId.toString(),
              status: Number(order.status),
              now: Number(latestBlock.timestamp),
            };
          }),
        );
        if (!cancelled) {
          setMetadata({ decimals: Number(decimals), symbol });
          setBatchRequirement(Number(minBatchSize));
          setActiveWalletCount(new Set(
            loaded
              .filter((order) => order.status === 2 && order.deadline > Number(latestBlock.timestamp))
              .map((order) => order.trader.toLowerCase()),
          ).size);
          setOrders(loaded.reverse());
          setStatus(count > MAX_VISIBLE_ORDERS ? `Showing the newest ${MAX_VISIBLE_ORDERS} of ${count} orders.` : '');
          setLoaded(true);
        }
      } catch (error) {
        if (!cancelled) setStatus(`Order refresh failed: ${readableError(error)}`);
      }
    }

    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [wallet, refreshKey]);

  async function handleCancel(orderId) {
    setCancellingId(orderId);
    try {
      const router = await getContract(ADDRESSES.router, ROUTER_ABI, wallet.signer);
      await (await router.cancelOrder(orderId)).wait();
      setOrders((current) => current.map((order) => (
        order.id === orderId ? { ...order, status: 5 } : order
      )));
      setStatus(`Swap #${orderId} returned to Private WETH. Reveal it there, then claim it to your wallet if you want.`);
      onOrderCancelled?.();
    } catch (error) {
      setStatus(`Cancellation failed: ${readableError(error)}`);
    } finally {
      setCancellingId(null);
    }
  }

  const ownOrders = orders.filter((order) => order.trader.toLowerCase() === wallet.address.toLowerCase());

  if (loaded && ownOrders.length === 0 && !status) return null;

  if (!loaded) {
    return (
      <div className="panel activity-panel order-list-loading" aria-busy="true" role="status">
        <div className="panel-heading-row">
          <p className="panel-title">Your swaps</p>
        </div>
        <div className="inline-loader">
          <span className="loading-spinner" aria-hidden="true" />
          <span>Syncing swap activity</span>
        </div>
        {status && <p className="helper-text status-message error-text">{status}</p>}
      </div>
    );
  }

  return (
    <div className="panel activity-panel">
      <div className="panel-heading-row">
        <p className="panel-title">Your swaps</p>
        <span className="refresh-indicator"><i aria-hidden="true" /> Live</span>
      </div>
      {ownOrders.length === 0 && <p className="empty-state">No swaps yet.</p>}

      {ownOrders.map((order) => {
        const isCancellable = order.status === 1 || order.status === 2;
        const isExpired = isCancellable && order.deadline <= order.now;
        return (
          <div className="order-card" key={order.id}>
            <div>
              <div className="order-meta">Swap #{order.id}</div>
              <div className="order-amount hidden-value">Encrypted WETH amount</div>
              <div className="order-meta">Min. {formatUnits(order.minOut, metadata.decimals)} {metadata.symbol}</div>
              {isExpired && <div className="order-meta order-warning">Return the encrypted WETH to your private balance below.</div>}
              {!isExpired && order.status === 2 && activeWalletCount < batchRequirement && (
                <div className="order-meta">Your encrypted order is in the next settlement queue.</div>
              )}
            </div>

            <div className="order-actions">
              <span className={`order-state ${isExpired ? 'expired' : ''}`}>
                {statusLabel(order, activeWalletCount, batchRequirement)}
              </span>
              {isCancellable && (
                <button className="secondary" disabled={cancellingId === order.id} onClick={() => handleCancel(order.id)}>
                  {cancellingId === order.id ? 'Returning…' : isExpired ? 'Return WETH' : 'Cancel'}
                </button>
              )}
              {(order.status === 3 || order.status === 4) && <span className="order-meta">Batch #{order.batchId}</span>}
            </div>
          </div>
        );
      })}

      {status && <p className="helper-text status-message" role="status">{status}</p>}
    </div>
  );
}
