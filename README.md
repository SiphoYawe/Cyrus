# Cyrus

Autonomous cross-chain AI agent built on [LI.FI](https://li.fi). Executes real on-chain DeFi strategies, perpetual futures, statistical arbitrage, and market making across EVM and Solana chains with AI-driven decision making, portfolio risk management, and a real-time dashboard.

## Stack

| Dependency | Version | Purpose |
|---|---|---|
| TypeScript | ^5.9 | Strict mode, ESM, bigint for all token amounts |
| @lifi/sdk | ^3.15 | Cross-chain routing, quoting, execution |
| viem | ^2.46 | EVM wallet interactions, signing, chain switching |
| better-sqlite3 | ^12.6 | Persistence (WAL mode, versioned migrations) |
| pino / pino-pretty | ^10.3 / ^13.1 | Structured logging with secret redaction |
| zod | ^4.3 | Config schema validation |
| ws | ^8.19 | WebSocket server for real-time dashboard state |
| @anthropic-ai/sdk | — | Claude API for market regime detection, NL commands, decision reports |
| Next.js + Tailwind + shadcn/ui | — | Dashboard (dark-first, SIWE auth) |
| recharts + TradingView Lightweight Charts | — | Financial visualization |
| Zustand + TanStack Query | — | Dashboard state management |
| teleproto | — | Telegram MTProto client for signal consumption |
| @solana/web3.js | — | Solana chain integration |
| vitest | ^4.0 | Test framework (32 test files) |

Runtime: Node.js ^20.x LTS. Module system: ESM.

## Supported Chains

Ethereum (1), Arbitrum (42161), Optimism (10), Polygon (137), Base (8453), BSC (56), Solana (1151111081099710).

## Architecture

The agent runs a tick-based async OODA loop (Observe → Orient → Decide → Act) derived from Hummingbot's RunnableBase pattern. Default tick interval is 30 seconds. The architecture enforces strict separation between decision-making (strategies/controllers) and execution (executors). Controllers never touch the blockchain directly — they emit `ExecutorAction` objects into a priority queue. The `ExecutorOrchestrator` maps action types to executor classes via a type registry.

### Core Loop

`RunnableBase` provides the async tick loop with configurable interval, consecutive error tracking (10 errors = auto-pause), and graceful shutdown. `CyrusAgent` extends it, calling `controlTask()` each tick to drain the action queue through the executor orchestrator.

### Action System

A priority queue holds `ExecutorAction` objects using a discriminated union on the `type` field: `swap`, `bridge`, `composer`, `rebalance`. Higher priority (0-10) executes first, FIFO within the same priority. Each action carries a `strategyId`, `metadata`, and `createdAt` timestamp.

### State Management

Singleton `Store` (Jesse pattern) using EventEmitter with typed slices: balances (per-chain-per-token composite keys), in-flight transfers (mutable during polling, dual ID: local UUID + blockchain tx hash), completed transfers (immutable historical), positions (entry/current price, PnL per strategy), prices (TTL-cached), and trades (historical execution records). `getAvailableBalance()` deducts in-flight amounts to prevent double-spending. `store.reset()` clears all slices for test isolation.

Events emitted: `balance.updated`, `transfer.created`, `transfer.updated`, `transfer.completed`, `position.updated`, `price.updated`.

### Type Safety

Branded types (`ChainId`, `TokenAddress`, `TransferId`) prevent parameter mixups at call sites. All token amounts use `bigint` — never `number`. Discriminated unions for actions, string literal unions instead of TypeScript enums. Named exports only, barrel files only at package boundaries.

## LI.FI Integration

Implements the 5-call recipe: `GET /chains` → `GET /tokens` → `GET /quote` → execute tx → `GET /status` poll. All calls set `integrator: 'cyrus-agent'`. API key injected via `x-lifi-api-key` header.

### Connector Layer

`LiFiConnector` wraps all LI.FI API calls with TTL caching. Chain and token data cached 1 hour, connections cached 15 minutes, status and quotes are never cached. HTTP client wraps native fetch with error classification: 429 (rate limit) retries with exponential backoff (3 attempts, 5s base), 5xx retries (3 attempts, 2s base), 4xx fails immediately with domain error. Backoff formula: `min(2^attempt * baseDelay, 30s)`.

### Status Polling

Adaptive tiered backoff: 10s (attempts 1-6), 30s (7-12), 60s (13-24), 120s (25+). Max duration 30 minutes. Supports AbortSignal for external cancellation. `NOT_FOUND` is treated as normal (tx not yet indexed). Terminal statuses: `DONE` (substatus: `COMPLETED`, `PARTIAL`, `REFUNDED`) and `FAILED`.

### Transfer Tracking

`TransferTracker` manages up to 20 concurrent polls without blocking the main loop. `TerminalStatusHandler` routes completed transfers: `COMPLETED` updates destination balance, `PARTIAL` enqueues a recovery swap for the different token received, `REFUNDED` restores source balance, `FAILED` logs with full context and evaluates recovery options.

### Composer

When `toToken` is a vault/protocol token address, LI.FI Composer auto-activates — handling swap + bridge + deposit as a single atomic transaction. Supported protocols: Aave V3, Morpho, Euler, Pendle, Lido, EtherFi, Ethena. A vault token registry maps known addresses to protocol metadata.

## Executor Pipeline

Each executor follows the Trigger → Open → Manage → Close stage pipeline (Superalgos pattern).

### Executors

**SwapExecutor** handles same-chain swaps. Trigger validates preconditions (price hasn't moved beyond threshold). Open requests a LI.FI quote, runs approval, submits tx, creates InFlightTransfer. Manage polls status. Close updates store balances and records the trade. On "execution reverted", fetches a fresh quote and retries once.

**BridgeExecutor** handles cross-chain bridges. Same pipeline as SwapExecutor but with async status polling for long bridge delays (can take 15+ minutes). Persists transfer to SQLite immediately for crash recovery.

**ComposerExecutor** handles atomic DeFi operations (vault deposits, staking, lending). Validates protocol support in Trigger, uses Composer quote in Open, tracks multi-step operation as a single transfer in Manage. On failure, recommends manual multi-step fallback.

**PerpExecutor** handles Hyperliquid perpetual futures. Validates margin availability and leverage limits in Trigger. Places market/limit orders in Open. Monitors P&L, funding rates, and Triple Barrier conditions in Manage. Closes via market order in Close.

**StatArbPairExecutor** handles simultaneous long/short pair trades. Places both legs as market orders within the same tick — long first, short immediately after. If the second leg fails, the first is immediately closed. Tracks combined pair P&L, not individual legs.

### Token Approvals

`ApprovalHandler` skips native tokens, checks current allowance, approves exact amounts (never `maxUint256`), handles the USDT zero-reset pattern (reset to 0 before new approval), and waits for receipt confirmation before proceeding.

### Transaction Execution

`TransactionExecutor` verifies wallet chain matches `transactionRequest.chainId` (auto-switches if needed), validates against zero addresses, submits via `walletClient.sendTransaction()`, and waits for receipt.

### Pre-Flight Checks

Validates quote viability before execution: gas cost in USD vs ceiling (default $50), effective slippage vs threshold (default 0.5%), estimated bridge duration vs max timeout. Any breach aborts execution.

## Strategy System

### CrossChainStrategy Abstract Base Class

Strategies extend `CrossChainStrategy` with declarative risk parameters as readonly class properties (Freqtrade pattern): `stoploss`, `minimalRoi`, `trailingStop`, `maxPositions`. Required methods: `shouldExecute(context)` returning `StrategySignal | null`, and `buildExecution(signal, context)` returning `ExecutionPlan`. Optional lifecycle hooks: `onBotStart()`, `onLoopStart()`, `confirmTradeEntry()`, `confirmTradeExit()`, `customStoploss()`. Composable filter chains gate execution — if any filter returns false, the signal is discarded.

Strategies are mode-unaware. They receive a `StrategyContext` with identical shape regardless of whether the agent runs in live, dry-run, or backtest mode. Mode differences are handled entirely by executor and data layers via dependency injection.

### Strategy Loader

Filesystem discovery with prioritized search paths (user directory first, built-in second). Fast pre-check scans for class name before expensive dynamic `import()`. Supports up to 50 user-defined strategies. Drop a `.ts` file extending `CrossChainStrategy` into the strategies directory — no registration needed.

### Built-in Strategies

**YieldHunter** — compares APY rates across lending protocols (Aave V3, Morpho, Euler, Maple) each tick. Detects yield differentials exceeding a net-profit threshold (default 2% APY after gas + bridge costs). Autonomously migrates capital via LI.FI. Tracks positions and auto-compounds when rewards exceed minimum harvest threshold.

**LiquidStakingStrategy** — deposits into liquid staking protocols (Lido wstETH, EtherFi eETH, Ethena sUSDe) via LI.FI Composer. Monitors staking APY. Exit triggers: APY drop below minimum (default 2%), receipt token depeg >2% from underlying, risk dial decrease, or superior opportunity detection.

**CrossChainArbStrategy** — detects cross-chain price differentials across three sub-types: price arbitrage (same token priced differently on DEXs across chains), yield arbitrage (same lending position earning different APYs), and stablecoin depeg arbitrage (buy below peg, sell at peg). Executes only when net profit exceeds configurable minimum ($5 or 0.3% of trade size). Accounts for bridge fees, gas on both chains, swap slippage, and bridge slippage.

**HyperliquidPerps** — trades perpetual futures on Hyperliquid with three sub-strategy modes: `funding_arb` (shorts high-funding markets to collect funding payments), `momentum` (enters on price breakouts with volume confirmation), `mean_reversion` (counter-trend positions when price moves >2 standard deviations from moving average). An `auto` mode lets the AI orchestrator select the appropriate sub-strategy based on market regime.

**MemeTrader** — detects memecoin/degen opportunities via on-chain signals: volume spikes (>5x 24h average), whale movements (>$10k buys from alpha wallets), new liquidity pool creation, social mentions. Aggregates signals into an opportunity score (0-100). Executes with higher slippage tolerance (1-3%) for low-liquidity tokens. Active trailing stop (default 15%). Time-limited positions (default 4 hours). Hard cap at 2% of total portfolio per position.

**PearPairTrader** — delta-neutral pair trading on Pear Protocol. Identifies correlated asset pairs where spread has diverged >2 standard deviations from historical mean. Opens long underperformer + short outperformer with equal notional exposure. Triple Barrier evaluates combined pair P&L, not individual legs.

**MarketMaker** — Hummingbot-style market making on Hyperliquid. Places bid/ask orders around mid-price at configurable spread (default 0.1%) across multiple order levels (default 3). Manages inventory skew — adjusts spreads when inventory is imbalanced, uses LI.FI to bridge excess inventory cross-chain for rebalancing when skew is severe (>85%).

**FreqtradeAdapter** — abstract adapter mapping Freqtrade's `populateIndicators()`, `populateEntryTrend()`, `populateExitTrend()` interface to Cyrus. Translates Freqtrade risk parameters to Triple Barrier. Includes 3 example ported strategies: RSI Mean Reversion, MACD Crossover, Bollinger Bounce.

### MarketDataService

Mode-aware routing (Freqtrade DataProvider pattern). In live mode, routes to LI.FI API for current prices. In backtest mode, routes to historical data with strict lookahead prevention (only data up to current simulated timestamp). Exposes a `ready` gate that blocks controller execution until all data sources are connected. Token prices cached with 30s TTL. Builds `StrategyContext` objects containing balances, positions, prices, active transfers, and market microstructure data (order book depth, volume analytics, funding rates, open interest, cross-asset correlations).

## Risk Management

### Triple Barrier

Every position has three barriers (Hummingbot pattern): stop-loss (fractional), take-profit (fractional), time-limit (seconds). Extended with cross-chain barriers: gas ceiling (max USD), slippage threshold, bridge timeout. Evaluated in priority order: custom exit hook → exit signal → stoploss → ROI targets → trailing stop. `customStoploss()` callback enables dynamic per-trade adjustment. Trailing stop activates at a profit threshold and trails behind current price.

### Portfolio Tier Allocation

Capital allocated across four tiers: Safe, Growth, Degen, Reserve. Each tier has target percentages enforced by the allocation engine. The Reserve tier must be maintained before new Growth/Degen positions open. Signals that would push a tier over maximum allocation are rejected.

### Kelly Criterion Position Sizing

Position sizes within tiers calculated via `f = p - (1-p)/b` where p is win probability and b is payoff ratio. Capped by `maxPositionSizeUsd` and fractional Kelly (half or quarter) for variance reduction. Negative Kelly fraction (expected loss) rejects the trade entirely.

### Drawdown Circuit Breaker

Activates within 1 tick cycle when portfolio value drops below the configured threshold (e.g., -10% from peak). Halts all new position entries across all strategies. In aggressive mode, closes all Growth and Degen tier positions while preserving Safe. Deactivates when portfolio recovers above reset threshold.

### Risk Dial

Single control (1-10) that transforms portfolio tier percentages. Level 1: ~90% Safe, ~5% Growth, 0% Degen, 5% Reserve. Level 5: ~50% Safe, ~30% Growth, ~15% Degen, 5% Reserve. Level 10: ~10% Safe, ~40% Growth, ~45% Degen, 5% Reserve. Changes trigger automatic multi-chain rebalancing via LI.FI.

## AI Intelligence Layer

### Market Regime Detection

Claude API classifies current market conditions as `bull`, `bear`, `crab`, or `volatile` from price and volume data. Returns a confidence score and reasoning. Used to select which strategies should be active — conservative strategies in bear markets, aggressive in bull markets. AI failure never blocks the agent loop (falls back to last known regime).

### Strategy Selection

AI orchestrator activates/deactivates strategies based on detected market regime. Transitions are logged with decision reports. Multiple strategies can be active simultaneously, each independently evaluated each tick.

### Natural Language Commands

Claude API processes plain English instructions (e.g., "Move 20% to Aave on Optimism") into structured execution plans with validated parameters. Handles ambiguous commands with clarification requests. Returns plans for cost estimation and user confirmation before execution.

### Decision Reports

Every autonomous action generates a first-person narrative: "I noticed [observation]. After evaluating [analysis with numbers], I [action] for [expected outcome]. Cost: [gas + fees]. Expected impact: [yield/P&L change]." Persisted to SQLite `decision_reports` table with strategy name, linked transfer IDs, and outcome classification.

### Execution Preview

User-initiated commands show estimated gas cost, bridge fees, slippage, total cost, and completion time before confirmation. Multi-step plans show per-step cost breakdown. Autonomous operations above a configurable USD threshold (default $1,000) require user confirmation with a 5-minute auto-reject timeout.

### LI.FI MCP Server Integration

Claude API tool-calling via LI.FI MCP Server for AI-driven cross-chain analysis — query APY data, compare routes, check gas costs, evaluate bridge fees across chains as part of the AI's reasoning chain. Falls back to REST API on MCP unavailability.

## Data Intelligence

### On-Chain Indexer

Continuously indexes: TVL changes across monitored protocols, large token transfers (>$50k) from known whale wallets, new liquidity pool creation events on major DEXs, gas price changes across chains, APY rate updates, and token flow patterns (accumulation/distribution detection). Events emitted as structured `OnChainEvent` objects queryable by type, chain, token, and time range.

### Enhanced Market Data

Order book depth from DEXs (aggregated via LI.FI) and Hyperliquid. Volume metrics: total volume, buy/sell ratio, volume relative to 7-day average, VWAP. Volatility: realized volatility, ATR, Bollinger Band width. Hyperliquid-specific: current funding rate, predicted next rate, annualized yield, open interest, long/short ratio.

### Social Sentinel

Monitors Twitter/X posts from configurable influencer lists (50+ accounts), token mention volume spikes, viral threads, Discord/Telegram alpha channels, and governance proposals. Claude API produces sentiment scores (-1 to +1) and urgency ratings. Multiple signals for the same token within a time window are consolidated into a single high-confidence signal.

### Signal Matrix

OctoBot-inspired multi-evaluator weighted scoring. Four evaluators (OnChain, Market, Social, Technical) each return a score from -1 (strongly bearish) to +1 (strongly bullish) with a confidence weight. Composite score: `sum(score[i] * weight[i]) / sum(weight[i])`. Weights are configurable per evaluator per strategy. Produces a recommendation: `strong_buy`, `buy`, `neutral`, `sell`, `strong_sell`.

## Statistical Arbitrage

### Math Library

Pearson correlation on hourly log returns (threshold ≥ 0.80, lookback 168 bars / 7 days). Engle-Granger cointegration test (OLS regression → ADF on residuals, reject null at p < 0.05). Ornstein-Uhlenbeck half-life via AR(1) coefficient (threshold ≤ 48 hours). Rolling Z-score with configurable window (default 72 bars / 3 days). OLS hedge ratio (beta) for beta-neutral sizing.

### Universe Scanner

Runs every 4 hours, scanning all Hyperliquid perp pairs. Filters: correlation ≥ 0.80, cointegration p < 0.05, half-life ≤ 48 hours. Completes in <30 seconds for up to 500 pairs. Previously eligible pairs that fail rescan are removed from eligible list but existing open positions are not automatically closed.

### Signal Generator

Continuously checks Z-scores on eligible pairs. Entry: |Z| ≥ 1.5. Exit: |Z| ≤ 0.5. Signals include direction (`long_pair` when Z ≤ -1.5, `short_pair` when Z ≥ +1.5), Z-score, correlation, half-life, and recommended leverage.

### Leverage Selection

x23 for ultra-high confidence (correlation > 0.87, |Z| > 2.5, low spread volatility). x18 for high confidence (correlation > 0.85, |Z| > 2.0) — default matching Agent Pear's usage pattern. x9 for moderate confidence (correlation > 0.82, |Z| > 1.7). x5 for lower confidence (minimum thresholds met). Capped by `config.hyperliquid.maxLeverage`.

### Beta-Neutral Sizing

`longSize = totalCapital / (1 + beta)`, `shortSize = totalCapital * beta / (1 + beta)`. Equal sizing is never used unless hedge ratio is exactly 1.0.

### Exit Management

Four exit mechanisms: mean reversion (|Z| ≤ 0.5), time stop (3x half-life), stoploss (combined pair P&L exceeds max loss threshold — individual leg P&L is irrelevant), and Telegram close signal. Both legs always close simultaneously.

## Telegram Signal Consumer

### Connection

MTProto user client (teleproto library, not a bot) connecting to `@agentpear` channel. Session string persisted in `TELEGRAM_SESSION_STRING` env var, generated via `cyrus telegram-auth` CLI command.

### Reliability

Hybrid event + polling: push-based message handler with 60s polling fallback. Deduplication by message ID. Reconnects within 30 seconds on connection loss with backoff. Startup backfill fetches last 50 messages, parses valid non-expired signals. Signal expiry: 60 minutes.

### Parsing

Regex-based extraction tolerant of formatting variations. Open signals extract: pair, direction, Z-score, correlation, half-life, leverage. Close signals extract: pair, reason, exit Z-score. Unknown messages return null without error.

### Confidence Scoring

Telegram signals get base confidence of 0.66 (Agent Pear's observed win rate), adjusted by Z-score extremity, correlation strength, and signal freshness. Native stat arb signals scored by statistical strength. When both sources signal the same pair, the higher-confidence signal is kept.

## Hyperliquid Integration

### Connector

Queries account balances, open positions, funding rates, open interest, and order book depth. Places market and limit orders with configurable leverage (1x-50x) and time-in-force (GTC/IOC/FOK).

### Cross-Chain Funding

LI.FI bridges USDC from any EVM chain to Arbitrum (Hyperliquid's settlement layer), then deposits into margin account. Auto-detects when margin is low on stat arb trade signals, selects the best-rate source chain. Withdrawal reverses the flow: Hyperliquid margin → Arbitrum → LI.FI bridge to target chain.

### Balance Reconciliation

Each OODA cycle compares Hyperliquid margin balance + unrealized P&L against internal store tracking. Discrepancies >1% trigger a warning and store correction to match on-chain truth.

## Backtesting & Strategy Evolution

### Backtesting Engine

Replays historical data through the same OODA loop as live mode. `SimulatedLiFiConnector` returns simulated quotes with configurable slippage and fee modeling — no API calls. `HistoricalDataLoader` parses CSV/JSON historical price, APY, and volume data. Strict lookahead prevention ensures strategies only see data up to current simulated timestamp. `store.reset()` between runs for isolation.

### Performance Analytics

Sharpe ratio (annualized), Sortino ratio, max drawdown (percentage and duration), win rate, profit factor, Calmar ratio, total return, number of trades. Grid search optimization over parameter space with walk-forward validation (in-sample/out-of-sample split). Overfitting warning when out-of-sample Sharpe drops >50% from in-sample.

### Self-Evolving Strategy Generator

Claude API generates strategy variants from base strategy source code, recent market patterns, and backtest performance. Validated for TypeScript syntax, CrossChainStrategy inheritance, and safe risk parameter bounds. Auto-backtested against 30 days of data. Tournament selection promotes top variants (Sharpe > 0) to paper-trading (7 days, zero capital). Variants with positive paper-trading results promote to live with 1% tier allocation. Runs on configurable schedule (default weekly).

### Predictive Chain Migration

ChainScout monitors chain ecosystem health: TVL inflow rate, new protocol deployments, unique active addresses, bridge volume (via LI.FI connections data), and airdrop indicators. Chains scoring above deployment threshold trigger migration plans via LI.FI. Ecosystem decline triggers exit evaluation and bridge back to established chains.

## Solana Integration

`SolanaConnector` via `@solana/web3.js` for SOL/SPL token queries and transactions. Jupiter DEX integration for best-price Solana swaps. LI.FI bridges between EVM and Solana using chain ID 1151111081099710. Both EVM private key and Solana keypair loaded from env vars. State store uses same composite key pattern with Solana's chain ID. Waits for `confirmed` commitment level on Solana transactions.

## Flash Strategies

Cross-chain arbitrage loops using flash loans as capital source: borrow on Chain A (flash loan) → bridge via LI.FI to Chain B → swap on Chain B → bridge back → repay. Profitability accounts for flash loan fee, gas on both chains, bridge fees both directions, and swap slippage. Non-atomic execution (bridges take time) — the agent holds borrowed amount as short-term liability with strict time limit (default 30 minutes). Priority repayment if deadline approaches. Max flash loan size capped (default $10,000), max 1 concurrent loop.

## Dashboard

### Tech

Next.js with TypeScript, Tailwind, App Router, Turbopack. shadcn/ui for structural components, Tremor for data visualization. State: Zustand (WebSocket-fed real-time) + TanStack Query (REST fetches). Authentication: SIWE (Sign-In with Ethereum) via wagmi/viem, httpOnly cookie with 24h expiry.

### Design System

Dark-first theme ("Calm Terminal" aesthetic). Palette: zinc-950 background, zinc-900 cards, zinc-800 elevated surfaces, violet-500 accent. Semantic colors: green-500 positive, red-500 negative, amber-500 warning, blue-500 info. Chain identity colors per chain. Typography: Inter for UI text, JetBrains Mono for numeric data, amounts, addresses, and tx hashes. 4px base spacing unit, 12-column CSS Grid, sidebar 240px (collapsible to 64px), max-width 1440px.

### Pages

**Overview** — morning briefing banner (overnight P&L, operations count, yield change, risk status), 4 KPI cards (portfolio value, 24h P&L, weighted yield, active operations) with NumberFlow animated transitions, tier allocation donut chart, portfolio value area chart (1D/1W/1M), chain allocation bar list, recent decision report cards.

**Activity** — filterable activity log (All/Trades/Bridges/Deposits tabs), expandable decision report cards with full first-person narrative, sheet panels for transfer details (480px slide from right), real-time updates via WebSocket.

**Strategies** — strategy cards with status badges, tier classification, toggle switches, per-strategy performance metrics (P&L, win rate, trades, positions). Detail sheet shows full config, performance chart, and recent decision reports.

**Chat** — conversational interface for natural language commands. Execution plan previews with inline Confirm/Cancel. Clarification flows. Welcome message with portfolio summary on first visit. Cmd+K for quick access.

**Settings** — risk dial with live donut chart preview and estimated rebalancing cost, chain enable/disable toggles, strategy parameter overrides, agent settings (tick interval, log level, confirmation threshold), API key status (masked, never shown).

**Trading** — perpetual positions table (symbol, side, size, leverage, unrealized P&L, liquidation price, funding rate), pair trade positions (pair name, direction, legs, Z-scores, combined P&L), market making orders (bid/ask levels, inventory, spread, session P&L).

**Backtesting** — completed backtest results (strategy, date range, Sharpe, return, drawdown, win rate), equity curves, drawdown charts, trade distribution histograms, parameter comparison overlays.

### Custom Components

RiskDial, DecisionReportCard, TransferStatusCard (from-chain → animated progress → to-chain), MorningBriefingBanner, AgentStatusIndicator, ConfirmationPanel.

### Onboarding Wizard

6-step flow: Connect Wallet → Set Risk Profile → Select Chains → Review Strategy Defaults → Fund Agent Wallet (QR + address, waits for detection) → Launch Agent (first OODA cycle with explainer overlay).

## Configuration

Hierarchical resolution: CLI args > env vars > config file > defaults. Validated with Zod at startup — invalid config fails fast.

Config file (`cyrus.config.json`): mode (live/dry-run/backtest), tickIntervalMs, logLevel, integrator, risk params (defaultSlippage, maxGasCostUsd, maxPositionSizeUsd, maxConcurrentTransfers, drawdownThreshold), chains (enabled IDs, RPC URLs), strategies (enabled names, directory), composer (enabled, supportedProtocols, defaultSlippage), WebSocket/REST ports, dbPath.

Secrets (env vars only, never in config or logs): `CYRUS_PRIVATE_KEY`, `LIFI_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_SESSION_STRING`.

### Execution Modes

| Behavior | live | dry-run | backtest |
|---|---|---|---|
| On-chain writes | Yes | Never | Never |
| Price source | LI.FI API | LI.FI API | HistoricalDataLoader |
| Balances | On-chain reads | Virtual portfolio (sync once, track virtually) | Simulated |
| Approvals | Real on-chain | Read-only allowance check | Skipped |
| Gas costs | Real | Estimated, not paid | Simulated |
| Bridge wait times | Real async polling | Instant | Configurable simulated delays |
| State persistence | SQLite | SQLite | In-memory |
| Strategy decisions | Normal OODA loop | Identical to live | Identical to live |
| Risk engine | Full triple barrier | Full triple barrier | Full triple barrier |

## Persistence

SQLite with WAL mode and versioned migration system. Tables: `in_flight_transfers`, `completed_transfers`, `activity_log` (90-day retention), `decision_reports`, `stat_arb_positions`, `telegram_messages`, `_migrations`.

Listens to Store events for auto-persistence. On boot, restores non-terminal transfers for crash recovery. SQLite naming: snake_case tables/columns mapped to camelCase at the persistence boundary.

## Observability

### REST API

All responses use `ok/data/error` envelope format. Endpoints: `GET /api/health` (liveness), `GET /api/portfolio` (balances, positions, P&L, tier allocation), `GET /api/activity` (paginated decision reports), `GET /api/strategies` (loaded strategies, status, performance), `GET /api/config` (current config, secrets redacted).

### WebSocket

Real-time event stream with typed dot-notation envelopes and 30s heartbeat. Events: `state.balance.updated`, `state.transfer.created`, `state.transfer.updated`, `state.transfer.completed`, `state.position.updated`, `state.price.updated`, `decision.report`. Bidirectional: dashboard sends commands (`risk.dial.change`, `nl.command`, `strategy.toggle`). No buffering when no clients connected.

### Logging

Pino structured logging. Dev: pretty-printed, colorized. Production: JSON. Auto-redacts private keys, API keys, and explicit secret paths. Component-scoped child loggers with `{ component, operation, ...context }` pattern.

## Error Handling

Domain-specific error classes with context: `CyrusError` (base), `LiFiQuoteError`, `BridgeTimeoutError`, `InsufficientBalanceError`, `ConfigValidationError`, `ApprovalError`, `TransactionExecutionError`, `RateLimitError`, `PerpOrderRejectedError`, `StrategyConfigError`.

Retry utility: exponential backoff (max 3 retries, capped at 30s). Transient errors (rate limit, server) retry. Client errors (400, bad input) fail immediately. Error recovery flow: executor → domain error → controller classification → circuit breaker evaluation → SQLite persistence.

Error recovery options presented to users: retry with adjusted parameters, hold funds at current location, bridge back to origin, retry deposit only.

## Non-Functional Requirements

| Category | Target |
|---|---|
| Tick-to-execution latency | <5s from opportunity detection to LI.FI quote |
| Dashboard initial load | <3s with 10 chains, 50 positions |
| Concurrent in-flight transfers | 20 without blocking main loop |
| API cache hit rate | >80% for chain/token data |
| Backtest replay speed | 30 days of data in <5 minutes |
| Signal matrix evaluation | <500ms for all evaluators |
| Social pipeline latency | <10s from detection to trade signal |
| Stat arb universe scan | <30s for 500 pairs |
| Concurrent strategies | Up to 50 user-defined |
| Concurrent positions | Up to 100 across all chains |
| Telegram reconnect | <30s on connection loss |
| Circuit breaker activation | Within 1 tick cycle of threshold breach |

## Security

- Private keys exist only in process memory via env vars — never written to disk, logs, or config
- ERC20 approvals use exact amounts (never `maxUint256`)
- Destination addresses from LI.FI quotes validated against known contracts before signing
- Wallet chain ID verified against requested chain before every signing operation
- Solana program IDs validated against allowlist before signing SPL transactions

## Scripts

`npm run dev` — tsx watch mode. `npm run build` — tsc compile. `npm start` — run compiled output. `npm test` — vitest run. `npm run lint` — tsc --noEmit.

## Tests

32 test files covering config validation, branded types, action queue, store events, HTTP client retry/error classification, status parsing/polling, executor orchestration, pre-flight checks, approval handling, transaction execution, persistence, REST/WS servers, and transfer tracking.

## License

ISC
