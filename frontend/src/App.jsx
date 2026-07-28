import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { configurationError, connectWallet } from './lib/nox.js';

const OrderForm = lazy(() => import('./components/OrderForm.jsx'));
const OrderList = lazy(() => import('./components/OrderList.jsx'));
const OutputBalance = lazy(() => import('./components/OutputBalance.jsx'));

export default function App() {
  const [wallet, setWallet] = useState(null);
  const [connectError, setConnectError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const configIssue = useMemo(() => configurationError(), []);

  useEffect(() => {
    if (!wallet || !window.ethereum?.on) return undefined;

    const resetWalletSession = () => {
      setWallet(null);
      setConnectError('Your wallet account or network changed. Reconnect to continue safely.');
    };
    window.ethereum.on('accountsChanged', resetWalletSession);
    window.ethereum.on('chainChanged', resetWalletSession);
    return () => {
      window.ethereum.removeListener?.('accountsChanged', resetWalletSession);
      window.ethereum.removeListener?.('chainChanged', resetWalletSession);
    };
  }, [wallet]);

  async function handleConnect() {
    setConnectError('');
    try {
      setWallet(await connectWallet());
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Unable to connect wallet.');
    }
  }

  return (
    <>
      <p className="eyebrow">iExec Nox · private batch settlement</p>
      <h1>Swap Shield</h1>
      <p className="subtitle">
        Fund a confidential balance separately, then submit an encrypted order. A keeper verifies only that the
        transfer was funded, then privately batches orders from at least three distinct addresses, swaps the aggregate through the AMM,
        and allocates confidential output balances.
      </p>

      <div className="lifecycle" aria-label="Settlement lifecycle">
        <div className="lifecycle-step active">1 · public funding</div>
        <span className="lifecycle-arrow">→</span>
        <div className="lifecycle-step active">2 · encrypted order + funding proof</div>
        <span className="lifecycle-arrow">→</span>
        <div className="lifecycle-step">3 · private batch</div>
      </div>

      {configIssue ? (
        <div className="panel warning-panel">
          <p className="panel-title">Deployment configuration required</p>
          <p className="helper-text">{configIssue}</p>
          <p className="helper-text">Copy <code>frontend/.env.example</code> to <code>frontend/.env</code> using public Sepolia deployment addresses, then rebuild.</p>
        </div>
      ) : !wallet ? (
        <div className="panel">
          <p className="panel-title">Connect</p>
          <button className="primary" onClick={handleConnect}>Connect wallet</button>
          {connectError && <p className="helper-text error-text" role="alert">{connectError}</p>}
        </div>
      ) : (
        <>
          <p className="helper-text connected-address">
            Connected as <code>{wallet.address}</code>
          </p>
          <Suspense fallback={<div className="panel"><p className="helper-text">Loading confidential order tools…</p></div>}>
            <OrderForm wallet={wallet} onOrderSubmitted={() => setRefreshKey((value) => value + 1)} />
            <OutputBalance wallet={wallet} />
            <OrderList wallet={wallet} refreshKey={refreshKey} />
          </Suspense>
        </>
      )}

      <p className="footer-note">
        Individual input values are encrypted; minimum outputs, funding deposits, and aggregate AMM execution are
        public. A mined batch-preparation request makes its aggregate decryptable, so the private relay reduces
        mempool exposure but is not an atomic MEV guarantee. Never use this interface with an unverified deployment
        or a public settlement fallback.
      </p>
    </>
  );
}
