# CYRUS Deployment Guide

Complete guide to get CYRUS running in production with all services, keys, and infrastructure.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [API Keys & Credentials Checklist](#2-api-keys--credentials-checklist)
3. [Wallet Setup](#3-wallet-setup)
4. [Agent Backend Deployment](#4-agent-backend-deployment)
5. [Dashboard Deployment (Vercel)](#5-dashboard-deployment-vercel)
6. [Configuration Reference](#6-configuration-reference)
7. [Deployment Options for Agent Backend](#7-deployment-options-for-agent-backend)
8. [Post-Deployment Verification](#8-post-deployment-verification)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Architecture Overview

CYRUS has **two deployable components**:

```
┌─────────────────────┐     WebSocket (:8080)     ┌─────────────────────────┐
│   CYRUS Agent       │◄─────────────────────────►│   Dashboard (Next.js)    │
│   (Node.js)         │     REST API (:3001)       │   (Vercel - DONE)        │
│                     │◄─────────────────────────►│                           │
│   - OODA loop       │                            │   - Portfolio view        │
│   - Strategy engine  │                            │   - Activity feed         │
│   - LI.FI connector │                            │   - Strategy management   │
│   - Risk management  │                            │   - Chat / NL commands    │
│   - SQLite DB       │                            │   - Settings              │
└────────┬────────────┘                            └───────────────────────────┘
         │
         │ Connects to:
         ├── LI.FI API (https://li.quest/v1)
         ├── Anthropic Claude API
         ├── EVM RPCs (Ethereum, Arbitrum, Base, etc.)
         ├── Solana RPC (optional)
         ├── Hyperliquid API (optional)
         ├── Pear Protocol API (optional)
         ├── CoinGecko / DefiLlama (price data)
         └── Telegram MTProto (optional)
```

**Dashboard (Vercel):** Already deployed. Serves the frontend.
**Agent Backend:** Needs a **persistent server** — NOT serverless. The agent runs a continuous OODA loop (tick every 30s), maintains WebSocket connections, and manages a SQLite database.

---

## 2. API Keys & Credentials Checklist

### REQUIRED (Agent won't function without these)

| Credential | Where to Get It | Cost | Notes |
|---|---|---|---|
| **EVM Private Key** | Generate a new wallet | Free | **NEVER use your main wallet.** Create a dedicated agent wallet. |
| **Anthropic API Key** | [console.anthropic.com](https://console.anthropic.com/) | Pay-per-use (~$3/MTok input, $15/MTok output for Sonnet) | Required for AI decision-making, market regime detection, NL commands |

### STRONGLY RECOMMENDED

| Credential | Where to Get It | Cost | Notes |
|---|---|---|---|
| **LI.FI API Key** | [jumper.exchange/developers](https://jumper.exchange/developers/) or email partners@li.fi | Free | Without it, you hit lower rate limits. With it, higher throughput. Set `integrator` name too. |
| **WalletConnect Project ID** | [cloud.walletconnect.com](https://cloud.walletconnect.com/) | Free tier available | Required for dashboard wallet connection (RainbowKit). Sign up → Create Project → Copy Project ID |

### OPTIONAL (Enable specific features)

| Credential | Where to Get It | Cost | Notes |
|---|---|---|---|
| **Solana Private Key** | Generate with `solana-keygen` | Free | Only if you want Solana chain support |
| **Telegram Session String** | Run `npm run telegram-auth` in cyrus/ | Free | Only for Pear Protocol signal consumption from @agentpear channel |
| **Custom RPC URLs** | Alchemy, Infura, QuickNode, etc. | Free tiers available | Public RPCs work but are slower/rate-limited. Recommended for production. |

### How to Get Each Key

#### 1. EVM Private Key (REQUIRED)

**Option A: Generate with Node.js**
```bash
node -e "const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts'); const key = generatePrivateKey(); console.log('Private Key:', key); console.log('Address:', privateKeyToAccount(key).address);"
```

**Option B: Create in MetaMask**
1. Open MetaMask → Create new account
2. Account details → Export private key
3. Copy the `0x...` prefixed key

**IMPORTANT:**
- Use a **dedicated wallet** for the agent. Never your personal wallet.
- Fund it with ETH/USDC on the chains you want to operate on.
- For `dry-run` mode, the private key is still needed for address derivation but no real transactions are sent.

#### 2. Anthropic API Key (REQUIRED)

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Sign up / Log in
3. Go to **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-...`)
5. Add billing (pay-as-you-go). For testing, $10 credit is plenty.

#### 3. LI.FI API Key (RECOMMENDED)

1. Go to [jumper.exchange/developers](https://jumper.exchange/developers/)
2. Or email partners@li.fi requesting an API key
3. Mention you're building an autonomous agent for the Vibeathon
4. You'll receive an API key string
5. Without this key, you're on default rate limits (works, but slower)

#### 4. WalletConnect Project ID (REQUIRED for Dashboard)

1. Go to [cloud.walletconnect.com](https://cloud.walletconnect.com/)
2. Sign up (free)
3. Click **Create Project**
4. Name: "Cyrus Dashboard" → Platform: Web
5. Copy the **Project ID**

#### 5. Custom RPC URLs (RECOMMENDED for Production)

Free tiers that work well:

| Provider | URL | Free Tier |
|---|---|---|
| **Alchemy** | [alchemy.com](https://www.alchemy.com/) | 300M compute units/month |
| **Infura** | [infura.io](https://www.infura.io/) | 100K requests/day |
| **QuickNode** | [quicknode.com](https://www.quicknode.com/) | 10M credits/month |
| **Ankr** | [ankr.com](https://www.ankr.com/) | Free public RPCs |
| **Blast** | [blastapi.io](https://blastapi.io/) | 40 req/sec free |

Add them to `cyrus.config.json`:
```json
{
  "chains": {
    "enabled": [1, 42161, 10, 137, 8453, 56],
    "rpcUrls": {
      "1": "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
      "42161": "https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY",
      "10": "https://opt-mainnet.g.alchemy.com/v2/YOUR_KEY",
      "137": "https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY",
      "8453": "https://base-mainnet.g.alchemy.com/v2/YOUR_KEY",
      "56": "https://bsc-dataseed.binance.org"
    }
  }
}
```

---

## 3. Wallet Setup

### Fund the Agent Wallet

Before switching to `live` mode, the agent wallet needs funds on the chains you want to operate on.

**Minimum recommended for testing:**

| Chain | Token | Amount | Purpose |
|---|---|---|---|
| Arbitrum (42161) | ETH | 0.01 ETH (~$25) | Gas for transactions |
| Arbitrum (42161) | USDC | $50-100 | Trading capital |
| Base (8453) | ETH | 0.005 ETH (~$12) | Gas |
| Base (8453) | USDC | $50-100 | Trading capital |

**For full multi-chain operation:**

| Chain | Gas Token | Recommended Gas | Trading Capital |
|---|---|---|---|
| Ethereum (1) | ETH | 0.02 ETH | $100+ USDC |
| Arbitrum (42161) | ETH | 0.01 ETH | $100+ USDC |
| Optimism (10) | ETH | 0.005 ETH | $100+ USDC |
| Polygon (137) | MATIC | 5 MATIC | $100+ USDC |
| Base (8453) | ETH | 0.005 ETH | $100+ USDC |
| BSC (56) | BNB | 0.02 BNB | $100+ USDC |

**Tips:**
- Start with `dry-run` mode (no real transactions) to verify everything works
- Use bridge aggregators like [jumper.exchange](https://jumper.exchange) to move funds cheaply
- The agent's onboarding wizard includes a QR code for funding

---

## 4. Agent Backend Deployment

### Step 1: Create Environment Files

```bash
cd cyrus/

# Copy example files
cp .env.example .env
cp cyrus.config.example.json cyrus.config.json
```

### Step 2: Fill in `.env`

```bash
# cyrus/.env
CYRUS_PRIVATE_KEY=0x_YOUR_PRIVATE_KEY_HERE
LIFI_API_KEY=your_lifi_api_key_here
ANTHROPIC_API_KEY=sk-ant-your_anthropic_key_here
```

### Step 3: Configure `cyrus.config.json`

Start with `dry-run` mode for testing:

```json
{
  "mode": "dry-run",
  "tickIntervalMs": 30000,
  "integrator": "cyrus-agent",
  "logLevel": "info",
  "risk": {
    "defaultSlippage": 0.005,
    "maxGasCostUsd": 50,
    "maxPositionSizeUsd": 10000,
    "maxConcurrentTransfers": 20,
    "drawdownThreshold": 0.15
  },
  "chains": {
    "enabled": [42161, 8453, 10],
    "rpcUrls": {}
  },
  "strategies": {
    "enabled": ["YieldHunter", "LiquidStaking", "CrossChainArb"],
    "directory": "strategies"
  },
  "composer": {
    "enabled": true,
    "supportedProtocols": ["aave-v3", "lido", "etherfi"],
    "defaultSlippage": 0.005
  },
  "ws": {
    "port": 8080,
    "enabled": true
  },
  "rest": {
    "port": 3001,
    "enabled": true,
    "corsOrigin": "https://your-vercel-dashboard.vercel.app"
  },
  "dbPath": "cyrus.db"
}
```

**Key changes for production:**
- Set `corsOrigin` to your actual Vercel dashboard URL (not `*`)
- Start with 2-3 chains to reduce complexity
- Enable only the strategies you want to run
- Keep `mode: "dry-run"` until fully verified

### Step 4: Install & Build

```bash
cd cyrus/
npm install
npm run build
```

### Step 5: Start the Agent

```bash
# Production
npm start

# Development (auto-reload)
npm run dev
```

The agent will:
1. Load config (CLI > env > file > defaults)
2. Initialize SQLite database and run migrations
3. Start REST API on port 3001
4. Start WebSocket server on port 8080
5. Begin the OODA loop (tick every 30s)

---

## 5. Dashboard Deployment (Vercel)

Already done. Just make sure these environment variables are set in Vercel:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_WS_URL` | `wss://your-agent-server.com:8080` (or `ws://` for non-TLS) |
| `NEXT_PUBLIC_API_URL` | `https://your-agent-server.com:3001` (or `http://`) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Your WalletConnect project ID |
| `SESSION_SECRET` | Generate: `openssl rand -hex 32` |

**CRITICAL:** The `WS_URL` and `API_URL` must point to wherever you deploy the agent backend. If running locally, use `ws://localhost:8080` and `http://localhost:3001`.

---

## 6. Configuration Reference

### Environment Variables (`.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `CYRUS_PRIVATE_KEY` | Yes | — | EVM wallet private key (0x-prefixed) |
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic Claude API key |
| `LIFI_API_KEY` | No | — | LI.FI API key for higher rate limits |
| `CYRUS_MODE` | No | `dry-run` | `live`, `dry-run`, or `backtest` |
| `CYRUS_TICK_INTERVAL` | No | `30000` | Ms between OODA loop cycles |
| `CYRUS_LOG_LEVEL` | No | `info` | `trace/debug/info/warn/error/fatal` |
| `CYRUS_MAX_GAS_COST_USD` | No | `50` | Max gas per transaction in USD |
| `CYRUS_WS_PORT` | No | `8080` | WebSocket server port |
| `CYRUS_REST_PORT` | No | `3001` | REST API server port |
| `NODE_ENV` | No | — | Set `production` for prod |
| `SOLANA_PRIVATE_KEY` | No | — | Solana keypair (BS58-encoded) |
| `TELEGRAM_SESSION_STRING` | No | — | Telegram MTProto session |

### Dashboard Environment Variables (`.env.local`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEXT_PUBLIC_WS_URL` | Yes | `ws://localhost:8080` | Agent WebSocket URL |
| `NEXT_PUBLIC_API_URL` | Yes | `http://localhost:3001` | Agent REST API URL |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Yes | — | WalletConnect v2 project ID |
| `SESSION_SECRET` | Yes | — | HMAC secret for session cookies |

---

## 7. Deployment Options for Agent Backend

The agent backend is a **long-running Node.js process** (not serverless). Here are your options:

### Option A: Railway (Recommended - Easiest)

**Why:** One-click deploy, persistent processes, free $5/month trial, managed SSL.

1. Go to [railway.app](https://railway.app/)
2. Sign up (GitHub OAuth)
3. **New Project → Deploy from GitHub repo**
4. Select your `Cyrus` repo
5. Railway auto-detects Node.js
6. Set **Root Directory** to `/` (the cyrus folder)
7. Add environment variables in the Railway dashboard:
   ```
   CYRUS_PRIVATE_KEY=0x...
   LIFI_API_KEY=...
   ANTHROPIC_API_KEY=sk-ant-...
   NODE_ENV=production
   ```
8. Set **Start Command**: `npm run build && npm start`
9. Railway assigns a public URL — use this for dashboard `API_URL`
10. For WebSocket, you may need a separate service or use Railway's TCP proxy

**Estimated cost:** ~$5-10/month for always-on

### Option B: Render

**Why:** Free tier available (spins down after inactivity), easy setup.

1. Go to [render.com](https://render.com/)
2. **New → Web Service** → Connect GitHub repo
3. Set:
   - **Root Directory:** `./` (cyrus folder)
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Instance Type:** Starter ($7/month) or Free (spins down)
4. Add environment variables
5. Deploy

**Note:** Free tier sleeps after 15 min inactivity — not ideal for an always-on agent. Use Starter ($7/month) for persistent.

### Option C: Fly.io

**Why:** Global edge deployment, generous free tier, persistent volumes for SQLite.

1. Install `flyctl`: `brew install flyctl`
2. `cd cyrus && fly launch`
3. Create `Dockerfile`:
   ```dockerfile
   FROM node:22-slim
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --production
   COPY . .
   RUN npm run build
   EXPOSE 3001 8080
   CMD ["npm", "start"]
   ```
4. Create `fly.toml`:
   ```toml
   [build]

   [http_service]
     internal_port = 3001
     force_https = true

   [[services]]
     internal_port = 8080
     protocol = "tcp"
     [[services.ports]]
       port = 8080

   [mounts]
     source = "cyrus_data"
     destination = "/app/data"
   ```
5. Set config `dbPath` to `/app/data/cyrus.db` for persistent storage
6. `fly secrets set CYRUS_PRIVATE_KEY=0x... ANTHROPIC_API_KEY=sk-ant-...`
7. `fly deploy`

**Estimated cost:** Free tier covers small apps, ~$5/month for always-on

### Option D: VPS (DigitalOcean / Hetzner / Vultr)

**Why:** Full control, cheapest for always-on, SSH access.

1. Create a VPS ($5-6/month):
   - DigitalOcean: $6/month (1GB RAM, 1 vCPU)
   - Hetzner: $4/month (2GB RAM, 2 vCPU) — best value
   - Vultr: $5/month (1GB RAM, 1 vCPU)

2. SSH in and setup:
   ```bash
   # Install Node.js 22
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs

   # Clone repo
   git clone https://github.com/SiphoYawe/Cyrus.git
   cd Cyrus

   # Install & build
   npm install
   npm run build

   # Create .env
   cat > .env << 'EOF'
   CYRUS_PRIVATE_KEY=0x...
   LIFI_API_KEY=...
   ANTHROPIC_API_KEY=sk-ant-...
   EOF

   # Copy config
   cp cyrus.config.example.json cyrus.config.json
   # Edit as needed: nano cyrus.config.json
   ```

3. Use **PM2** for process management:
   ```bash
   npm install -g pm2
   pm2 start dist/index.js --name cyrus-agent
   pm2 save
   pm2 startup  # Auto-restart on reboot
   ```

4. Set up **nginx** as reverse proxy (for HTTPS + WebSocket):
   ```nginx
   server {
       listen 443 ssl;
       server_name agent.yourdomain.com;

       ssl_certificate /etc/letsencrypt/live/agent.yourdomain.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/agent.yourdomain.com/privkey.pem;

       # REST API
       location /api/ {
           proxy_pass http://127.0.0.1:3001;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
       }

       # WebSocket
       location /ws {
           proxy_pass http://127.0.0.1:8080;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
           proxy_read_timeout 86400;
       }
   }
   ```

5. Get SSL with Let's Encrypt:
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d agent.yourdomain.com
   ```

### Option E: Run Locally (for Demo / Development)

Just run on your machine:

```bash
cd cyrus/
npm run dev    # Agent with auto-reload
# In another terminal:
cd dashboard/
npm run dev    # Dashboard on localhost:3000
```

For the bounty demo video, local is perfectly fine.

---

## 8. Post-Deployment Verification

### Health Check

```bash
# REST API
curl https://your-agent-url/api/health
# Expected: { "ok": true, "data": { "status": "running", ... } }

# Portfolio
curl https://your-agent-url/api/portfolio
# Expected: { "ok": true, "data": { "balances": [...], ... } }

# Strategies
curl https://your-agent-url/api/strategies
# Expected: { "ok": true, "data": [...] }
```

### WebSocket Test

```javascript
// Quick test in browser console or Node.js
const ws = new WebSocket('wss://your-agent-url:8080');
ws.onopen = () => console.log('Connected!');
ws.onmessage = (e) => console.log('Event:', JSON.parse(e.data));
// Should receive heartbeat events every 30s
```

### Dashboard Verification

1. Open your Vercel dashboard URL
2. Connect wallet via RainbowKit
3. Sign SIWE message
4. Verify:
   - Portfolio shows balances (or empty if dry-run with no funds)
   - Agent status indicator shows "Running"
   - WebSocket connection active (real-time updates)
   - Activity feed populates as agent makes decisions

### Full System Test Sequence

```
1. Start agent in dry-run mode
2. Open dashboard, connect wallet
3. Check /api/health returns ok
4. Check WebSocket receives heartbeat
5. Wait for first OODA tick (~30s)
6. Verify strategy evaluation in logs
7. Check activity feed for decision reports
8. Test NL command via chat: "what chains are active?"
9. Adjust risk dial, verify agent receives update
10. If all good → switch to live mode with small capital
```

---

## 9. Troubleshooting

### Common Issues

| Issue | Cause | Fix |
|---|---|---|
| `ANTHROPIC_API_KEY not set` | Missing .env | Create `.env` with the key |
| `Cannot connect to WebSocket` | Port blocked / wrong URL | Check firewall, verify `NEXT_PUBLIC_WS_URL` |
| `CORS error on dashboard` | `corsOrigin` mismatch | Set `rest.corsOrigin` to your Vercel URL in config |
| `Rate limited by LI.FI` | No API key / too many requests | Add `LIFI_API_KEY`, the agent has built-in backoff |
| `Transaction failed: insufficient funds` | Wallet not funded | Send gas + trading tokens to agent wallet |
| `SQLite BUSY` | Concurrent write access | Only run one agent instance (WAL mode handles read concurrency) |
| `Dashboard shows "Disconnected"` | Agent not running / URL wrong | Verify agent is running, check `WS_URL` and `API_URL` |
| `WalletConnect modal empty` | Missing/invalid project ID | Get project ID from cloud.walletconnect.com |

### Logs

```bash
# If using PM2
pm2 logs cyrus-agent

# If running directly
# Logs go to stdout — pipe to file:
npm start 2>&1 | tee cyrus.log

# Change log level for more detail
# In .env: CYRUS_LOG_LEVEL=debug
```

---

## Quick Start Summary

**Minimum to get running (dry-run mode, local):**

```bash
# 1. Get your keys
#    - Anthropic: console.anthropic.com → API Keys → Create
#    - WalletConnect: cloud.walletconnect.com → New Project
#    - Wallet: use any EVM private key

# 2. Configure agent
cd cyrus/
cp .env.example .env
# Edit .env with your keys:
#   CYRUS_PRIVATE_KEY=0x...
#   ANTHROPIC_API_KEY=sk-ant-...

cp cyrus.config.example.json cyrus.config.json
# Leave defaults (dry-run mode)

# 3. Install & run agent
npm install
npm run build
npm start

# 4. Configure dashboard
cd dashboard/
cp .env.local.example .env.local
# Edit .env.local:
#   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_id
#   SESSION_SECRET=$(openssl rand -hex 32)

# 5. Run dashboard
npm install
npm run dev

# 6. Open http://localhost:3000
```

**To go live:**
1. Fund the agent wallet on desired chains
2. Change `mode` to `"live"` in `cyrus.config.json`
3. Start with small amounts ($50-100 per chain)
4. Monitor via dashboard + logs
5. Gradually increase as confidence builds

---

## What You Still Need to Provide

### Mandatory (Must Have)
- [ ] **Anthropic API Key** — Get from console.anthropic.com
- [ ] **EVM Private Key** — Generate a new dedicated wallet
- [ ] **WalletConnect Project ID** — Get from cloud.walletconnect.com
- [ ] **Session Secret** — Generate: `openssl rand -hex 32`

### Recommended (Should Have)
- [ ] **LI.FI API Key** — Email partners@li.fi or get from jumper.exchange/developers
- [ ] **Hosting for Agent Backend** — Railway / Render / Fly.io / VPS (see Section 7)
- [ ] **Custom RPC URLs** — Alchemy / Infura free tier for reliable blockchain access
- [ ] **Domain name** — For agent backend URL (if deploying publicly)

### Optional (Nice to Have)
- [ ] **Telegram session** — Only if using Pear Protocol signals
- [ ] **Solana keypair** — Only if operating on Solana
- [ ] **Wallet funding** — Only needed for `live` mode

### Not Needed
- No smart contract deployments
- No database setup (SQLite auto-creates)
- No Redis/Postgres
- No Docker (unless you want it)
- No CI/CD (unless you want it)
