import { createLogger } from '../utils/logger.js';
import { Store } from './store.js';
import type { CyrusConfig } from './config.js';
import type { CrossChainStrategy } from '../strategies/cross-chain-strategy.js';

const logger = createLogger('startup-diagnostics');

export interface FeatureStatus {
  readonly name: string;
  readonly status: 'ACTIVE' | 'PARTIAL' | 'DISABLED';
  readonly detail: string;
}

export interface DiagnosticReport {
  readonly mode: string;
  readonly walletAddress: string | null;
  readonly chains: readonly number[];
  readonly balanceUsd: number;
  readonly features: readonly FeatureStatus[];
  readonly dataSources: readonly FeatureStatus[];
  readonly strategies: readonly { name: string; status: 'ACTIVE' | 'DISABLED'; reason: string }[];
  readonly warnings: readonly string[];
  readonly timestamp: number;
}

/**
 * Collect agent startup diagnostics — features, data sources, strategies, warnings.
 * Logged once at the end of initialization.
 */
export function collectDiagnostics(ctx: {
  config: CyrusConfig;
  walletAddress?: string;
  strategies: readonly CrossChainStrategy[];
  hasLifiConnector: boolean;
  hasAiOrchestrator: boolean;
  hasCircuitBreaker: boolean;
  hasMcpClient: boolean;
  hasTelegram: boolean;
  hasSolana: boolean;
  wsPort: number;
  restPort: number;
}): DiagnosticReport {
  const store = Store.getInstance();
  const balances = store.getAllBalances();
  const totalUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);
  const warnings: string[] = [];

  // Features
  const features: FeatureStatus[] = [
    {
      name: 'LI.FI Connector',
      status: ctx.hasLifiConnector ? 'ACTIVE' : 'DISABLED',
      detail: ctx.hasLifiConnector
        ? `API key ${process.env.LIFI_API_KEY ? 'set' : 'not set (using public rate limits)'}`
        : 'No private key configured',
    },
    {
      name: 'AI Orchestrator',
      status: ctx.hasAiOrchestrator ? (process.env.ANTHROPIC_API_KEY ? 'ACTIVE' : 'PARTIAL') : 'DISABLED',
      detail: ctx.hasAiOrchestrator
        ? `Claude API ${process.env.ANTHROPIC_API_KEY ? 'key set' : 'key missing — using defaults'}`
        : 'Not initialized',
    },
    {
      name: 'Risk Engine',
      status: ctx.hasCircuitBreaker ? 'ACTIVE' : 'DISABLED',
      detail: ctx.hasCircuitBreaker
        ? `risk dial: ${5}, circuit breaker: armed`
        : 'Not initialized',
    },
    {
      name: 'WebSocket Server',
      status: 'ACTIVE',
      detail: `port ${ctx.wsPort}`,
    },
    {
      name: 'REST API',
      status: 'ACTIVE',
      detail: `port ${ctx.restPort}`,
    },
    {
      name: 'Persistence',
      status: 'ACTIVE',
      detail: `SQLite (${ctx.config.dbPath})`,
    },
  ];

  // Data sources
  const dataSources: FeatureStatus[] = [
    {
      name: 'Market Data',
      status: 'ACTIVE',
      detail: 'CoinGecko + DeFiLlama',
    },
    {
      name: 'On-Chain Indexer',
      status: 'ACTIVE',
      detail: `${ctx.config.chains.enabled.length} chains monitored`,
    },
    {
      name: 'Social Sentinel',
      status: process.env.TWITTER_BEARER_TOKEN ? 'ACTIVE' : 'PARTIAL',
      detail: process.env.TWITTER_BEARER_TOKEN
        ? 'All sources active'
        : 'governance only — no Twitter API key',
    },
    {
      name: 'Signal Aggregator',
      status: 'ACTIVE',
      detail: '4 evaluators',
    },
    {
      name: 'Telegram Consumer',
      status: ctx.hasTelegram ? 'ACTIVE' : 'DISABLED',
      detail: ctx.hasTelegram ? 'Connected to @agentpear' : 'no session string',
    },
    {
      name: 'MCP Client',
      status: ctx.hasMcpClient ? 'ACTIVE' : 'DISABLED',
      detail: ctx.hasMcpClient ? 'LI.FI tools available' : 'Not connected',
    },
    {
      name: 'Solana',
      status: ctx.hasSolana ? 'ACTIVE' : 'DISABLED',
      detail: ctx.hasSolana ? 'SOL + SPL tokens' : 'no SOLANA_PRIVATE_KEY',
    },
  ];

  // Strategies
  const strategyStatuses = ctx.strategies.map((s) => ({
    name: s.name,
    status: 'ACTIVE' as const,
    reason: '',
  }));

  // Warnings
  if (!process.env.ANTHROPIC_API_KEY) {
    warnings.push('ANTHROPIC_API_KEY not set: AI orchestrator using defaults');
  }
  if (!process.env.TWITTER_BEARER_TOKEN) {
    warnings.push('TWITTER_BEARER_TOKEN not set: Twitter social signals disabled');
  }
  if (!process.env.TELEGRAM_SESSION_STRING) {
    warnings.push('TELEGRAM_SESSION_STRING not set: Telegram signal consumer disabled');
  }
  if (!process.env.SOLANA_PRIVATE_KEY) {
    warnings.push('SOLANA_PRIVATE_KEY not set: Solana chain disabled');
  }
  if (!process.env.LIFI_API_KEY) {
    warnings.push('LIFI_API_KEY not set: using public rate limits');
  }

  return {
    mode: ctx.config.mode,
    walletAddress: ctx.walletAddress ?? null,
    chains: ctx.config.chains.enabled,
    balanceUsd: totalUsd,
    features,
    dataSources,
    strategies: strategyStatuses,
    warnings,
    timestamp: Date.now(),
  };
}

/**
 * Log the startup banner — called once after all initialization is complete.
 */
export function logStartupBanner(report: DiagnosticReport): void {
  const lines: string[] = [
    '',
    '=== CYRUS Agent v1.0 ===',
    `Mode: ${report.mode}`,
    `Wallet: ${report.walletAddress ?? 'NOT CONFIGURED'}`,
    `Chains: ${report.chains.join(', ')}`,
    `Balance: $${report.balanceUsd.toFixed(2)}`,
    '',
    'Features:',
  ];

  for (const f of report.features) {
    lines.push(`  ${f.name.padEnd(22)} ${f.status} (${f.detail})`);
  }

  lines.push('');
  lines.push('Data Sources:');
  for (const d of report.dataSources) {
    lines.push(`  ${d.name.padEnd(22)} ${d.status} (${d.detail})`);
  }

  lines.push('');
  lines.push(`Strategies (${report.strategies.length} enabled):`);
  for (const s of report.strategies) {
    lines.push(`  ${s.name.padEnd(22)} ${s.status}${s.reason ? ` (${s.reason})` : ''}`);
  }

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of report.warnings) {
      lines.push(`  - ${w}`);
    }
  }

  lines.push('');

  logger.info({ diagnostics: report }, lines.join('\n'));
}
