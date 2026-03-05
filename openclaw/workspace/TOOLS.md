# Cyrus Agent Tools Reference

## Information Tools

### portfolio
Get current portfolio overview including balances, total value, and chain allocation.

**Parameters:**
- `chain` (number, optional) — Filter by chain ID

**Example:** "Show my portfolio" / "What's my balance on Arbitrum?"

---

### positions
Get all open positions with P&L information.

**Parameters:**
- `strategy` (string, optional) — Filter by strategy name

**Example:** "Show my positions" / "How is yield-hunter doing?"

---

### strategies
Get enabled strategies, their performance metrics, and current status.

**Parameters:**
- `name` (string, optional) — Filter by strategy name

**Example:** "What strategies are running?" / "Show yield strategy performance"

---

## Action Tools

### swap
Preview a same-chain token swap. Returns a preview for approval.

**Parameters:**
- `fromToken` (string, required) — Source token symbol
- `toToken` (string, required) — Destination token symbol
- `amount` (string, required) — Amount in human-readable units
- `chainId` (number, optional) — Chain ID (default: 1)
- `slippage` (number, optional) — Slippage tolerance (default: 0.005)

**Example:** "Swap 100 USDC to ETH" / "Swap 500 USDC to WETH on Arbitrum"

---

### bridge
Preview a cross-chain bridge transfer. Returns a preview for approval.

**Parameters:**
- `fromChain` (number, required) — Source chain ID
- `toChain` (number, required) — Destination chain ID
- `token` (string, required) — Token symbol
- `amount` (string, required) — Amount in human-readable units
- `slippage` (number, optional) — Slippage tolerance (default: 0.005)

**Example:** "Bridge 1000 USDC from Ethereum to Arbitrum"

---

### yield
List yield opportunities across chains and protocols.

**Parameters:**
- `token` (string, optional) — Filter by token symbol
- `chain` (number, optional) — Filter by chain ID
- `minApy` (number, optional) — Minimum APY filter
- `risk` (string, optional) — Risk level: low, medium, high

**Example:** "Show yield opportunities for USDC" / "Find yields above 5%"

---

## Management Tools

### risk-dial
View or adjust the risk dial level (1-10).

**Parameters:**
- `level` (number, optional) — New level (1-10). Omit to view current.

**Example:** "What's my risk level?" / "Set risk to 7"

---

### heartbeat
Check agent health status, uptime, and portfolio value.

**Example:** "How's the agent doing?" / "Agent status"

---

### report
Get recent decision reports and activity summaries.

**Parameters:**
- `strategy` (string, optional) — Filter by strategy
- `limit` (number, optional) — Number of reports (default: 10)
- `outcome` (string, optional) — Filter: positive, negative, neutral, pending, failed

**Example:** "Show recent decisions" / "Last 5 trades"

---

## Approval Tools

### trade-preview
Generate a detailed trade preview with cost estimates.

**Parameters:**
- `action` (string, required) — swap, bridge, or deposit
- `fromChain` (number, required) — Source chain ID
- `toChain` (number, required) — Destination chain ID
- `fromToken` (string, required) — Source token
- `toToken` (string, required) — Destination token
- `amount` (string, required) — Amount
- `slippage` (number, optional) — Slippage tolerance

---

### trade-approve
Approve or deny a pending trade action.

**Parameters:**
- `actionId` (string, required) — Action ID from preview
- `decision` (string, required) — "approve" or "deny"
