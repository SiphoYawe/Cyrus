# Heartbeat Configuration

## Schedule

- **Interval:** Every 60 seconds (configurable)
- **Morning briefing:** Daily at 08:00 UTC
- **Health check:** Every 4 hours

## Monitored Metrics

| Metric | Description | Alert Threshold |
|--------|-------------|----------------|
| `agentRunning` | Agent process alive | Alert if false |
| `uptime` | Process uptime in seconds | Alert if < 60s (restart detected) |
| `tickCount` | OODA loop iterations | Alert if stalled (no increase in 5 min) |
| `activeTransfers` | In-flight cross-chain transfers | Alert if > 10 |
| `openPositions` | Active trading positions | Info only |
| `totalPortfolioUsd` | Total portfolio value in USD | Alert if drops > 15% |
| `lastDecisionAt` | Timestamp of last decision | Alert if > 1 hour stale |

## Heartbeat Message Format

```
Agent: running | Uptime: 2h 15m | Ticks: 450 | Portfolio: $15,234.00 | Transfers: 2 | Positions: 5
```

## Alert Escalation

1. **Info** — Normal operational status
2. **Warning** — Metric near threshold (e.g., portfolio down 10%)
3. **Critical** — Agent stopped, transfers stuck, circuit breaker activated
