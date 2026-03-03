/**
 * Format a duration in ms to human-readable string
 * <1h: "Xm", <24h: "Xh Ym", >=24h: "Xd Yh"
 */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/**
 * Format USD value with $ sign and 2 decimal places
 */
export function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Format a percentage with sign
 */
export function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

/**
 * Format basis points
 */
export function formatBps(bps: number): string {
  return `${bps.toFixed(1)} bps`;
}

/**
 * Get PnL color class
 */
export function pnlColor(value: number): string {
  if (value > 0) return 'text-positive';
  if (value < 0) return 'text-negative';
  return 'text-muted-foreground';
}

/**
 * Get PnL background class
 */
export function pnlBg(value: number): string {
  if (value > 0) return 'bg-positive-muted';
  if (value < 0) return 'bg-negative-muted';
  return 'bg-muted';
}
