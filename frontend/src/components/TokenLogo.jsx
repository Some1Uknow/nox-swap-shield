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
    <img
      className="token-logo"
      src="/usdc-token.svg"
      width={size}
      height={size}
      alt={label}
    />
  );
}
