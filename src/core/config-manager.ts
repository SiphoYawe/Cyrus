import { writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { CyrusConfigSchema, type CyrusConfig } from './config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('config-manager');

const RESTART_REQUIRED_FIELDS = [
  'ws.port', 'rest.port', 'dbPath', 'mode', 'integrator',
] as const;

const SECRETS_BLOCKLIST = [
  'privateKey', 'lifiApiKey', 'anthropicApiKey',
] as const;

type ConfigChangeListener = (config: CyrusConfig) => void;

export class ConfigManager {
  private config: CyrusConfig;
  private readonly listeners: Set<ConfigChangeListener> = new Set();
  private readonly envOverrides: Set<string>;
  private readonly configFilePath: string;

  constructor(config: CyrusConfig, envOverrides: Set<string>, configFilePath: string) {
    this.config = config;
    this.envOverrides = envOverrides;
    this.configFilePath = configFilePath;
  }

  getConfig(): CyrusConfig {
    return this.config;
  }

  getEnvOverrides(): Set<string> {
    return this.envOverrides;
  }

  updateConfig(patch: Record<string, unknown>): { config: CyrusConfig; requiresRestart: boolean } {
    // Check for secrets in patch
    for (const key of SECRETS_BLOCKLIST) {
      if (key in patch) {
        throw new SecretsBlockedError(`Cannot set secret field '${key}' via API`);
      }
    }

    // Deep merge patch into current config
    const merged = deepMerge(
      JSON.parse(JSON.stringify(this.config)) as Record<string, unknown>,
      patch,
    );

    // Validate merged result
    const validated = CyrusConfigSchema.parse(merged);

    // Check if restart is required
    const requiresRestart = checkRequiresRestart(patch);

    // Update in-memory config
    this.config = validated;

    // Persist to file
    this.persistConfig(validated, this.configFilePath);

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(validated);
      } catch (err) {
        logger.error({ err }, 'Config change listener threw');
      }
    }

    logger.info({ requiresRestart }, 'Config updated');
    return { config: validated, requiresRestart };
  }

  onChange(callback: ConfigChangeListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  getSecretsConfigured(): { lifiApiKey: boolean; anthropicApiKey: boolean; privateKey: boolean } {
    return {
      lifiApiKey: Boolean(process.env.LIFI_API_KEY),
      anthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
      privateKey: Boolean(process.env.CYRUS_PRIVATE_KEY),
    };
  }

  private persistConfig(config: CyrusConfig, filePath: string): void {
    try {
      const tmpPath = join(dirname(filePath), '.cyrus.config.json.tmp');
      writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
      renameSync(tmpPath, filePath);
      logger.debug({ path: filePath }, 'Config persisted to file');
    } catch (err) {
      logger.error({ err, path: filePath }, 'Failed to persist config');
    }
  }
}

export class SecretsBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsBlockedError';
  }
}

function checkRequiresRestart(patch: Record<string, unknown>): boolean {
  const flatKeys = flattenKeys(patch);
  return flatKeys.some((key) =>
    RESTART_REQUIRED_FIELDS.some((rf) => key === rf || key.startsWith(rf + '.')),
  );
}

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    keys.push(fullKey);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as Record<string, unknown>, fullKey));
    }
  }
  return keys;
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
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }
  return result;
}

/**
 * Build the set of config field paths overridden by environment variables.
 */
export function buildEnvOverrides(): Set<string> {
  const overrides = new Set<string>();
  if (process.env.CYRUS_MODE) overrides.add('mode');
  if (process.env.CYRUS_TICK_INTERVAL) overrides.add('tickIntervalMs');
  if (process.env.CYRUS_LOG_LEVEL) overrides.add('logLevel');
  if (process.env.CYRUS_MAX_GAS_COST_USD) overrides.add('risk.maxGasCostUsd');
  if (process.env.CYRUS_WS_PORT) overrides.add('ws.port');
  if (process.env.CYRUS_REST_PORT || process.env.PORT) overrides.add('rest.port');
  if (process.env.CYRUS_CORS_ORIGIN) overrides.add('rest.corsOrigin');
  if (process.env.CYRUS_STRATEGIES_ENABLED) overrides.add('strategies.enabled');
  if (process.env.CYRUS_CHAINS_ENABLED) overrides.add('chains.enabled');
  if (process.env.CYRUS_RPC_URLS) overrides.add('chains.rpcUrls');
  return overrides;
}
