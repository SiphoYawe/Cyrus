# Cyrus Agent Configuration

## Primary Agent: Cyrus

- **Role:** Autonomous cross-chain DeFi agent
- **Platform:** LI.FI protocol integration
- **Mode:** Requires user approval for all fund-moving operations

## Agent Capabilities

| Capability | Tool | Description |
|------------|------|-------------|
| Portfolio View | `portfolio` | Balances, chain allocation, in-flight transfers |
| Position Tracking | `positions` | Open positions, P&L, stat-arb pairs |
| Strategy Status | `strategies` | Enabled strategies, performance metrics |
| Token Swap | `swap` | Same-chain DEX swap via LI.FI |
| Cross-Chain Bridge | `bridge` | Bridge tokens between chains via LI.FI |
| Yield Discovery | `yield` | Find yield opportunities across protocols |
| Risk Control | `risk-dial` | View/adjust risk level (1-10 scale) |
| Health Check | `heartbeat` | Agent status, uptime, active operations |
| Activity Reports | `report` | Decision history, trade outcomes |
| Trade Preview | `trade-preview` | Detailed cost estimate for any trade |
| Trade Approval | `trade-approve` | Approve or deny pending trade actions |

## Approval Flow

1. User requests an action (swap, bridge, deposit)
2. Cyrus generates a preview with cost estimates
3. User reviews and approves/denies via `trade-approve`
4. On approval, action enters the execution queue
5. User receives status updates as the action progresses
