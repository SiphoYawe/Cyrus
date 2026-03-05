# Status Skill

## Trigger Phrases
- "agent status"
- "how's the agent"
- "is cyrus running"
- "health check"
- "system status"

## Workflow

1. Call `heartbeat` tool
2. Show agent running state prominently
3. Display key metrics (uptime, ticks, portfolio)
4. Flag any warnings (stalled agent, high transfer count)
5. Show last decision timestamp if available

## Response Template

**Agent Status: Running**

- Uptime: Xh Xm
- OODA Ticks: XXX
- Portfolio: $X,XXX.XX
- Active Transfers: X
- Open Positions: X
- Last Decision: X minutes ago
