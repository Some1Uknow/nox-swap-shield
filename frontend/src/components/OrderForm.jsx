import { useEffect, useState } from 'react';
import { formatUnits, parseUnits } from 'ethers';
import {
  ADDRESSES,
  ERC20_ABI,
  POOL_FEE,
  QUOTER_V2_ABI,
  ROUTER_ABI,
  SHIELDED_TOKEN_ABI,
  UNISWAP_V3_QUOTER_V2,
  WETH_ABI,
} from '../lib/contracts.js';
import { getContract } from '../lib/nox.js';
import TokenLogo from './TokenLogo.jsx';

function readableError(error) {
  return error?.shortMessage || error?.reason || error?.message || 'Transaction failed.';
}

function parsePositiveAmount(value, decimals, label) {
  const amount = parseUnits(value.trim(), decimals);
  if (amount <= 0n) throw new Error(`${label} must be greater than zero.`);
  return amount;
}

function applySlippage(amount, basisPoints) {
  return (amount * BigInt(10_000 - basisPoints)) / 10_000n;
}

export default function OrderForm({ wallet, onOrderSubmitted }) {
  const [fundAmount, setFundAmount] = useState('');
  const [orderAmount, setOrderAmount] = useState('');
  const [minOut, setMinOut] = useState('');
  const [inputMetadata, setInputMetadata] = useState({ decimals: null, symbol: 'input token' });
  const [outputMetadata, setOutputMetadata] = useState({ decimals: null, symbol: 'output token' });
  const [quote, setQuote] = useState(null);
  const [quoteStatus, setQuoteStatus] = useState('Enter an amount to fetch a live Uniswap quote.');
  const [slippageBps, setSlippageBps] = useState(100);
  const [status, setStatus] = useState('');
  const [busyAction, setBusyAction] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadMetadata() {
      try {
        const [input, output] = await Promise.all([
          getContract(ADDRESSES.tokenIn, ERC20_ABI, wallet.provider),
          getContract(ADDRESSES.tokenOut, ERC20_ABI, wallet.provider),
        ]);
        const [[inputDecimals, inputSymbol], [outputDecimals, outputSymbol]] = await Promise.all([
          Promise.all([input.decimals(), input.symbol()]),
          Promise.all([output.decimals(), output.symbol()]),
        ]);
        if (!cancelled) {
          setInputMetadata({ decimals: Number(inputDecimals), symbol: inputSymbol });
          setOutputMetadata({ decimals: Number(outputDecimals), symbol: outputSymbol });
        }
      } catch (error) {
        if (!cancelled) setStatus(`Could not read token metadata: ${readableError(error)}`);
      }
    }

    void loadMetadata();
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  useEffect(() => {
    if (inputMetadata.decimals === null || outputMetadata.decimals === null || !orderAmount.trim()) {
      setQuote(null);
      setQuoteStatus('Enter an amount to fetch a live Uniswap quote.');
      return undefined;
    }

    let amountIn;
    try {
      amountIn = parsePositiveAmount(orderAmount, inputMetadata.decimals, 'Sell amount');
    } catch {
      setQuote(null);
      setQuoteStatus(`Enter a valid ${inputMetadata.symbol} amount.`);
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      async function fetchQuote() {
        try {
          setQuoteStatus('Fetching live Uniswap quote…');
          const quoter = await getContract(UNISWAP_V3_QUOTER_V2, QUOTER_V2_ABI, wallet.provider);
          const [amountOut] = await quoter.quoteExactInputSingle.staticCall([
            ADDRESSES.tokenIn,
            ADDRESSES.tokenOut,
            amountIn,
            POOL_FEE,
            0,
          ]);
          if (amountOut <= 0n) throw new Error('The pool returned a zero quote.');
          if (!cancelled) {
            setQuote({ amountIn: amountIn.toString(), amountOut });
            setMinOut(formatUnits(applySlippage(amountOut, slippageBps), outputMetadata.decimals));
            setQuoteStatus('Live Uniswap quote');
          }
        } catch (error) {
          if (!cancelled) {
            setQuote(null);
            setQuoteStatus(`Quote unavailable: ${readableError(error)}`);
          }
        }
      }

      void fetchQuote();
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [inputMetadata, orderAmount, outputMetadata, slippageBps, wallet.provider]);

  async function handleFund() {
    if (inputMetadata.decimals === null) return;
    setBusyAction('fund');
    let inputToken;
    let fundingApprovalGranted = false;
    let fundingCompleted = false;
    try {
      const amount = parsePositiveAmount(fundAmount, inputMetadata.decimals, 'Funding amount');
      const [input, shieldedToken] = await Promise.all([
        getContract(ADDRESSES.tokenIn, ERC20_ABI, wallet.signer),
        getContract(ADDRESSES.shieldedTokenIn, SHIELDED_TOKEN_ABI, wallet.signer),
      ]);
      inputToken = input;

      const publicBalance = await inputToken.balanceOf(wallet.address);
      if (publicBalance < amount) {
        if (inputMetadata.symbol !== 'WETH') {
          throw new Error(`You need ${formatUnits(amount - publicBalance, inputMetadata.decimals)} more ${inputMetadata.symbol} before depositing.`);
        }
        const missingAmount = amount - publicBalance;
        const nativeBalance = await wallet.provider.getBalance(wallet.address);
        if (nativeBalance <= missingAmount) {
          throw new Error(`You need ${formatUnits(missingAmount, inputMetadata.decimals)} Sepolia ETH plus gas to make this deposit.`);
        }
        const weth = await getContract(ADDRESSES.tokenIn, WETH_ABI, wallet.signer);
        setStatus(`Wrapping ${formatUnits(missingAmount, inputMetadata.decimals)} Sepolia ETH to WETH…`);
        await (await weth.deposit({ value: missingAmount })).wait();
      }

      setStatus(`Approving ${formatUnits(amount, inputMetadata.decimals)} ${inputMetadata.symbol}…`);
      await (await inputToken.approve(ADDRESSES.shieldedTokenIn, amount)).wait();
      fundingApprovalGranted = true;
      setStatus('Depositing privately…');
      await (await shieldedToken.wrap(wallet.address, amount)).wait();
      fundingCompleted = true;
      setStatus('Deposited. Your WETH is ready to swap privately.');
      setFundAmount('');
    } catch (error) {
      setStatus(`Funding failed: ${readableError(error)}`);
    } finally {
      if (inputToken && fundingApprovalGranted && !fundingCompleted) {
        try {
          // A successful exact-amount transfer consumes the full WETH allowance.
          // Reset only after a failed deposit, when an allowance may remain.
          await (await inputToken.approve(ADDRESSES.shieldedTokenIn, 0)).wait();
        } catch (error) {
          setStatus(
            `Deposit failed and the WETH approval may still be active. Reset it manually: ${readableError(error)}`,
          );
        }
      }
      setBusyAction(null);
    }
  }

  async function handleSubmitOrder() {
    if (inputMetadata.decimals === null || outputMetadata.decimals === null) return;
    setBusyAction('submit');
    let shieldedToken;
    let operatorGranted = false;
    let orderSubmitted = false;
    let failureMessage = '';
    try {
      const amount = parsePositiveAmount(orderAmount, inputMetadata.decimals, 'Sell amount');
      const minOutAmount = parsePositiveAmount(minOut, outputMetadata.decimals, 'Minimum output');
      if (!quote || quote.amountIn !== amount.toString()) {
        throw new Error('Wait for a current live quote before placing the swap.');
      }
      const latestBlock = await wallet.provider.getBlock('latest');
      if (!latestBlock) throw new Error('Could not read the latest Sepolia block for the order deadline.');
      const deadline = Number(latestBlock.timestamp) + 15 * 60;
      const [shielded, router] = await Promise.all([
        getContract(ADDRESSES.shieldedTokenIn, SHIELDED_TOKEN_ABI, wallet.signer),
        getContract(ADDRESSES.router, ROUTER_ABI, wallet.signer),
      ]);
      shieldedToken = shielded;

      setStatus('Encrypting the sell amount locally…');
      const { handle, handleProof } = await wallet.handleClient.encryptInput(
        amount,
        'uint256',
        // The router validates the proof against this wallet, then grants
        // ShieldedToken transaction-scoped access for the encrypted transfer.
        ADDRESSES.router,
      );

      setStatus('Authorizing the router for this short order window…');
      await (await shieldedToken.setOperator(ADDRESSES.router, deadline)).wait();
      operatorGranted = true;

      setStatus('Submitting the encrypted order…');
      await (await router.submitOrder(handle, handleProof, minOutAmount, deadline)).wait();
      orderSubmitted = true;
      setOrderAmount('');
      setMinOut('');
      onOrderSubmitted?.();
    } catch (error) {
      failureMessage = readableError(error);
      setStatus(`Private swap was not submitted: ${failureMessage}`);
    } finally {
      if (shieldedToken && operatorGranted) {
        try {
          // The router has pulled the encrypted amount in the submitted
          // transaction. Always remove temporary delegated access, including
          // when encryption or submission fails after authorization.
          setStatus('Revoking temporary router authorization…');
          await (await shieldedToken.setOperator(ADDRESSES.router, 0)).wait();
          if (orderSubmitted) setStatus('Order submitted for funding validation, then private batch settlement.');
          else setStatus(`Private swap was not submitted: ${failureMessage || 'the order flow did not complete'}. Temporary router authorization was revoked.`);
        } catch (error) {
          setStatus(
            orderSubmitted
              ? `Order was submitted, but router authorization could not be revoked. Revoke it manually: ${readableError(error)}`
              : `Order submission failed and router authorization may still be active. Revoke it manually: ${readableError(error)}`,
          );
        }
      }
      setBusyAction(null);
    }
  }

  const metadataReady = inputMetadata.decimals !== null && outputMetadata.decimals !== null;

  return (
    <div className="swap-card panel">
      <div className="swap-card-heading">
        <p className="swap-title">Swap</p>
        <span className="privacy-chip">Private</span>
      </div>

      <div className="token-field">
        <div className="token-field-label">
          <label htmlFor="sell-amount">You pay</label>
          <span>Private</span>
        </div>
        <div className="token-control">
          <input
            id="sell-amount"
            inputMode="decimal"
            placeholder="0.0"
            value={orderAmount}
            onChange={(event) => setOrderAmount(event.target.value)}
            disabled={!metadataReady || busyAction !== null}
          />
          <span className="token-chip token-in"><TokenLogo token="WETH" size={26} />{inputMetadata.symbol}<b aria-hidden="true">⌄</b></span>
        </div>
      </div>

      <div className="swap-arrow" aria-hidden="true">↓</div>

      <div className="token-field">
        <div className="token-field-label">
          <label htmlFor="min-out">You receive</label>
          <span>Minimum</span>
        </div>
        <div className="token-control">
          <input
            id="min-out"
            inputMode="decimal"
            placeholder="0.0"
            value={minOut}
            onChange={(event) => setMinOut(event.target.value)}
            disabled={!metadataReady || busyAction !== null}
          />
          <span className="token-chip token-out"><TokenLogo token="USDC" size={26} />{outputMetadata.symbol}<b aria-hidden="true">⌄</b></span>
        </div>
      </div>

      <div className="quote-row" aria-live="polite">
        <span className={quote ? 'quote-live' : 'quote-status'}>{quoteStatus}</span>
        {quote && (
          <strong>{formatUnits(quote.amountOut, outputMetadata.decimals)} {outputMetadata.symbol}</strong>
        )}
        <label className="slippage-control">
          Slippage
          <select value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))} disabled={busyAction !== null}>
            <option value={50}>0.5%</option>
            <option value={100}>1%</option>
            <option value={200}>2%</option>
          </select>
        </label>
      </div>
      <p className="min-out-note">
        Live Uniswap quote · Three-wallet batch settlement
      </p>
      <button className="primary swap-cta" onClick={handleSubmitOrder} disabled={!metadataReady || !quote || busyAction !== null}>
        {busyAction === 'submit' ? 'Swapping privately…' : 'Swap privately'}
      </button>
      <div className="swap-card-footer">
        <span>Private relay</span>
        <span>Batch execution</span>
      </div>

      <details className="funding-details">
        <summary>Deposit {inputMetadata.symbol}</summary>
        <div className="funding-content">
          <p className="helper-text">
            Add WETH once to trade privately. Missing WETH is wrapped from your Sepolia ETH automatically.
          </p>
          <div className="field">
            <label htmlFor="fund-amount">Amount ({inputMetadata.symbol})</label>
            <input
              id="fund-amount"
              inputMode="decimal"
              placeholder="0.0"
              value={fundAmount}
              onChange={(event) => setFundAmount(event.target.value)}
              disabled={!metadataReady || busyAction !== null}
            />
          </div>
          <button className="secondary" onClick={handleFund} disabled={!metadataReady || busyAction !== null}>
            {busyAction === 'fund' ? 'Depositing…' : `Deposit ${inputMetadata.symbol}`}
          </button>
        </div>
      </details>

      {status && <p className="helper-text status-message" role="status">{status}</p>}
    </div>
  );
}
