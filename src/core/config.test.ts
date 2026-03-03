import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CyrusConfigSchema, loadConfig, mergeConfig } from './config.js';

describe('CyrusConfigSchema', () => {
  it('parses empty object with all defaults', () => {
    const config = CyrusConfigSchema.parse({});

    expect(config.mode).toBe('dry-run');
    expect(config.tickIntervalMs).toBe(30_000);
    expect(config.integrator).toBe('cyrus-agent');
    expect(config.risk.defaultSlippage).toBe(0.005);
    expect(config.risk.maxGasCostUsd).toBe(50);
    expect(config.risk.maxConcurrentTransfers).toBe(20);
    expect(config.ws.port).toBe(8080);
    expect(config.rest.port).toBe(3001);
    expect(config.composer.enabled).toBe(true);
  });

  it('parses valid config overrides', () => {
    const config = CyrusConfigSchema.parse({
      mode: 'live',
      tickIntervalMs: 15_000,
      risk: { defaultSlippage: 0.01, maxGasCostUsd: 100 },
      ws: { port: 9090 },
    });

    expect(config.mode).toBe('live');
    expect(config.tickIntervalMs).toBe(15_000);
    expect(config.risk.defaultSlippage).toBe(0.01);
    expect(config.risk.maxGasCostUsd).toBe(100);
    expect(config.ws.port).toBe(9090);
    // Defaults still apply for unspecified fields
    expect(config.rest.port).toBe(3001);
  });

  it('rejects invalid mode', () => {
    expect(() => CyrusConfigSchema.parse({ mode: 'invalid' })).toThrow();
  });

  it('rejects negative slippage', () => {
    expect(() =>
      CyrusConfigSchema.parse({ risk: { defaultSlippage: -0.01 } })
    ).toThrow();
  });

  it('rejects slippage above 10%', () => {
    expect(() =>
      CyrusConfigSchema.parse({ risk: { defaultSlippage: 0.2 } })
    ).toThrow();
  });
});

describe('mergeConfig', () => {
  it('applies correct precedence: CLI > env > file > defaults', () => {
    const defaults = { mode: 'dry-run', tickIntervalMs: 30_000 };
    const file = { mode: 'backtest', tickIntervalMs: 15_000, logLevel: 'debug' };
    const env = { mode: 'live' };
    const cli = { logLevel: 'warn' };

    const merged = mergeConfig(cli, env, file, defaults);

    expect(merged.mode).toBe('live'); // env wins over file and defaults
    expect(merged.logLevel).toBe('warn'); // cli wins over file
    expect(merged.tickIntervalMs).toBe(15_000); // file wins over defaults
  });

  it('deep merges nested objects', () => {
    const defaults = { risk: { defaultSlippage: 0.005, maxGasCostUsd: 50 } };
    const file = { risk: { maxGasCostUsd: 100 } };

    const merged = mergeConfig({}, {}, file, defaults) as {
      risk: { defaultSlippage: number; maxGasCostUsd: number };
    };

    expect(merged.risk.defaultSlippage).toBe(0.005); // preserved from defaults
    expect(merged.risk.maxGasCostUsd).toBe(100); // overridden by file
  });
});

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clean env
    delete process.env.CYRUS_PRIVATE_KEY;
    delete process.env.LIFI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CYRUS_MODE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('loads defaults when no config file exists', () => {
    const { config, secrets } = loadConfig({}, '/nonexistent/path/config.json');

    expect(config.mode).toBe('dry-run');
    expect(config.tickIntervalMs).toBe(30_000);
    expect(secrets.privateKey).toBeUndefined();
    expect(secrets.lifiApiKey).toBeUndefined();
  });

  it('reads secrets from environment variables', () => {
    process.env.CYRUS_PRIVATE_KEY = '0xdeadbeef';
    process.env.LIFI_API_KEY = 'test-api-key';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    const { secrets } = loadConfig({}, '/nonexistent/path/config.json');

    expect(secrets.privateKey).toBe('0xdeadbeef');
    expect(secrets.lifiApiKey).toBe('test-api-key');
    expect(secrets.anthropicApiKey).toBe('sk-ant-test');
  });

  it('preserves original config for debugging', () => {
    const { originalConfig } = loadConfig(
      { mode: 'live' },
      '/nonexistent/path/config.json'
    );

    expect((originalConfig as Record<string, unknown>).mode).toBe('live');
  });
});
