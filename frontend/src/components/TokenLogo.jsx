export default function TokenLogo({ token, size = 28 }) {
  const label = token === 'WETH' ? 'Wrapped Ether' : 'USD Coin';

  if (token === 'WETH') {
    return (
      <svg className="token-logo" width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={label}>
        <circle cx="16" cy="16" r="16" fill="#627eea" />
        <path d="m16 4.1-7.1 11.8L16 20l7.1-4.1L16 4.1Z" fill="#fff" fillOpacity=".95" />
        <path d="m16 21.5-7.1-4.1L16 28l7.1-10.6-7.1 4.1Z" fill="#fff" fillOpacity=".72" />
      </svg>
    );
  }

  return (
    <svg className="token-logo" width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={label}>
      <circle cx="16" cy="16" r="16" fill="#2775ca" />
      <circle cx="16" cy="16" r="10.8" fill="none" stroke="#fff" strokeWidth="1.5" />
      <path d="M18.8 12.8c-.7-.7-1.6-1.1-2.8-1.1-2.2 0-3.7 1.5-3.7 3.6 0 2.1 1.5 3.6 3.7 3.6 1.1 0 2.1-.4 2.8-1.1" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M19.8 13.5h3.1M19.8 18.2h3.1M16 9.8v12.4" fill="none" stroke="#fff" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}
