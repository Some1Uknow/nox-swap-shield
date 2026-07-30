import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import TokenLogo from './components/TokenLogo.jsx';
import { configurationError, connectWallet } from './lib/nox.js';

const OrderForm = lazy(() => import('./components/OrderForm.jsx'));
const OrderList = lazy(() => import('./components/OrderList.jsx'));
const OutputBalance = lazy(() => import('./components/OutputBalance.jsx'));

function ProductNarrative() {
  return (
    <section className="hero" aria-labelledby="product-title">
      <h1 id="product-title">Trade with your <em>size hidden.</em></h1>
      <p className="subtitle">
        NoxSwap encrypts your WETH order size before it enters a shared Uniswap settlement batch.
      </p>
      <a className="powered-by" href="https://www.iex.ec/" target="_blank" rel="noreferrer">
        <span>Powered by</span>
        <img
          src="https://cdn.prod.website-files.com/6646148828eddb19c172bf2a/68bae2d73cecfcbf68e30a41_Logo-iExec-YB_LARGE.png"
          alt="iExec"
        />
      </a>
    </section>
  );
}

function LoadingIndicator({ label }) {
  return (
    <span className="loading-indicator">
      <span className="loading-spinner" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function SwapLoadingPanel() {
  return (
    <div className="swap-card panel swap-loading" aria-busy="true" aria-live="polite">
      <div className="swap-card-heading">
        <div>
          <p className="swap-title">Private swap</p>
          <p className="swap-context">WETH to USDC</p>
        </div>
      </div>
      <div className="swap-loading-content" role="status">
        <span className="loading-spinner" aria-hidden="true" />
        <div>
          <p>Preparing your private swap</p>
          <span>Loading wallet and token details</span>
        </div>
      </div>
      <div className="loading-lines" aria-hidden="true"><i /><i /><i /></div>
    </div>
  );
}

function SwapPreview({ onConnect, connectError, isConnecting }) {
  return (
    <div className="swap-card panel swap-preview">
      <div className="swap-card-heading">
        <div>
          <p className="swap-title">Private swap</p>
          <p className="swap-context">WETH to USDC</p>
        </div>
        <span className="execution-label">Encrypted</span>
      </div>
      <div className="token-field">
        <div className="token-field-label"><span>You pay</span><span>Hidden amount</span></div>
        <div className="token-control">
          <span className="preview-amount">0</span>
          <span className="token-chip"><TokenLogo token="WETH" size={32} />WETH</span>
        </div>
      </div>
      <div className="swap-arrow" aria-hidden="true">↓</div>
      <div className="token-field">
        <div className="token-field-label"><span>You receive</span><span>Minimum output</span></div>
        <div className="token-control">
          <span className="preview-amount">0</span>
          <span className="token-chip"><TokenLogo token="USDC" size={32} />USDC</span>
        </div>
      </div>
      <button className="primary swap-cta" onClick={onConnect} disabled={isConnecting} aria-busy={isConnecting}>
        {isConnecting ? <LoadingIndicator label="Connecting wallet" /> : 'Connect wallet'}
      </button>
      <p className="swap-card-footer">Encrypted locally · Settled in a shared batch</p>
      {isConnecting && <p className="connect-progress" role="status">Confirm the connection in your wallet.</p>}
      {connectError && <p className="helper-text error-text" role="alert">{connectError}</p>}
    </div>
  );
}

export default function App() {
  const [wallet, setWallet] = useState(null);
  const [connectError, setConnectError] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
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
    setIsConnecting(true);
    try {
      setWallet(await connectWallet());
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Unable to connect wallet.');
    } finally {
      setIsConnecting(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="NoxSwap home">
          <img className="brand-mark" src="/noxswap-mark.svg" width="34" height="34" alt="" />
          <span className="brand-name"><strong>NoxSwap</strong><small>Private exchange</small></span>
        </a>
        <span className="network-context"><i aria-hidden="true" /> Sepolia testnet</span>
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
            <SwapPreview onConnect={handleConnect} connectError={connectError} isConnecting={isConnecting} />
          ) : (
            <>
              <div className="connected-row">
                <span className="wallet-status"><i aria-hidden="true" /> Connected</span>
                <code>{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</code>
              </div>
              <Suspense fallback={<SwapLoadingPanel />}>
                <OrderForm wallet={wallet} onOrderSubmitted={() => setRefreshKey((value) => value + 1)} />
                <OrderList
                  wallet={wallet}
                  refreshKey={refreshKey}
                  onOrderCancelled={() => setRefreshKey((value) => value + 1)}
                />
                <details className="claim-drawer">
                  <summary><span>Private WETH</span><span>Manage balance</span></summary>
                  <p className="claim-context">Cancelled and expired orders return WETH here. Reveal your balance or send WETH to your wallet.</p>
                  <OutputBalance
                    wallet={wallet}
                    tokenAddress={import.meta.env.VITE_TOKEN_IN_ADDRESS}
                    shieldedTokenAddress={import.meta.env.VITE_SHIELDED_TOKEN_IN_ADDRESS}
                    refreshKey={refreshKey}
                  />
                </details>
                <details className="claim-drawer">
                  <summary><span>Private USDC</span><span>Reveal or claim</span></summary>
                  <p className="claim-context">Completed batches allocate USDC to your private balance.</p>
                  <OutputBalance wallet={wallet} refreshKey={refreshKey} />
                </details>
              </Suspense>
            </>
          )}
        </section>
      </main>

      <footer className="site-footer">
        <span>NoxSwap</span>
        <span>Built with iExec Nox · Private order sizing, shared settlement</span>
      </footer>
    </div>
  );
}
