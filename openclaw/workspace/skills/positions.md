# Positions Skill

## Trigger Phrases
- "show my positions"
- "open positions"
- "how are my trades"
- "position P&L"
- "stat arb positions"

## Workflow

1. Call `positions` tool (optionally with strategy filter)
2. Show total combined P&L
3. List positions grouped by strategy
4. Highlight positions with significant P&L (>5% or <-5%)
5. Include stat arb pair positions separately

## Response Template

**Open Positions: X | Total P&L: $X.XX**

| Strategy | Token | Entry | Current | P&L |
|----------|-------|-------|---------|-----|
| yield-hunter | USDC | $1.00 | $1.00 | +$5.00 |

Stat Arb Pairs: X active
