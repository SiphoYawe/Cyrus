# Cyrus

Autonomous cross-chain agent built on [LI.FI](https://li.fi) for executing on-chain DeFi strategies across EVM chains.

## Stack

| Dependency | Version | Purpose |
|---|---|---|
| TypeScript | ^5.9 | Strict mode, ESM modules |
| @lifi/sdk | ^3.15 | Cross-chain routing, quoting, execution |
| viem | ^2.46 | EVM wallet interactions, signing, chain switching |
| better-sqlite3 | ^12.6 | Persistence layer (WAL mode, migrations) |
| pino | ^10.3 | Structured logging with secret redaction |
| zod | ^4.3 | Config schema validation |
| ws | ^8.19 | WebSocket server for real-time state |
| vitest | ^4.0 | Test framework |
| tsx | ^4.21 | Dev server with watch mode |

Runtime: Node.js ^20.x LTS. Module system: ESM (`"type": "module"`).

## Architecture

Cyrus uses a **tick-based async execution loop** derived from Hummingbot's RunnableBase pattern. The agent ticks every 30 seconds (configurable), processing queued actions through a registry-dispatched executor pipeline.

### Core Loop

`RunnableBase` provides the tick loop. `CyrusAgent` extends it, calling `controlTask()` each tick to drain the action queue through `ExecutorOrchestrator`. The orchestrator maps action types to executor instances:

- `SwapExecutor` — same-chain and cross-chain swaps/bridges
- `ComposerExecutor` — atomic DeFi operations (vault deposits, staking, lending) via LI.FI Composer
- `ExecutorOrchestrator` — registry-based dispatcher, routes actions by type

Each executor follows a 5-step pipeline: **Quote → Pre-flight → Approval → Execute → Store**.

### Action System

A priority queue holds `ExecutorAction` objects (discriminated union: `swap | bridge | composer | rebalance`). Higher priority executes first, FIFO within the same priority. Each action carries a `strategyId`, `metadata`, and `priority` (0-10).

### State Management

Singleton `Store` using the EventEmitter pattern with typed slices:

- **Balances** — `Map<chainId-tokenAddr, BalanceEntry>` with USD values. `getAvailableBalance()` deducts in-flight amounts to prevent double-spending.
- **In-Flight Transfers** — `Map<transferId, InFlightTransfer>`. Mutable during status polling. Dual ID: local UUID + blockchain tx hash.
- **Completed Transfers** — Immutable historical record.
- **Positions** — Entry/current price, PnL tracking per strategy.
- **Prices** — TTL-cached token prices.

Events emitted: `balance.updated`, `transfer.created`, `transfer.updated`, `transfer.completed`, `position.updated`, `price.updated`.

### Type Safety

Branded types prevent parameter mixups at call sites:

```typescript
type ChainId = Brand<number, 'ChainId'>;
type TokenAddress = Brand<string, 'TokenAddress'>;
type TransferId = Brand<string, 'TransferId'>;
```

Token amounts are always `bigint` — never `number` (precision loss above 2^53).

## LI.FI Integration

Implements the **5-call recipe**: `GET /chains` → `GET /tokens` → `GET /quote` → execute tx → `GET /status` poll.

### Connector Layer

`LiFiConnector` wraps all LI.FI API calls with TTL caching:

| Data | Cache TTL | Endpoint |
|---|---|---|
| Chains | 1 hour | `GET /chains` |
| Tokens | 1 hour | `GET /tokens` |
| Connections | 15 min | `GET /connections` |
| Tools | 1 hour | `GET /tools` |
| Status | none | `GET /status` |
| Quote | none | `GET /quote` |

### HTTP Client

Wraps native `fetch` with retry logic and error classification:

- **429 (rate limit)** — retry with exponential backoff, 3 attempts, 5s base delay
- **5xx (server)** — retry, 3 attempts, 2s base delay
- **4xx (client)** — no retry
- API key injected via `x-lifi-api-key` header
- Integrator set to `cyrus-agent` on all calls

### Status Polling

Adaptive tiered backoff for cross-chain transfer tracking:

| Attempts | Delay |
|---|---|
| 1-6 | 10s |
| 7-12 | 30s |
| 13-24 | 60s |
| 25+ | 120s |

Max duration: 30 minutes. Supports `AbortSignal` for external cancellation.

Terminal statuses: `DONE` (substatus: `COMPLETED | PARTIAL | REFUNDED`) and `FAILED`. `NOT_FOUND` and `PENDING` continue polling.

### Transfer Tracking

`TransferTracker` manages concurrent polls (max 20). `TerminalStatusHandler` routes completed transfers:

- `DONE + COMPLETED` — full fill, update destination balance
- `DONE + PARTIAL` — different token received, enqueue recovery swap
- `DONE + REFUNDED` — tokens returned to source
- `FAILED` — permanent failure

### Composer

When `toToken` is a vault/protocol token address, LI.FI Composer auto-activates — handling swap + bridge + deposit in a single atomic transaction. Supported protocols: Aave V3, Morpho, Euler, Pendle, Lido, EtherFi, Ethena. A vault token registry maps known addresses to protocol metadata.

## Executor Pipeline

### Token Approvals

`ApprovalHandler` manages ERC20 approvals:

- Skips native tokens (`0x0000...0000`)
- Checks current allowance via `readContract`
- Approves exact amounts (never `maxUint256`)
- Handles USDT zero-reset pattern (reset to 0 before setting new allowance)
- Waits for approval receipt before proceeding

### Transaction Execution

`TransactionExecutor` submits and confirms transactions:

- Verifies wallet chain matches target chain, auto-switches if needed
- Validates against zero addresses
- Parses gas limit/price from quote data
- Submits via `walletClient.sendTransaction()`, waits for receipt

### Pre-Flight Checks

Validates quote viability before execution:

- Gas cost in USD vs ceiling (default $50)
- Effective slippage vs threshold (default 0.5%)
- Estimated bridge duration vs max timeout (optional)

Returns `{ passed: boolean, failures: string[] }`.

## Configuration

Hierarchical resolution: CLI args > env vars > config file > defaults. Validated with Zod.

```
cyrus.config.json:
  mode: live | dry-run | backtest
  tickIntervalMs, logLevel, integrator
  risk: { defaultSlippage, maxGasCostUsd, maxPositionSizeUsd, maxConcurrentTransfers, drawdownThreshold }
  chains: { enabled: number[], rpcUrls }
  strategies: { enabled: string[], directory }
  composer: { enabled, supportedProtocols, defaultSlippage }
  ws: { port, enabled }
  rest: { port, enabled, corsOrigin }
  dbPath

env vars (secrets only):
  CYRUS_PRIVATE_KEY, LIFI_API_KEY, ANTHROPIC_API_KEY
```

### Execution Modes

| Behavior | live | dry-run | backtest |
|---|---|---|---|
| On-chain writes | Yes | Never | Never |
| Price source | LI.FI API | LI.FI API | Historical loader |
| Balances | On-chain reads | Virtual portfolio | Simulated |
| Approvals | Real | Read-only check | Skipped |
| State persistence | SQLite | SQLite | In-memory |

Strategies are mode-unaware — they receive the same `StrategyContext` regardless of mode. Mode differences are handled by executor and data layers via dependency injection.

## Persistence

SQLite with WAL mode and auto-migration. Tables: `in_flight_transfers`, `completed_transfers`, `activity_log` (90-day retention), `_migrations`.

Listens to Store events (`transfer.created`, `transfer.updated`, `transfer.completed`) for auto-persistence. On boot, restores non-terminal transfers for crash recovery.

## Observability

### REST API

- `GET /api/health` — liveness
- `GET /api/portfolio` — balances, positions, P&L
- `GET /api/activity` — transfer/trade history
- `GET /api/strategies` — enabled strategies
- `GET /api/config` — config (secrets redacted)

### WebSocket

Real-time event stream over WS with 30s heartbeat:

`state.balance.updated`, `state.transfer.created`, `state.transfer.updated`, `state.transfer.completed`, `state.position.updated`, `state.price.updated`

### Logging

Pino-based structured logging. Dev mode: pretty-printed. Production: JSON. Auto-redacts private keys (`/0x[a-fA-F0-9]{64}/`), API keys (`/sk-[a-zA-Z0-9-_]{20,}/`), and explicit secret paths.

## Error Handling

Domain-specific error classes with context:

```
CyrusError
├── LiFiQuoteError
├── BridgeTimeoutError
├── InsufficientBalanceError
├── ConfigValidationError
├── ApprovalError
├── TransactionExecutionError
└── RateLimitError
```

Retry utility: exponential backoff (`2^attempt * baseDelay`, capped at 30s), max 3 retries. Only retries transient errors (rate limit, server). Client errors (400, bad input) fail immediately.

## Supported Chains

Ethereum (1), Arbitrum (42161), Optimism (10), Polygon (137), Base (8453), BSC (56), Solana (1151111081099710).

## Scripts

```sh
npm run dev      # tsx watch mode
npm run build    # tsc compile
npm start        # run compiled output
npm test         # vitest run
npm run lint     # tsc --noEmit
```

## Tests

32 test files covering config validation, branded types, action queue, store events, HTTP client retry/error classification, status parsing/polling, executor orchestration, pre-flight checks, approval handling, transaction execution, persistence, REST/WS servers, and transfer tracking. Run with `npm test`.

## License

ISC
