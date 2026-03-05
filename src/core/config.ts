import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('config');

// Load .env file
loadDotenv();

// Config schema
const RiskConfigSchema = z.object({
  defaultSlippage: z.number().min(0).max(0.1).default(0.005),
  maxGasCostUsd: z.number().positive().default(50),
  maxPositionSizeUsd: z.number().positive().default(10000),
  maxConcurrentTransfers: z.number().int().positive().default(20),
  drawdownThreshold: z.number().min(0).max(1).default(0.15),
});

const ChainConfigSchema = z.object({
  enabled: z.array(z.number().int().positive()).default([1, 42161, 10, 137, 8453, 56]),
  rpcUrls: z.record(z.string(), z.string()).default({}),
});

const StrategyConfigSchema = z.object({
  enabled: z.array(z.string()).default([]),
  directory: z.string().default('strategies'),
});

const ComposerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  supportedProtocols: z.array(z.string()).default([
    'aave-v3', 'morpho', 'euler', 'pendle', 'lido', 'etherfi', 'ethena',
  ]),
  defaultSlippage: z.number().min(0).max(0.1).default(0.005),
});

const WsConfigSchema = z.object({
  port: z.number().int().positive().default(8080),
  enabled: z.boolean().default(true),
});

const RestConfigSchema = z.object({
  port: z.number().int().positive().default(3001),
  enabled: z.boolean().default(true),
  corsOrigin: z.string().default('*'),
});

export const CyrusConfigSchema = z.object({
  mode: z.enum(['live', 'dry-run', 'backtest']).default('dry-run'),
  tickIntervalMs: z.number().int().positive().default(30_000),
  integrator: z.string().default('cyrus-agent'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  risk: RiskConfigSchema.default(() => RiskConfigSchema.parse({})),
  chains: ChainConfigSchema.default(() => ChainConfigSchema.parse({})),
  strategies: StrategyConfigSchema.default(() => StrategyConfigSchema.parse({})),
  composer: ComposerConfigSchema.default(() => ComposerConfigSchema.parse({})),
  ws: WsConfigSchema.default(() => WsConfigSchema.parse({})),
  rest: RestConfigSchema.default(() => RestConfigSchema.parse({})),
  dbPath: z.string().default('cyrus.db'),
});

export type CyrusConfig = z.infer<typeof CyrusConfigSchema>;

// Secrets — always from env vars, never from config file
export interface CyrusSecrets {
  readonly privateKey: string | undefined;
  readonly lifiApiKey: string | undefined;
  readonly anthropicApiKey: string | undefined;
}

export interface ResolvedConfig {
  readonly config: CyrusConfig;
  readonly secrets: CyrusSecrets;
  readonly originalConfig: unknown;
}

function loadConfigFile(path?: string): Record<string, unknown> {
  const configPath = path || resolve(process.cwd(), 'cyrus.config.json');

  if (!existsSync(configPath)) {
    logger.info({ path: configPath }, 'No config file found, using defaults');
    return {};
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    logger.info({ path: configPath }, 'Config file loaded');
    return parsed;
  } catch (error) {
    logger.warn({ path: configPath, error }, 'Failed to parse config file, using defaults');
    return {};
  }
}

function loadEnvConfig(): Record<string, unknown> {
  const env: Record<string, unknown> = {};

  if (process.env.CYRUS_MODE) env.mode = process.env.CYRUS_MODE;
  if (process.env.CYRUS_TICK_INTERVAL) env.tickIntervalMs = parseInt(process.env.CYRUS_TICK_INTERVAL, 10);
  if (process.env.CYRUS_LOG_LEVEL) env.logLevel = process.env.CYRUS_LOG_LEVEL;
  if (process.env.CYRUS_MAX_GAS_COST_USD) {
    env.risk = { maxGasCostUsd: parseFloat(process.env.CYRUS_MAX_GAS_COST_USD) };
  }
  if (process.env.CYRUS_WS_PORT) {
    env.ws = { port: parseInt(process.env.CYRUS_WS_PORT, 10) };
  }
  if (process.env.CYRUS_REST_PORT || process.env.PORT) {
    env.rest = { port: parseInt(process.env.CYRUS_REST_PORT || process.env.PORT!, 10) };
  }
  if (process.env.CYRUS_CORS_ORIGIN) {
    env.rest = { ...(env.rest as Record<string, unknown> ?? {}), corsOrigin: process.env.CYRUS_CORS_ORIGIN };
  }
  if (process.env.CYRUS_STRATEGIES_ENABLED) {
    env.strategies = { enabled: process.env.CYRUS_STRATEGIES_ENABLED.split(',').map((s) => s.trim()) };
  }
  if (process.env.CYRUS_CHAINS_ENABLED) {
    env.chains = { ...(env.chains as Record<string, unknown> ?? {}), enabled: process.env.CYRUS_CHAINS_ENABLED.split(',').map((s) => parseInt(s.trim(), 10)) };
  }
  if (process.env.CYRUS_RPC_URLS) {
    // Format: "chainId=url,chainId=url"
    const rpcUrls: Record<string, string> = {};
    for (const pair of process.env.CYRUS_RPC_URLS.split(',')) {
      const [id, url] = pair.split('=', 2);
      if (id && url) rpcUrls[id.trim()] = url.trim();
    }
    env.chains = { ...(env.chains as Record<string, unknown> ?? {}), rpcUrls };
  }

  return env;
}

function loadSecrets(): CyrusSecrets {
  return {
    privateKey: process.env.CYRUS_PRIVATE_KEY || undefined,
    lifiApiKey: process.env.LIFI_API_KEY || undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  };
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (
      sourceVal && typeof sourceVal === 'object' && !Array.isArray(sourceVal) &&
      targetVal && typeof targetVal === 'object' && !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }

  return result;
}

export function mergeConfig(
  cli: Record<string, unknown>,
  env: Record<string, unknown>,
  file: Record<string, unknown>,
  defaults: Record<string, unknown> = {}
): Record<string, unknown> {
  // Precedence: CLI > env > file > defaults
  let merged = { ...defaults };
  merged = deepMerge(merged, file);
  merged = deepMerge(merged, env);
  merged = deepMerge(merged, cli);
  return merged;
}

export function loadConfig(
  cliArgs: Record<string, unknown> = {},
  configPath?: string
): ResolvedConfig {
  const fileConfig = loadConfigFile(configPath);
  const envConfig = loadEnvConfig();
  const merged = mergeConfig(cliArgs, envConfig, fileConfig);

  // Deep copy for debugging
  const originalConfig = JSON.parse(JSON.stringify(merged));

  const config = CyrusConfigSchema.parse(merged);
  const secrets = loadSecrets();

  logger.info(
    {
      mode: config.mode,
      tickIntervalMs: config.tickIntervalMs,
      enabledChains: config.chains.enabled,
      wsPort: config.ws.port,
      restPort: config.rest.port,
    },
    'Configuration loaded'
  );

  return { config, secrets, originalConfig };
}

export function redactConfig(config: CyrusConfig): CyrusConfig & { privateKey: string; lifiApiKey: string; anthropicApiKey: string } {
  return {
    ...config,
    privateKey: '[REDACTED]',
    lifiApiKey: '[REDACTED]',
    anthropicApiKey: '[REDACTED]',
  };
}
