import { useEffect, useState } from 'react';
import { formatUnits, parseUnits } from 'ethers';
import { ADDRESSES, ERC20_ABI, ROUTER_ABI, SHIELDED_TOKEN_ABI } from '../lib/contracts.js';
import { getContract } from '../lib/nox.js';

function readableError(error) {
  return error?.shortMessage || error?.reason || error?.message || 'Transaction failed.';
}

function parsePositiveAmount(value, decimals, label) {
  const amount = parseUnits(value.trim(), decimals);
  if (amount <= 0n) throw new Error(`${label} must be greater than zero.`);
  return amount;
}

export default function OrderForm({ wallet, onOrderSubmitted }) {
  const [fundAmount, setFundAmount] = useState('');
  const [orderAmount, setOrderAmount] = useState('');
  const [minOut, setMinOut] = useState('');
  const [inputMetadata, setInputMetadata] = useState({ decimals: null, symbol: 'input token' });
  const [outputMetadata, setOutputMetadata] = useState({ decimals: null, symbol: 'output token' });
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

      setStatus(`Approving ${formatUnits(amount, inputMetadata.decimals)} ${inputMetadata.symbol} for confidential funding…`);
      await (await inputToken.approve(ADDRESSES.shieldedTokenIn, amount)).wait();
      fundingApprovalGranted = true;
      setStatus('Wrapping into your confidential balance…');
      await (await shieldedToken.wrap(wallet.address, amount)).wait();
      fundingCompleted = true;
      setStatus('Confidential balance funded. Place a separate encrypted order when ready.');
      setFundAmount('');
    } catch (error) {
      setStatus(`Funding failed: ${readableError(error)}`);
    } finally {
      if (inputToken && fundingApprovalGranted) {
        try {
          await (await inputToken.approve(ADDRESSES.shieldedTokenIn, 0)).wait();
        } catch (error) {
          setStatus(
            fundingCompleted
              ? `Funding completed, but the ERC-20 approval reset failed. Reset the approval manually: ${readableError(error)}`
              : `Funding failed and the ERC-20 approval may still be active. Reset it manually: ${readableError(error)}`,
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
    try {
      const amount = parsePositiveAmount(orderAmount, inputMetadata.decimals, 'Sell amount');
      const minOutAmount = parsePositiveAmount(minOut, outputMetadata.decimals, 'Minimum output');
      const latestBlock = await wallet.provider.getBlock('latest');
      if (!latestBlock) throw new Error('Could not read the latest Sepolia block for the order deadline.');
      const deadline = Number(latestBlock.timestamp) + 15 * 60;
      const [shielded, router] = await Promise.all([
        getContract(ADDRESSES.shieldedTokenIn, SHIELDED_TOKEN_ABI, wallet.signer),
        getContract(ADDRESSES.router, ROUTER_ABI, wallet.signer),
      ]);
      shieldedToken = shielded;

      setStatus('Authorizing the router for this short order window…');
      await (await shieldedToken.setOperator(ADDRESSES.router, deadline)).wait();
      operatorGranted = true;

      setStatus('Encrypting the sell amount locally…');
      const { handle, handleProof } = await wallet.handleClient.encryptInput(
        amount,
        'uint256',
        // The router validates the proof against this wallet, then grants
        // ShieldedToken transaction-scoped access for the encrypted transfer.
        ADDRESSES.router,
      );

      setStatus('Submitting the encrypted order…');
      await (await router.submitOrder(handle, handleProof, minOutAmount, deadline)).wait();
      orderSubmitted = true;
      setOrderAmount('');
      onOrderSubmitted?.();
    } catch (error) {
      setStatus(`Order submission failed: ${readableError(error)}`);
    } finally {
      if (shieldedToken && operatorGranted) {
        try {
          // The router has pulled the encrypted amount in the submitted
          // transaction. Always remove temporary delegated access, including
          // when encryption or submission fails after authorization.
          setStatus('Revoking temporary router authorization…');
          await (await shieldedToken.setOperator(ADDRESSES.router, 0)).wait();
          if (orderSubmitted) setStatus('Order submitted for funding validation, then private batch settlement.');
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
    <div className="panel">
      <p className="panel-title">1. Fund confidential balance</p>
      <p className="helper-text">
        Funding is public chain activity. Fund independently of a specific trade to avoid linking a deposit to an order.
      </p>
      <div className="field">
        <label htmlFor="fund-amount">Public funding amount ({inputMetadata.symbol})</label>
        <input id="fund-amount" inputMode="decimal" value={fundAmount} onChange={(event) => setFundAmount(event.target.value)} disabled={!metadataReady || busyAction !== null} />
      </div>
      <button className="secondary" onClick={handleFund} disabled={!metadataReady || busyAction !== null}>
        {busyAction === 'fund' ? 'Funding…' : 'Fund confidential balance'}
      </button>

      <hr className="section-divider" />
      <p className="panel-title">2. Submit encrypted order</p>
      <p className="helper-text">
        The sell amount is encrypted in this transaction. Set a conservative public minimum output; the contract rejects zero-slippage protection.
      </p>
      <div className="field">
        <label htmlFor="sell-amount">Encrypted sell amount ({inputMetadata.symbol})</label>
        <input id="sell-amount" inputMode="decimal" value={orderAmount} onChange={(event) => setOrderAmount(event.target.value)} disabled={!metadataReady || busyAction !== null} />
      </div>
      <div className="field">
        <label htmlFor="min-out">Minimum accepted batch allocation ({outputMetadata.symbol})</label>
        <input id="min-out" inputMode="decimal" value={minOut} onChange={(event) => setMinOut(event.target.value)} disabled={!metadataReady || busyAction !== null} />
      </div>
      <button className="primary wide" onClick={handleSubmitOrder} disabled={!metadataReady || busyAction !== null}>
        {busyAction === 'submit' ? 'Submitting…' : 'Submit encrypted order'}
      </button>

      {status && <p className="helper-text status-message" role="status">{status}</p>}
    </div>
  );
}
