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
  if (amount <= 0n) throw new Error('Claim amount must be greater than zero.');
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
  throw new Error('The claim request was mined but its event was not found. Check the transaction before retrying.');
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
      setStatus('This public claim was already finalized on-chain.');
      return;
    }
    if (recipient.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error('This pending claim belongs to a different wallet.');
    }
    setStatus('Preparing your public claim…');
    const { decryptionProof } = await wallet.handleClient.publicDecrypt(requestId);
    setStatus('Sending USDC to your wallet…');
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
    setStatus('USDC claimed to your wallet. This claim amount is public on-chain.');
  }

  async function handleRevealBalance() {
    setBusyAction('balance');
    try {
      const amount = await refreshBalance();
      setStatus(`Private balance: ${formatUnits(amount, metadata.decimals ?? 18)} ${metadata.symbol}.`);
    } catch (error) {
      setStatus(`Could not reveal your private balance: ${readableError(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleWithdraw() {
    if (metadata.decimals === null) return;
    setBusyAction('withdraw');
    let requestId = '';
    try {
      const available = balance ?? await refreshBalance();
      const amount = withdrawAmount.trim()
        ? parsePositiveAmount(withdrawAmount, metadata.decimals)
        : available;
      if (amount <= 0n) throw new Error('There is no private output available to claim.');
      if (amount > available) throw new Error('Claim amount exceeds your private balance.');

      const shieldedToken = await getContract(ADDRESSES.shieldedTokenOut, SHIELDED_TOKEN_ABI, wallet.signer);
      setStatus('Preparing your claim…');
      const { handle, handleProof } = await wallet.handleClient.encryptInput(
        amount,
        'uint256',
        ADDRESSES.shieldedTokenOut,
      );
      setStatus('Requesting USDC to your wallet…');
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
          ? `Your claim request is on-chain, but finalization is still pending. Use “Finish claim” when the Nox proof is available. ${readableError(error)}`
          : `Claim failed: ${readableError(error)}`,
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
      setStatus(`Claim could not yet be finalized: ${readableError(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  const metadataReady = metadata.decimals !== null;

  return (
    <div className="claim-panel">
      <div className="row top-gap-sm">
        <button className="secondary" disabled={!metadataReady || busyAction !== null} onClick={handleRevealBalance}>
          {busyAction === 'balance' ? 'Revealing…' : 'Reveal balance'}
        </button>
        {balance !== null && (
          <>
            <span className="order-amount revealed-value" aria-live="polite">
              {formatUnits(balance, metadata.decimals)} {metadata.symbol}
            </span>
            <button className="primary claim-button" disabled={busyAction !== null || balance <= 0n || Boolean(pendingRequestId)} onClick={handleWithdraw}>
              {busyAction === 'withdraw' ? 'Claiming…' : 'Claim to wallet'}
            </button>
          </>
        )}
      </div>

      {balance !== null && !pendingRequestId && (
        <details className="partial-claim">
          <summary>Claim a different amount</summary>
          <div className="field">
            <label htmlFor="withdraw-output">Amount ({metadata.symbol})</label>
            <input
              id="withdraw-output"
              inputMode="decimal"
              value={withdrawAmount}
              onChange={(event) => setWithdrawAmount(event.target.value)}
              disabled={!metadataReady || busyAction !== null}
            />
          </div>
          <button className="secondary" disabled={!metadataReady || busyAction !== null} onClick={handleWithdraw}>
            {busyAction === 'withdraw' ? 'Claiming…' : 'Claim amount'}
          </button>
        </details>
      )}
      {pendingRequestId && (
        <button className="secondary button-spaced" disabled={busyAction !== null} onClick={handleFinalizePending}>
          {busyAction === 'finalize' ? 'Finishing…' : 'Finish claim'}
        </button>
      )}
      {status && <p className="helper-text status-message" role="status">{status}</p>}
    </div>
  );
}
