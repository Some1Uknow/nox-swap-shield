import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import TokenLogo from './components/TokenLogo.jsx';
import { configurationError, connectWallet } from './lib/nox.js';

const OrderForm = lazy(() => import('./components/OrderForm.jsx'));
const OrderList = lazy(() => import('./components/OrderList.jsx'));
const OutputBalance = lazy(() => import('./components/OutputBalance.jsx'));

function ProductNarrative() {
  return (
    <section className="hero" aria-labelledby="product-title">
      <p className="eyebrow"><span className="eyebrow-dot" /> Private WETH → USDC</p>
      <h1 id="product-title">Swap size,<br /><em>not exposure.</em></h1>
      <p className="subtitle">
        Your order size is encrypted. The batch settles through Uniswap when three wallets are ready.
      </p>
      <p className="privacy-brief">
        Deposit, minimum receive, and aggregate settlement are public. This is size privacy—not full anonymity or atomic MEV protection.
      </p>
    </section>
  );
}

function SwapPreview({ onConnect, connectError }) {
  return (
    <div className="swap-card panel swap-preview">
      <div className="swap-card-heading">
        <p className="swap-title">Swap</p>
        <span className="privacy-chip">Private</span>
      </div>
      <div className="token-field">
        <div className="token-field-label"><span>You pay</span><span>Private</span></div>
        <div className="token-control">
          <span className="preview-amount">0</span>
          <span className="token-chip"><TokenLogo token="WETH" size={28} />WETH<b aria-hidden="true">⌄</b></span>
        </div>
      </div>
      <div className="swap-arrow" aria-hidden="true">↓</div>
      <div className="token-field">
        <div className="token-field-label"><span>You receive</span><span>Protected</span></div>
        <div className="token-control">
          <span className="preview-amount">0</span>
          <span className="token-chip"><TokenLogo token="USDC" size={28} />USDC<b aria-hidden="true">⌄</b></span>
        </div>
      </div>
      <button className="primary swap-cta" onClick={onConnect}>Connect wallet</button>
      <div className="swap-card-footer">
        <span>Sepolia</span>
        <span>3-wallet batch</span>
      </div>
      {connectError && <p className="helper-text error-text" role="alert">{connectError}</p>}
    </div>
  );
}

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
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Swap Shield home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>Swap Shield</span>
        </a>
        <span className="network-pill"><i aria-hidden="true" /> Sepolia beta</span>
      </header>

      <main className="landing-grid">
        <ProductNarrative />
        <section className="swap-rail" aria-label="Private WETH to USDC swap">
          {configIssue ? (
            <div className="panel warning-panel">
              <p className="panel-title">Deployment configuration required</p>
              <p className="helper-text">{configIssue}</p>
            </div>
          ) : !wallet ? (
            <SwapPreview onConnect={handleConnect} connectError={connectError} />
          ) : (
            <>
              <div className="connected-row">
                <span className="wallet-status"><i aria-hidden="true" /> Connected</span>
                <code>{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</code>
              </div>
              <Suspense fallback={<div className="panel"><p className="helper-text">Loading swap…</p></div>}>
                <OrderForm wallet={wallet} onOrderSubmitted={() => setRefreshKey((value) => value + 1)} />
                <OrderList wallet={wallet} refreshKey={refreshKey} />
                <details className="claim-drawer">
                  <summary><span>Private USDC</span><span>Reveal or claim</span></summary>
                  <OutputBalance wallet={wallet} />
                </details>
              </Suspense>
            </>
          )}
        </section>
      </main>

      <footer className="site-footer">
        <span>Built with iExec Nox</span>
        <span>Private trade sizing · Public AMM settlement</span>
      </footer>
    </div>
  );
}
