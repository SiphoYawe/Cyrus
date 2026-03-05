import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store.js';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';

interface CandlestickDataPoint {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface TradeMarker {
  time: string;
  position: 'aboveBar' | 'belowBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  text: string;
}

interface PriceHistory {
  symbol: string;
  candles: CandlestickDataPoint[];
  markers: TradeMarker[];
}

interface AllocationNode {
  name: string;
  symbol: string;
  value: number;
  change24h: number;
}

interface CorrelationData {
  assets: string[];
  matrix: number[][];
}

interface RiskMetrics {
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  var95: number;
  var99: number;
  annualizedReturn: number;
  annualizedVolatility: number;
  calmarRatio: number;
  winRate: number;
  profitFactor: number;
}

interface AnalyticsData {
  priceHistory: PriceHistory;
  allocations: AllocationNode[];
  correlation: CorrelationData;
  riskMetrics: RiskMetrics;
}

function buildPriceHistory(store: Store, symbol: string): PriceHistory {
  const trades = store.getAllTrades();
  const candles: CandlestickDataPoint[] = [];
  const markers: TradeMarker[] = [];

  // Group trades by day to build equity candles
  const dailyPnl = new Map<string, number[]>();
  for (const trade of trades) {
    const day = new Date(trade.executedAt).toISOString().slice(0, 10);
    const existing = dailyPnl.get(day) ?? [];
    existing.push(trade.pnlUsd);
    dailyPnl.set(day, existing);

    markers.push({
      time: day,
      position: trade.pnlUsd >= 0 ? 'aboveBar' : 'belowBar',
      color: trade.pnlUsd >= 0 ? '#22c55e' : '#ef4444',
      shape: trade.pnlUsd >= 0 ? 'arrowUp' : 'arrowDown',
      text: `${trade.pnlUsd >= 0 ? '+' : ''}${trade.pnlUsd.toFixed(2)}`,
    });
  }

  // Build equity curve candles from cumulative PnL
  let cumPnl = 0;
  const sortedDays = Array.from(dailyPnl.keys()).sort();
  for (const day of sortedDays) {
    const pnls = dailyPnl.get(day)!;
    const open = cumPnl;
    let high = cumPnl;
    let low = cumPnl;
    for (const pnl of pnls) {
      cumPnl += pnl;
      if (cumPnl > high) high = cumPnl;
      if (cumPnl < low) low = cumPnl;
    }
    candles.push({ time: day, open, high, low, close: cumPnl });
  }

  // If no trades yet, provide a single candle at zero
  if (candles.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    candles.push({ time: today, open: 0, high: 0, low: 0, close: 0 });
  }

  return { symbol, candles, markers };
}

function buildAllocations(store: Store): AllocationNode[] {
  const balances = store.getAllBalances();
  return balances
    .filter((b) => b.usdValue > 0)
    .map((b) => ({
      name: b.symbol,
      symbol: b.symbol,
      value: b.usdValue,
      change24h: 0, // No historical balance data yet
    }));
}

function buildCorrelation(store: Store): CorrelationData {
  // Build from positions — list unique assets
  const positions = store.getAllPositions();
  const assetSet = new Set<string>();
  for (const p of positions) {
    assetSet.add(p.tokenAddress as string);
  }
  const assets = Array.from(assetSet).slice(0, 10);

  // Identity matrix as placeholder until we accumulate return series
  const n = assets.length || 1;
  const matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );

  return { assets: assets.length > 0 ? assets : ['portfolio'], matrix };
}

function buildRiskMetrics(store: Store): RiskMetrics {
  const trades = store.getAllTrades();
  const returns = trades.map((t) => t.pnlUsd);

  const totalPnl = returns.reduce((s, r) => s + r, 0);
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);
  const winRate = returns.length > 0 ? wins.length / returns.length : 0;
  const grossProfit = wins.reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Stats
  const mean = returns.length > 0 ? totalPnl / returns.length : 0;
  const variance =
    returns.length > 1
      ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)
      : 0;
  const stdDev = Math.sqrt(variance);

  const downsideReturns = returns.filter((r) => r < 0);
  const downsideVariance =
    downsideReturns.length > 0
      ? downsideReturns.reduce((s, r) => s + r ** 2, 0) / downsideReturns.length
      : 0;
  const downsideDev = Math.sqrt(downsideVariance);

  const sharpeRatio = stdDev > 0 ? mean / stdDev : 0;
  const sortinoRatio = downsideDev > 0 ? mean / downsideDev : 0;

  // Max drawdown from cumulative PnL
  let peak = 0;
  let maxDd = 0;
  let cum = 0;
  for (const r of returns) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak > 0 ? (peak - cum) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }

  // Annualize (assume daily returns)
  const annualizedReturn = mean * 365;
  const annualizedVolatility = stdDev * Math.sqrt(365);
  const calmarRatio = maxDd > 0 ? annualizedReturn / maxDd : 0;

  // VaR (historical simulation)
  const sorted = [...returns].sort((a, b) => a - b);
  const var95Index = Math.floor(0.05 * sorted.length);
  const var99Index = Math.floor(0.01 * sorted.length);
  const var95 = sorted.length > 0 ? Math.abs(sorted[Math.max(0, var95Index)]) : 0;
  const var99 = sorted.length > 0 ? Math.abs(sorted[Math.max(0, var99Index)]) : 0;

  return {
    sharpeRatio,
    sortinoRatio,
    maxDrawdown: maxDd,
    var95,
    var99,
    annualizedReturn,
    annualizedVolatility,
    calmarRatio,
    winRate,
    profitFactor: profitFactor === Infinity ? 999 : profitFactor,
  };
}

export function createAnalyticsHandler(store: Store) {
  return function handleAnalytics(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return Promise.resolve();
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const symbol = url.searchParams.get('symbol') ?? 'ETH';

    const data: AnalyticsData = {
      priceHistory: buildPriceHistory(store, symbol),
      allocations: buildAllocations(store),
      correlation: buildCorrelation(store),
      riskMetrics: buildRiskMetrics(store),
    };

    sendSuccess(res, data);
    return Promise.resolve();
  };
}
