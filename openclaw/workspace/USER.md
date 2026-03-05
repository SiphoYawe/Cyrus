# User Interaction Guide

## Getting Started

1. **Check status:** "How's the agent doing?" or "Agent status"
2. **View portfolio:** "Show my portfolio" or "What's my balance?"
3. **See strategies:** "What strategies are running?"
4. **Find yields:** "Show yield opportunities"

## Common Commands

### Portfolio & Monitoring
- "Show my portfolio"
- "What's my balance on Arbitrum?"
- "Show my positions"
- "Agent status"
- "Show recent decisions"

### Trading Actions
- "Swap 100 USDC to ETH"
- "Bridge 1000 USDC from Ethereum to Arbitrum"
- "Preview a swap of 500 USDC to WETH on Base"

### Risk Management
- "What's my risk level?"
- "Set risk to 3" (conservative)
- "Set risk to 8" (aggressive)

### Yield Discovery
- "Show yield opportunities for USDC"
- "Find ETH yields above 5%"
- "Low risk yield options"

## Approval Workflow

All fund-moving actions require your explicit approval:

1. Request an action (e.g., "Swap 100 USDC to ETH")
2. Review the preview (costs, estimated output, route)
3. Approve: "Approve action {id}" or Deny: "Deny action {id}"

## Supported Chains

| Chain | ID | How to Reference |
|-------|-----|-----------------|
| Ethereum | 1 | "ethereum", "eth", chain 1 |
| Arbitrum | 42161 | "arbitrum", "arb", chain 42161 |
| Optimism | 10 | "optimism", "op", chain 10 |
| Polygon | 137 | "polygon", "matic", chain 137 |
| Base | 8453 | "base", chain 8453 |
| BSC | 56 | "bsc", "bnb chain", chain 56 |
