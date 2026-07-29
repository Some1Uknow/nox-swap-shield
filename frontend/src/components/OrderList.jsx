import { useEffect, useState } from 'react';
import { formatUnits } from 'ethers';
import { ADDRESSES, ERC20_ABI, ROUTER_ABI } from '../lib/contracts.js';
import { getContract } from '../lib/nox.js';

const STATUS_LABELS = ['Unknown', 'Verifying funds', 'Waiting for batch', 'Batching privately', 'Swapped privately', 'Cancelled'];
const MAX_VISIBLE_ORDERS = 50;

function readableError(error) {
  return error?.shortMessage || error?.reason || error?.message || 'Unable to load orders.';
}

export default function OrderList({ wallet, refreshKey }) {
  const [orders, setOrders] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [metadata, setMetadata] = useState({ decimals: 18, symbol: 'output token' });
  const [status, setStatus] = useState('');
  const [cancellingId, setCancellingId] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [router, outputToken] = await Promise.all([
          getContract(ADDRESSES.router, ROUTER_ABI, wallet.provider),
          getContract(ADDRESSES.tokenOut, ERC20_ABI, wallet.provider),
        ]);
        const [countValue, decimals, symbol] = await Promise.all([
          router.nextOrderId(),
          outputToken.decimals(),
          outputToken.symbol(),
        ]);
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
            };
          }),
        );
        if (!cancelled) {
          setMetadata({ decimals: Number(decimals), symbol });
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
      setStatus(`Swap #${orderId} cancelled. Your private input is available again.`);
    } catch (error) {
      setStatus(`Cancellation failed: ${readableError(error)}`);
    } finally {
      setCancellingId(null);
    }
  }

  const ownOrders = orders.filter((order) => order.trader.toLowerCase() === wallet.address.toLowerCase());

  if (loaded && ownOrders.length === 0 && !status) return null;

  return (
    <div className="panel activity-panel">
      <div className="panel-heading-row">
        <p className="panel-title">Your swaps</p>
        <span className="refresh-indicator"><i aria-hidden="true" /> Live</span>
      </div>
      {!loaded && <p className="empty-state">Loading…</p>}
      {loaded && ownOrders.length === 0 && <p className="empty-state">No swaps yet.</p>}

      {ownOrders.map((order) => {
        const isCancellable = order.status === 1 || order.status === 2;
        return (
          <div className="order-card" key={order.id}>
            <div>
              <div className="order-meta">Swap #{order.id}</div>
              <div className="order-amount hidden-value">Encrypted WETH amount</div>
              <div className="order-meta">Min. {formatUnits(order.minOut, metadata.decimals)} {metadata.symbol}</div>
            </div>

            <div className="order-actions">
              <span className="badge shielded">
                {STATUS_LABELS[order.status] ?? 'unknown'}
              </span>
              {isCancellable && (
                <button className="secondary" disabled={cancellingId === order.id} onClick={() => handleCancel(order.id)}>
                  {cancellingId === order.id ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
              {order.status >= 3 && <span className="order-meta">Batch #{order.batchId}</span>}
            </div>
          </div>
        );
      })}

      {status && <p className="helper-text status-message" role="status">{status}</p>}
    </div>
  );
}
