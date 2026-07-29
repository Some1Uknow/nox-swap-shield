import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { configurationError, connectWallet } from './lib/nox.js';

const OrderForm = lazy(() => import('./components/OrderForm.jsx'));
const OrderList = lazy(() => import('./components/OrderList.jsx'));
const OutputBalance = lazy(() => import('./components/OutputBalance.jsx'));

function PrivacyExplainer() {
  return (
    <section className="info-card" aria-labelledby="how-it-works-title">
      <p className="panel-title" id="how-it-works-title">How a private swap works</p>
      <ol className="mini-steps">
        <li>
          <span>1</span>
          <div><strong>Fund once</strong><p>Move WETH into your encrypted balance. This deposit is public.</p></div>
        </li>
        <li>
          <span>2</span>
          <div><strong>Place a private order</strong><p>Your WETH amount is encrypted before it reaches the contract.</p></div>
        </li>
        <li>
          <span>3</span>
          <div><strong>Settle as a batch</strong><p>After 3+ wallet addresses join, the keeper swaps the aggregate through the AMM.</p></div>
        </li>
      </ol>
      <div className="info-callout">
        <strong>Designed for size privacy</strong>
        <p>It hides each order’s input amount, not your wallet address, deposit, or public minimum receive.</p>
      </div>
    </section>
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

      <main>
        <section className="hero">
          <p className="eyebrow"><span className="eyebrow-dot" /> iExec Nox private settlement</p>
          <h1>Swap privately.<br /><em>Settle together.</em></h1>
          <p className="subtitle">
            A private WETH → USDC swap flow that encrypts your trade size, batches orders from multiple wallets,
            then settles their aggregate through the AMM.
          </p>
          <div className="hero-facts" aria-label="Swap Shield features">
            <span>Encrypted trade size</span>
            <span>3-address batches</span>
            <span>Uniswap AMM settlement</span>
          </div>
        </section>

        {configIssue ? (
          <div className="panel warning-panel">
            <p className="panel-title">Deployment configuration required</p>
            <p className="helper-text">{configIssue}</p>
            <p className="helper-text">Copy <code>frontend/.env.example</code> to <code>frontend/.env</code> using public Sepolia deployment addresses, then rebuild.</p>
          </div>
        ) : (
          <div className="product-grid">
            <section className="primary-column" aria-label="Private swap">
              {!wallet ? (
                <div className="swap-card panel connect-card">
                  <div className="swap-card-heading">
                    <div>
                      <p className="panel-title">Private swap</p>
                      <p className="route-title">WETH <span>↓</span> USDC</p>
                    </div>
                    <span className="privacy-chip">Trade size encrypted</span>
                  </div>
                  <p className="connect-copy">
                    Connect a Sepolia wallet to fund a confidential WETH balance and place a private batch order.
                  </p>
                  <button className="primary swap-cta" onClick={handleConnect}>Connect wallet</button>
                  <div className="swap-card-footer">
                    <span>Minimum receive stays public</span>
                    <span>Settlement waits for 3+ addresses</span>
                  </div>
                  {connectError && <p className="helper-text error-text" role="alert">{connectError}</p>}
                </div>
              ) : (
                <>
                  <div className="connected-row">
                    <span className="wallet-status"><i aria-hidden="true" /> Wallet connected</span>
                    <code>{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</code>
                  </div>
                  <Suspense fallback={<div className="panel"><p className="helper-text">Loading your private swap…</p></div>}>
                    <OrderForm wallet={wallet} onOrderSubmitted={() => setRefreshKey((value) => value + 1)} />
                    <OrderList wallet={wallet} refreshKey={refreshKey} />
                  </Suspense>
                </>
              )}
            </section>

            <aside className="side-stack">
              <PrivacyExplainer />
              {wallet && (
                <Suspense fallback={null}>
                  <OutputBalance wallet={wallet} />
                </Suspense>
              )}
            </aside>
          </div>
        )}

        <section className="privacy-notice" aria-labelledby="privacy-model-title">
          <div>
            <p className="panel-title" id="privacy-model-title">Privacy model</p>
            <p>
              The order size is confidential, but the funding transaction, public minimum output, wallet address,
              and mined aggregate AMM settlement remain observable. Private relay submission reduces public-mempool
              exposure for settlement; it is not atomic MEV protection or full transaction anonymity.
            </p>
          </div>
          <span>Built with iExec Nox</span>
        </section>
      </main>
    </div>
  );
}
