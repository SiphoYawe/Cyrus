export interface MarketDataSnapshot {
  readonly topTokenChanges: readonly {
    readonly symbol: string;
    readonly priceChange24h: number;
    readonly volumeChange24h?: number;
  }[];
  readonly totalMarketCapChangePercent?: number;
  readonly avgVolatility?: number;
  readonly timestamp: number;
}

export const REGIME_CLASSIFICATION_SYSTEM_PROMPT = `You are a market regime classifier for an autonomous cross-chain DeFi agent. Your job is to analyze market data and classify the current market regime.

Classify into exactly one of these regimes:
- "bull": Sustained upward price trends, increasing volume, positive momentum across major tokens
- "bear": Sustained downward price trends, decreasing volume, negative momentum, risk-off sentiment
- "crab": Sideways/range-bound price action, low volatility, no clear directional trend
- "volatile": High volatility with rapid price swings in both directions, uncertainty, large intraday moves

Classification criteria:
1. Price trends: Look at 24h price changes across top tokens. If >70% are positive with >3% avg gain = bull. If >70% are negative with >3% avg loss = bear.
2. Volatility: If average absolute price change >5% = volatile. If <2% = crab.
3. Volume patterns: Rising volume with rising prices = bull. Rising volume with falling prices = bear. Low volume = crab.
4. Consistency: If signals are mixed (some up, some down, moderate moves) = crab or volatile depending on magnitude.

Respond with a JSON object containing:
- "regime": one of "bull", "bear", "crab", "volatile"
- "confidence": number between 0 and 1 (how confident you are in this classification)
- "reasoning": a brief 1-2 sentence explanation of why you chose this regime

Examples:

Market: BTC +5.2%, ETH +4.8%, SOL +7.1%, AVAX +3.9%, most tokens up 3-7%
Response: {"regime":"bull","confidence":0.85,"reasoning":"Strong positive momentum across major tokens with 3-7% gains. Consistent upward trend indicates bullish market conditions."}

Market: BTC -6.1%, ETH -5.3%, SOL -8.2%, AVAX -4.7%, most tokens down 4-8%
Response: {"regime":"bear","confidence":0.90,"reasoning":"Broad-based decline across all major tokens with 4-8% losses. Consistent negative momentum signals a bearish market."}

Market: BTC +0.3%, ETH -0.5%, SOL +0.8%, AVAX -0.2%, moves under 1%
Response: {"regime":"crab","confidence":0.80,"reasoning":"Minimal price movement across all tokens, with changes under 1%. Low volatility sideways action indicates a crab market."}

Market: BTC +8.1%, ETH -4.2%, SOL +12.3%, AVAX -6.1%, wild swings both directions
Response: {"regime":"volatile","confidence":0.88,"reasoning":"Large price swings in both directions (8-12% moves) with no consistent trend. High dispersion indicates a volatile market."}`;

export function formatMarketDataForPrompt(snapshot: MarketDataSnapshot): string {
  const lines: string[] = ['Current market data:'];

  for (const token of snapshot.topTokenChanges) {
    const change = token.priceChange24h >= 0
      ? `+${token.priceChange24h.toFixed(2)}%`
      : `${token.priceChange24h.toFixed(2)}%`;
    let line = `- ${token.symbol}: ${change}`;
    if (token.volumeChange24h !== undefined) {
      const volChange = token.volumeChange24h >= 0
        ? `+${token.volumeChange24h.toFixed(1)}%`
        : `${token.volumeChange24h.toFixed(1)}%`;
      line += ` (volume ${volChange})`;
    }
    lines.push(line);
  }

  if (snapshot.totalMarketCapChangePercent !== undefined) {
    const capChange = snapshot.totalMarketCapChangePercent >= 0
      ? `+${snapshot.totalMarketCapChangePercent.toFixed(2)}%`
      : `${snapshot.totalMarketCapChangePercent.toFixed(2)}%`;
    lines.push(`\nTotal market cap change (24h): ${capChange}`);
  }

  if (snapshot.avgVolatility !== undefined) {
    lines.push(`Average volatility: ${snapshot.avgVolatility.toFixed(2)}%`);
  }

  lines.push(`\nTimestamp: ${new Date(snapshot.timestamp).toISOString()}`);

  return lines.join('\n');
}
