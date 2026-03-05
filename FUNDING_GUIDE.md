# Cyrus Agent — MVP Funding & Testing Guide

## Wallet Addresses

| Network | Address |
|---------|---------|
| **EVM (all chains)** | `0xBcD9b700087715BA89289F3BA0A3d5766b7fC24f` |
| **Solana** | `DUEV72TLwDEzi2YLgm3nw5hLFPM6wX6LgMpYyxx98QGy` |

---

## API Credits

| Service | Status | Action | Cost |
|---------|--------|--------|------|
| LI.FI API | Key configured | None needed — free tier with key | $0 |
| Alchemy RPC | Key configured | None needed — free tier (300M CU/month) | $0 |
| **Anthropic Claude** | Key configured | **Buy $5 credits** | **$5** |
| Sentry | DSN configured | None needed — free tier (5K errors/month) | $0 |
| Telegram API | Session active | None needed — free | $0 |
| WalletConnect | Project ID set | None needed — free | $0 |

### Anthropic Credits

The agent uses Claude Sonnet 4 for:
- Regime classification (256 max tokens per call)
- Decision reports (512 max tokens per call)
- NL command processing (1024 max tokens per call)
- MCP tool orchestration (2048 max tokens per call)

$5 covers ~300 AI calls — more than enough for full MVP testing.

**Purchase at:** https://console.anthropic.com/settings/billing

---

## Wallet Funding — Full Feature Coverage

### What to Send

| # | Asset | Destination Chain | Amount | USD Value | Purpose |
|---|-------|-------------------|--------|-----------|---------|
| 1 | ETH | **Arbitrum** (42161) | 0.005 ETH | ~$13 | Gas for L2 txs (~200+ operations) |
| 2 | USDC | **Arbitrum** (42161) | 200 USDC | $200 | Main capital pool — swaps, bridges, HL margin, yield |
| 3 | ETH | **Base** (8453) | 0.002 ETH | ~$5 | Gas on Base (~100+ operations) |
| 4 | USDC | **Base** (8453) | 50 USDC | $50 | Meme trading + cross-chain arb destination |
| 5 | SOL | **Solana** | 0.05 SOL | ~$3 | Gas for Solana transactions |
| 6 | USDC | **Solana** | 20 USDC | $20 | Cross-chain Solana proof |

### Total Cost

| Category | Cost |
|----------|------|
| Wallet funding (items 1-6) | **$291** |
| Anthropic API credits | **$5** |
| **Grand Total** | **~$296** |

---

## How the $200 Arbitrum USDC Gets Used

The agent autonomously allocates from this pool:

```
$200 USDC on Arbitrum
  |
  +-- ~$100 --> Bridge to Hyperliquid margin
  |              +-- Perps trading ($34 margin for 100 USDC @ 3x)
  |              +-- Pair trading ($67 margin for 2x100 USDC @ 3x)
  |              +-- Stat arb ($28 margin for $500 @ 18x)
  |              +-- Market making ($50 order book, 3 levels)
  |
  +-- ~$50 ---> Cross-chain bridges to Base/Optimism
  |              +-- Bridge executor demo
  |              +-- Cross-chain arb opportunities
  |
  +-- ~$50 ---> Yield farming via Composer
                 +-- Aave V3 deposit
                 +-- Morpho vault
                 +-- Lido/EtherFi staking
```

---

## Feature-by-Feature Test Plan

### 1. Cross-Chain Swaps & Bridges (SwapExecutor + BridgeExecutor)

**Capital needed:** $30 USDC on Arbitrum + gas
**What happens:** Agent bridges USDC from Arbitrum to Base via LI.FI
**Proves:** 5-call recipe (quote -> approve -> execute -> poll status -> complete), cross-chain transfer tracking, status polling with backoff

**Test:**
```
1. Agent detects USDC on Arbitrum
2. CrossChainArb strategy finds opportunity on Base
3. Gets LI.FI quote for Arbitrum -> Base bridge
4. Handles ERC20 approval (estimate.approvalAddress)
5. Submits transaction
6. Polls GET /status until DONE+COMPLETED
7. Updates balance on destination chain
```

### 2. Yield Farming (ComposerExecutor + YieldHunter Strategy)

**Capital needed:** $50 USDC on Arbitrum + gas
**What happens:** Agent deposits USDC into Aave V3 or Morpho via LI.FI Composer
**Proves:** Composer auto-activation (toToken = vault token address), DeFi protocol integration, APY comparison logic

**Test:**
```
1. YieldHunter detects idle USDC on Arbitrum
2. Compares APYs across protocols (Aave, Morpho, etc.)
3. Picks highest APY vault
4. Composer builds atomic swap+deposit tx
5. Executes and tracks until complete
```

### 3. Hyperliquid Perpetuals (PerpExecutor + HyperliquidPerps Strategy)

**Capital needed:** $100 USDC position / 3x leverage = $34 margin minimum
**What happens:** Agent opens a leveraged perp position on Hyperliquid
**Proves:** Hyperliquid connector, margin management, funding rate tracking, triple barrier (SL/TP/time)

**Test:**
```
1. FundingBridgeExecutor bridges USDC from Arbitrum to Hyperliquid
2. HyperliquidPerps strategy detects funding rate opportunity
3. Opens market order via HyperliquidConnector
4. PerpExecutor manages position (tracks P&L, funding)
5. Exits on stoploss (-5%), take profit, or time limit
```

**Executor checks:**
- Leverage validation: 1x min, 50x max (strategy defaults to 3x)
- Margin check: `balance.withdrawable >= size / leverage`
- Funding rate warning if > 1%

### 4. Pair Trading (PairExecutor + PearPairTrader Strategy)

**Capital needed:** 2 legs x $100 / 3x leverage = $67 margin minimum
**What happens:** Agent opens simultaneous long/short on correlated pairs (e.g., ETH-BTC)
**Proves:** Dual-leg execution, atomic open/close, spread z-score entry/exit, combined P&L tracking

**Test:**
```
1. PearPairTrader monitors spread z-score for ETH-BTC
2. When |z-score| >= 2.0, opens long ETH + short BTC
3. PairExecutor validates: leverage (1-10x), margin, z-score significance (>= 1.5)
4. Manages combined P&L (NEVER individual-leg barriers)
5. Closes BOTH legs simultaneously on mean reversion (z < 0.5)
```

**Critical rules:**
- Both legs MUST open and close simultaneously
- NO partial closes ever
- Max 5 open pair positions

### 5. Statistical Arbitrage (StatArbPairExecutor + StatArbStrategy)

**Capital needed:** 5% of portfolio at 18x leverage = ~$28 margin (for $500 portfolio)
**What happens:** Agent runs beta-neutral pair trades on Hyperliquid based on z-score signals
**Proves:** Signal pipeline (HourlyPriceFeed -> UniverseScanner -> SignalGenerator), beta-neutral sizing, funding tracking

**Test:**
```
1. SignalGenerator scans universe of pairs every hour
2. Detects z-score divergence on a pair
3. StatArbStrategy builds beta-neutral position sizes
4. StatArbPairExecutor opens dual-leg trade with rollback on failure
5. Manages position: funding tracking, combined P&L
6. Exits on mean reversion (z <= 0.5), stoploss (-30%), or time stop (3x half-life)
```

**Executor checks:**
- Max leverage: 23x
- Max positions: 10
- Second-leg failure triggers rollback of first leg

### 6. Meme Trading (SwapExecutor + MemeTrader Strategy)

**Capital needed:** $50 USDC on Base + gas
**What happens:** Agent detects meme coin opportunities via multi-signal scoring and swaps in
**Proves:** Social sentinel data, multi-signal weighting (volume, whale, liquidity, social, age), time-limited positions

**Test:**
```
1. SocialSentinel + OnChainIndexer detect meme coin activity
2. MemeTrader scores opportunity (must exceed 60/100 threshold)
3. Calculates position size (2% of portfolio, max $50 fallback)
4. Swaps USDC -> meme token on Base via LI.FI
5. Manages with tight stoploss (-15%), take profit (30%), trailing stop (15%)
6. Hard time limit: 4 hours per position
7. Cooldown: 1 hour before re-entering same token
```

**Settings:**
- Slippage: 2% (high for illiquid tokens)
- Max positions: 5

### 7. Market Making (MarketMakerExecutor + MarketMaker Strategy)

**Capital needed:** 3 levels x $50 = $150 order book on Hyperliquid
**What happens:** Agent places multi-level bid/ask orders around mid price
**Proves:** Order management, stale order detection, inventory skew adjustment, fill tracking

**Test:**
```
1. MarketMaker strategy evaluates market conditions
2. Places 3-level bid/ask grid (0.1% spread per level)
3. MarketMakerExecutor manages orders:
   - Detects stale orders (> 60s without update)
   - Adjusts for inventory skew (rebalance at 85% threshold)
   - Tracks P&L from bid/ask fills
4. Cancels all orders on exit
```

**Config:** minCapitalUsd = $1000 in code, but executor accepts any amount passed by strategy

### 8. Solana Cross-Chain (BridgeExecutor)

**Capital needed:** 20 USDC on Solana + 0.05 SOL gas
**What happens:** Agent bridges USDC from Solana to an EVM chain via LI.FI
**Proves:** Multi-VM support, Solana wallet integration, cross-VM bridge tracking

**Test:**
```
1. Agent detects USDC on Solana
2. CrossChainArb finds better yield/price on Arbitrum
3. Gets LI.FI quote for Solana -> Arbitrum bridge
4. Signs with Solana keypair (Ed25519)
5. Polls status until complete
```

---

## Config Changes Before Going Live

### 1. Enable all chains you funded

Edit `cyrus.config.json`:
```json
{
  "chains": {
    "enabled": [42161, 8453, 1151111081099710]
  }
}
```

(Arbitrum, Base, Solana — skip Ethereum L1/Optimism/Polygon/BSC to save gas)

### 2. Enable all strategies

```json
{
  "strategies": {
    "enabled": [
      "YieldHunter",
      "LiquidStaking",
      "CrossChainArb",
      "HyperliquidPerps",
      "StatArbStrategy",
      "PearPairTrader",
      "MemeTrader",
      "MarketMaker"
    ]
  }
}
```

### 3. Tighten risk limits for small portfolio

```json
{
  "risk": {
    "defaultSlippage": 0.005,
    "maxGasCostUsd": 10,
    "maxPositionSizeUsd": 100,
    "maxConcurrentTransfers": 5,
    "drawdownThreshold": 0.10
  }
}
```

### 4. Switch to live mode

In `cyrus.config.json`:
```json
{ "mode": "live" }
```

In `.env`:
```
CYRUS_MODE=live
```

### 5. Rebuild and start

```bash
npm run build
node dist/index.js
```

---

## Funding Order (Step by Step)

### Step 1: Buy Anthropic Credits ($5)
1. Go to https://console.anthropic.com/settings/billing
2. Add $5 to your account

### Step 2: Fund Arbitrum ($213)
1. Send **0.005 ETH** to `0xBcD9b700087715BA89289F3BA0A3d5766b7fC24f` on **Arbitrum**
2. Send **200 USDC** to the same address on **Arbitrum**

Cheapest method: Withdraw directly from exchange (Coinbase, Binance) to Arbitrum network. Most exchanges support Arbitrum withdrawals with $0-1 fee.

### Step 3: Fund Base ($55)
1. Send **0.002 ETH** to `0xBcD9b700087715BA89289F3BA0A3d5766b7fC24f` on **Base**
2. Send **50 USDC** to the same address on **Base**

Cheapest method: Withdraw from exchange to Base network, or bridge from Arbitrum.

### Step 4: Fund Solana ($23)
1. Send **0.05 SOL** to `DUEV72TLwDEzi2YLgm3nw5hLFPM6wX6LgMpYyxx98QGy`
2. Send **20 USDC** to the same Solana address

Cheapest method: Withdraw from exchange directly to Solana.

### Step 5: Update Config
1. Edit `cyrus.config.json` with the settings above (chains, strategies, risk, mode)
2. `npm run build`
3. `node dist/index.js`

---

## Verification Checklist

After funding, verify balances before going live:

```bash
# Check EVM balances (Arbitrum)
cast balance 0xBcD9b700087715BA89289F3BA0A3d5766b7fC24f --rpc-url https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY

# Check USDC balance on Arbitrum (USDC contract: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831)
cast call 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
  "balanceOf(address)(uint256)" \
  0xBcD9b700087715BA89289F3BA0A3d5766b7fC24f \
  --rpc-url https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY

# Or just check on block explorers:
# Arbitrum: https://arbiscan.io/address/0xBcD9b700087715BA89289F3BA0A3d5766b7fC24f
# Base: https://basescan.org/address/0xBcD9b700087715BA89289F3BA0A3d5766b7fC24f
# Solana: https://solscan.io/account/DUEV72TLwDEzi2YLgm3nw5hLFPM6wX6LgMpYyxx98QGy
```

---

## Risk Warnings

- **This is real money on mainnet.** Bugs can lose funds permanently.
- **Start with dry-run mode** first to verify strategies produce sensible signals.
- **Monitor the dashboard** during live testing at https://cyrus-one.vercel.app
- **Circuit breaker**: Agent stops trading if drawdown exceeds 10% (with tightened config above).
- **Max single loss**: With $100 max position and -15% stoploss = $15 worst case per trade.
- **Bridge delays**: Cross-chain transfers can take 1-30 minutes. Don't panic if funds appear "missing" temporarily.

---

## Summary

| Item | Cost |
|------|------|
| ETH gas (Arbitrum + Base) | $18 |
| USDC trading capital (Arbitrum) | $200 |
| USDC trading capital (Base) | $50 |
| SOL gas (Solana) | $3 |
| USDC trading capital (Solana) | $20 |
| Anthropic API credits | $5 |
| **Total to test ALL features** | **~$296** |
