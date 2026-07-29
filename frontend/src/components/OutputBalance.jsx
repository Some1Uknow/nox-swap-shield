import { useEffect, useMemo, useState } from 'react';
import { formatUnits, parseUnits } from 'ethers';
import { ADDRESSES, ERC20_ABI, SHIELDED_TOKEN_ABI } from '../lib/contracts.js';
import { getContract } from '../lib/nox.js';

const ZERO_HANDLE = `0x${'00'.repeat(32)}`;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const HANDLE_PATTERN = /^0x[a-fA-F0-9]{64}$/;

function readableError(error) {
  return error?.shortMessage || error?.reason || error?.message || 'Transaction failed.';
}

function parsePositiveAmount(value, decimals) {
  const amount = parseUnits(value.trim(), decimals);
  if (amount <= 0n) throw new Error('Withdrawal amount must be greater than zero.');
  return amount;
}

function pendingRequestStorageKey(walletAddress) {
  return `swap-shield:pending-unwrap:${ADDRESSES.shieldedTokenOut.toLowerCase()}:${walletAddress.toLowerCase()}`;
}

function parseUnwrapRequestId(receipt, shieldedToken) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== shieldedToken.target.toLowerCase()) continue;
    try {
      const event = shieldedToken.interface.parseLog(log);
      if (event?.name === 'UnwrapRequested' && typeof event.args.amount === 'string') {
        return event.args.amount;
      }
    } catch {
      // The receipt also contains logs from other contracts.
    }
  }
  throw new Error('The withdrawal request was mined but its UnwrapRequested event was not found. Check the transaction before retrying.');
}

export default function OutputBalance({ wallet }) {
  const [metadata, setMetadata] = useState({ decimals: null, symbol: 'output token' });
  const [balance, setBalance] = useState(null);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [pendingRequestId, setPendingRequestId] = useState('');
  const [status, setStatus] = useState('');
  const [busyAction, setBusyAction] = useState(null);
  const storageKey = useMemo(() => pendingRequestStorageKey(wallet.address), [wallet.address]);

  useEffect(() => {
    let cancelled = false;

    async function loadMetadata() {
      try {
        const outputToken = await getContract(ADDRESSES.tokenOut, ERC20_ABI, wallet.provider);
        const [decimals, symbol] = await Promise.all([outputToken.decimals(), outputToken.symbol()]);
        if (!cancelled) setMetadata({ decimals: Number(decimals), symbol });
      } catch (error) {
        if (!cancelled) setStatus(`Could not read output-token metadata: ${readableError(error)}`);
      }
    }

    let storedRequest = '';
    try {
      storedRequest = window.localStorage.getItem(storageKey) || '';
    } catch {
      // Browser storage is only a convenience for resuming a pending public
      // withdrawal after reload; the current session remains fully usable.
    }
    setPendingRequestId(storedRequest && HANDLE_PATTERN.test(storedRequest) ? storedRequest : '');
    setBalance(null);
    void loadMetadata();
    return () => {
      cancelled = true;
    };
  }, [wallet, storageKey]);

  async function readConfidentialBalance() {
    const shieldedToken = await getContract(ADDRESSES.shieldedTokenOut, SHIELDED_TOKEN_ABI, wallet.provider);
    const balanceHandle = await shieldedToken.confidentialBalanceOf(wallet.address);
    if (balanceHandle.toLowerCase() === ZERO_HANDLE) return 0n;
    const { value } = await wallet.handleClient.decrypt(balanceHandle);
    return BigInt(value);
  }

  async function refreshBalance() {
    const amount = await readConfidentialBalance();
    setBalance(amount);
    return amount;
  }

  function rememberPendingRequest(requestId) {
    setPendingRequestId(requestId);
    try {
      window.localStorage.setItem(storageKey, requestId);
    } catch {
      // Keep the on-chain request usable for this session even if storage is
      // disabled by the browser.
    }
  }

  function clearPendingRequest() {
    setPendingRequestId('');
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Nothing else is required; the on-chain request has been finalized.
    }
  }

  async function finalizeWithdrawal(requestId, shieldedToken) {
    const recipient = await shieldedToken.unwrapRequester(requestId);
    if (recipient.toLowerCase() === ZERO_ADDRESS) {
      clearPendingRequest();
      try {
        await refreshBalance();
      } catch {
        setBalance(null);
      }
      setStatus('This public withdrawal was already finalized on-chain.');
      return;
    }
    if (recipient.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error('This pending withdrawal belongs to a different wallet.');
    }
    setStatus('Waiting for the Nox public-decryption proof for this voluntary withdrawal…');
    const { decryptionProof } = await wallet.handleClient.publicDecrypt(requestId);
    setStatus('Finalizing the public withdrawal to your wallet…');
    await (await shieldedToken.finalizeUnwrap(requestId, decryptionProof)).wait();
    clearPendingRequest();
    setWithdrawAmount('');
    try {
      await refreshBalance();
    } catch {
      // Finalization is already on-chain; a delayed gateway should not make
      // the completed withdrawal look failed. The user can reveal the balance
      // again once the gateway catches up.
      setBalance(null);
    }
    setStatus('Withdrawal finalized. Its amount is public on-chain, while your remaining confidential balance stays encrypted.');
  }

  async function handleRevealBalance() {
    setBusyAction('balance');
    try {
      const amount = await refreshBalance();
      setStatus(`Confidential output balance revealed locally: ${formatUnits(amount, metadata.decimals ?? 18)} ${metadata.symbol}.`);
    } catch (error) {
      setStatus(`Could not decrypt the confidential output balance: ${readableError(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleWithdraw() {
    if (metadata.decimals === null) return;
    setBusyAction('withdraw');
    let requestId = '';
    try {
      const amount = parsePositiveAmount(withdrawAmount, metadata.decimals);
      const available = await refreshBalance();
      if (amount > available) throw new Error('Withdrawal amount exceeds the confidential output balance.');

      const shieldedToken = await getContract(ADDRESSES.shieldedTokenOut, SHIELDED_TOKEN_ABI, wallet.signer);
      setStatus('Encrypting the withdrawal amount locally…');
      const { handle, handleProof } = await wallet.handleClient.encryptInput(
        amount,
        'uint256',
        ADDRESSES.shieldedTokenOut,
      );
      setStatus('Requesting a public withdrawal. This intentionally makes the withdrawn amount public…');
      const receipt = await (await shieldedToken['unwrap(address,address,bytes32,bytes)'](
        wallet.address,
        wallet.address,
        handle,
        handleProof,
      )).wait();
      requestId = parseUnwrapRequestId(receipt, shieldedToken);
      rememberPendingRequest(requestId);
      await finalizeWithdrawal(requestId, shieldedToken);
    } catch (error) {
      setStatus(
        requestId
          ? `Withdrawal request is on-chain, but finalization is still pending. Use “Finalize pending withdrawal” when the Nox proof is available. ${readableError(error)}`
          : `Withdrawal failed: ${readableError(error)}`,
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleFinalizePending() {
    if (!pendingRequestId) return;
    setBusyAction('finalize');
    try {
      const shieldedToken = await getContract(ADDRESSES.shieldedTokenOut, SHIELDED_TOKEN_ABI, wallet.signer);
      await finalizeWithdrawal(pendingRequestId, shieldedToken);
    } catch (error) {
      setStatus(`Pending withdrawal could not yet be finalized: ${readableError(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  const metadataReady = metadata.decimals !== null;

  return (
    <div className="panel balance-panel">
      <p className="panel-title">Your private {metadata.symbol}</p>
      <p className="helper-text">
        Reveal this balance only in this wallet session. Withdrawing to your normal wallet intentionally makes that amount public on-chain.
      </p>
      <div className="row top-gap-sm">
        <button className="secondary" disabled={!metadataReady || busyAction !== null} onClick={handleRevealBalance}>
          {busyAction === 'balance' ? 'Decrypting…' : 'Reveal private balance'}
        </button>
        {balance !== null && (
          <span className="order-amount revealed-value" aria-live="polite">
            {formatUnits(balance, metadata.decimals)} {metadata.symbol}
          </span>
        )}
      </div>

      <div className="field top-gap-md">
        <label htmlFor="withdraw-output">Amount to withdraw publicly ({metadata.symbol})</label>
        <input
          id="withdraw-output"
          inputMode="decimal"
          value={withdrawAmount}
          onChange={(event) => setWithdrawAmount(event.target.value)}
          disabled={!metadataReady || busyAction !== null || Boolean(pendingRequestId)}
        />
      </div>
      <button className="secondary" disabled={!metadataReady || busyAction !== null || Boolean(pendingRequestId)} onClick={handleWithdraw}>
        {busyAction === 'withdraw' ? 'Withdrawing…' : 'Withdraw to wallet'}
      </button>
      {pendingRequestId && (
        <button className="secondary button-spaced" disabled={busyAction !== null} onClick={handleFinalizePending}>
          {busyAction === 'finalize' ? 'Finalizing…' : 'Finalize pending withdrawal'}
        </button>
      )}
      {status && <p className="helper-text status-message" role="status">{status}</p>}
    </div>
  );
}
