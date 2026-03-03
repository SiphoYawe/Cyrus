import { describe, it, expect } from 'vitest';
import { formatDuration, formatUsd, formatPercent, formatBps, pnlColor, pnlBg } from '@/lib/format';

describe('formatDuration', () => {
  it('formats minutes only when under 1 hour', () => {
    expect(formatDuration(5 * 60_000)).toBe('5m');
    expect(formatDuration(45 * 60_000)).toBe('45m');
  });

  it('formats hours and minutes when under 24 hours', () => {
    expect(formatDuration(90 * 60_000)).toBe('1h 30m');
    expect(formatDuration(3 * 3_600_000 + 15 * 60_000)).toBe('3h 15m');
  });

  it('formats days and hours for 24h+', () => {
    expect(formatDuration(25 * 3_600_000)).toBe('1d 1h');
    expect(formatDuration(48 * 3_600_000)).toBe('2d 0h');
  });

  it('returns 0m for zero', () => {
    expect(formatDuration(0)).toBe('0m');
  });
});

describe('formatUsd', () => {
  it('formats positive values', () => {
    expect(formatUsd(1234.56)).toBe('$1,234.56');
  });

  it('formats negative values', () => {
    expect(formatUsd(-99.1)).toBe('-$99.10');
  });

  it('formats zero', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });
});

describe('formatPercent', () => {
  it('adds + sign for positive', () => {
    expect(formatPercent(5.123)).toBe('+5.12%');
  });

  it('shows minus for negative', () => {
    expect(formatPercent(-2.5)).toBe('-2.50%');
  });

  it('adds + sign for zero', () => {
    expect(formatPercent(0)).toBe('+0.00%');
  });
});

describe('formatBps', () => {
  it('formats basis points with 1 decimal', () => {
    expect(formatBps(12.345)).toBe('12.3 bps');
    expect(formatBps(0)).toBe('0.0 bps');
  });
});

describe('pnlColor', () => {
  it('returns positive color for gains', () => {
    expect(pnlColor(100)).toBe('text-positive');
  });

  it('returns negative color for losses', () => {
    expect(pnlColor(-50)).toBe('text-negative');
  });

  it('returns muted for zero', () => {
    expect(pnlColor(0)).toBe('text-muted-foreground');
  });
});

describe('pnlBg', () => {
  it('returns positive bg for gains', () => {
    expect(pnlBg(10)).toBe('bg-positive-muted');
  });

  it('returns negative bg for losses', () => {
    expect(pnlBg(-10)).toBe('bg-negative-muted');
  });

  it('returns muted bg for zero', () => {
    expect(pnlBg(0)).toBe('bg-muted');
  });
});
