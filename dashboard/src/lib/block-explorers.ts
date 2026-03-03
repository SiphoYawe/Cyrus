const EXPLORER_BASES: Record<number, string> = {
  1: 'https://etherscan.io',
  42161: 'https://arbiscan.io',
  10: 'https://optimistic.etherscan.io',
  137: 'https://polygonscan.com',
  8453: 'https://basescan.org',
  56: 'https://bscscan.com',
};

export function getExplorerTxUrl(chainId: number, txHash: string): string {
  const base = EXPLORER_BASES[chainId];
  if (!base) return `#`;
  return `${base}/tx/${txHash}`;
}

export function getExplorerName(chainId: number): string {
  const url = EXPLORER_BASES[chainId];
  if (!url) return 'Explorer';
  try {
    return new URL(url).hostname;
  } catch {
    return 'Explorer';
  }
}

export function truncateTxHash(hash: string, chars = 6): string {
  if (!hash || hash.length < chars * 2 + 2) return hash;
  return `${hash.slice(0, chars + 2)}...${hash.slice(-chars)}`;
}
