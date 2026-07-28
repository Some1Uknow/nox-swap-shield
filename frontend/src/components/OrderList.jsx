import { useEffect, useState } from 'react';
import { formatUnits } from 'ethers';
import { ADDRESSES, ERC20_ABI, ROUTER_ABI } from '../lib/contracts.js';
import { getContract } from '../lib/nox.js';

const STATUS_LABELS = ['unknown', 'validating', 'active', 'batched', 'settled', 'cancelled'];
const MAX_VISIBLE_ORDERS = 50;

function readableError(error) {
  return error?.shortMessage || error?.reason || error?.message || 'Unable to load orders.';
}

export default function OrderList({ wallet, refreshKey }) {
  const [orders, setOrders] = useState([]);
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
      setStatus(`Order #${orderId} cancelled; any funded confidential input was returned to your balance.`);
    } catch (error) {
      setStatus(`Cancellation failed: ${readableError(error)}`);
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <div className="panel">
      <p className="panel-title">Recent encrypted orders</p>
      <p className="helper-text">The list refreshes every 20 seconds. Settlement is intentionally unavailable from the public UI.</p>
      {orders.length === 0 && <p className="helper-text">No orders found on this router.</p>}

      {orders.map((order) => {
        const isOwnOrder = order.trader.toLowerCase() === wallet.address.toLowerCase();
        const isCancellable = order.status === 1 || order.status === 2;
        return (
          <div className="order-card" key={order.id}>
            <div>
              <div className="order-meta">
                #{order.id} · trader {order.trader.slice(0, 6)}…{order.trader.slice(-4)}
              </div>
              <div className="order-amount hidden-value">•••• encrypted input</div>
              <div className="order-meta">public minimum output: {formatUnits(order.minOut, metadata.decimals)} {metadata.symbol}</div>
              <div className="order-meta">deadline: {new Date(order.deadline * 1000).toLocaleTimeString()}</div>
            </div>

            <div className="order-actions">
              <span className="badge shielded">
                {STATUS_LABELS[order.status] ?? 'unknown'}
              </span>
              {isOwnOrder && isCancellable && (
                <button className="secondary" disabled={cancellingId === order.id} onClick={() => handleCancel(order.id)}>
                  {cancellingId === order.id ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
              {order.status >= 3 && <span className="order-meta">batch #{order.batchId}</span>}
            </div>
          </div>
        );
      })}

      {status && <p className="helper-text status-message" role="status">{status}</p>}
    </div>
  );
}
