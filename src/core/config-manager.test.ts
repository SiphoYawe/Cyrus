import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigManager, SecretsBlockedError, buildEnvOverrides } from './config-manager.js';
import { CyrusConfigSchema, type CyrusConfig } from './config.js';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeConfig(overrides: Record<string, unknown> = {}): CyrusConfig {
  return CyrusConfigSchema.parse(overrides);
}

function makeTmpConfigPath(): string {
  return join(tmpdir(), `cyrus-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe('ConfigManager', () => {
  let configPath: string;
  let manager: ConfigManager;

  beforeEach(() => {
    configPath = makeTmpConfigPath();
    manager = new ConfigManager(makeConfig(), new Set(), configPath);
  });

  afterEach(() => {
    try { unlinkSync(configPath); } catch { /* ignore */ }
    try { unlinkSync(configPath.replace('.json', '.json.tmp')); } catch { /* ignore */ }
  });

  describe('getConfig', () => {
    it('returns the initial config', () => {
      const config = manager.getConfig();
      expect(config.mode).toBe('dry-run');
      expect(config.tickIntervalMs).toBe(30_000);
    });
  });

  describe('updateConfig', () => {
    it('merges a valid patch and returns updated config', () => {
      const { config, requiresRestart } = manager.updateConfig({
        tickIntervalMs: 15_000,
        logLevel: 'debug',
      });

      expect(config.tickIntervalMs).toBe(15_000);
      expect(config.logLevel).toBe('debug');
      expect(config.mode).toBe('dry-run'); // unchanged
      expect(requiresRestart).toBe(false);
    });

    it('deep-merges nested objects', () => {
      const { config } = manager.updateConfig({
        risk: { maxGasCostUsd: 100 },
      });

      expect(config.risk.maxGasCostUsd).toBe(100);
      expect(config.risk.defaultSlippage).toBe(0.005); // preserved
    });

    it('throws ZodError for invalid values', () => {
      expect(() => {
        manager.updateConfig({ tickIntervalMs: -5 });
      }).toThrow();
    });

    it('throws SecretsBlockedError for secret fields', () => {
      expect(() => {
        manager.updateConfig({ privateKey: 'abc123' });
      }).toThrow(SecretsBlockedError);

      expect(() => {
        manager.updateConfig({ lifiApiKey: 'key' });
      }).toThrow(SecretsBlockedError);

      expect(() => {
        manager.updateConfig({ anthropicApiKey: 'key' });
      }).toThrow(SecretsBlockedError);
    });

    it('sets requiresRestart=true for restart-required fields', () => {
      const result1 = manager.updateConfig({ mode: 'live' });
      expect(result1.requiresRestart).toBe(true);
    });

    it('sets requiresRestart=true for nested restart-required fields', () => {
      const result = manager.updateConfig({ ws: { port: 9090 } });
      expect(result.requiresRestart).toBe(true);
    });

    it('sets requiresRestart=false for hot-updatable fields', () => {
      const result = manager.updateConfig({ logLevel: 'debug' });
      expect(result.requiresRestart).toBe(false);
    });

    it('persists config to file after update', () => {
      manager.updateConfig({ tickIntervalMs: 20_000 });

      expect(existsSync(configPath)).toBe(true);
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.tickIntervalMs).toBe(20_000);
    });

    it('writes atomically (tmp file should not linger)', () => {
      const tmpPath = configPath.replace('.json', '.json.tmp');
      manager.updateConfig({ logLevel: 'warn' });

      // The tmp file should have been renamed away
      expect(existsSync(tmpPath)).toBe(false);
      expect(existsSync(configPath)).toBe(true);
    });
  });

  describe('onChange', () => {
    it('notifies listeners on config change', () => {
      const listener = vi.fn();
      manager.onChange(listener);

      manager.updateConfig({ logLevel: 'debug' });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0].logLevel).toBe('debug');
    });

    it('returns an unsubscribe function', () => {
      const listener = vi.fn();
      const unsub = manager.onChange(listener);

      manager.updateConfig({ logLevel: 'debug' });
      expect(listener).toHaveBeenCalledOnce();

      unsub();
      manager.updateConfig({ logLevel: 'warn' });
      expect(listener).toHaveBeenCalledOnce(); // not called again
    });

    it('does not throw if listener throws', () => {
      manager.onChange(() => { throw new Error('listener error'); });

      expect(() => {
        manager.updateConfig({ logLevel: 'debug' });
      }).not.toThrow();
    });
  });

  describe('getEnvOverrides', () => {
    it('returns the set provided at construction', () => {
      const overrides = new Set(['mode', 'logLevel']);
      const mgr = new ConfigManager(makeConfig(), overrides, configPath);
      expect(mgr.getEnvOverrides()).toEqual(overrides);
    });
  });

  describe('getSecretsConfigured', () => {
    it('returns boolean flags based on env vars', () => {
      const result = manager.getSecretsConfigured();
      expect(typeof result.lifiApiKey).toBe('boolean');
      expect(typeof result.anthropicApiKey).toBe('boolean');
      expect(typeof result.privateKey).toBe('boolean');
    });
  });
});

describe('buildEnvOverrides', () => {
  it('returns empty set when no env vars are set', () => {
    const original = { ...process.env };
    delete process.env.CYRUS_MODE;
    delete process.env.CYRUS_TICK_INTERVAL;
    delete process.env.CYRUS_LOG_LEVEL;

    const result = buildEnvOverrides();
    // May not be empty if other CYRUS_ vars are set, but mode/tick/log shouldn't be in it
    expect(result.has('mode')).toBe(false);
    expect(result.has('tickIntervalMs')).toBe(false);
    expect(result.has('logLevel')).toBe(false);

    // Restore
    Object.assign(process.env, original);
  });

  it('detects CYRUS_MODE override', () => {
    const original = process.env.CYRUS_MODE;
    process.env.CYRUS_MODE = 'live';

    const result = buildEnvOverrides();
    expect(result.has('mode')).toBe(true);

    if (original === undefined) {
      delete process.env.CYRUS_MODE;
    } else {
      process.env.CYRUS_MODE = original;
    }
  });
});
