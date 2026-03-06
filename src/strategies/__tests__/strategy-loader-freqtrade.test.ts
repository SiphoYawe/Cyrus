import { describe, it, expect } from 'vitest';
import { StrategyLoader } from '../strategy-loader.js';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename_test = fileURLToPath(import.meta.url);
const __dirname_test = dirname(__filename_test);

describe('StrategyLoader — Freqtrade discovery', () => {
  it('discovers strategies in builtin/freqtrade/ subdirectory', async () => {
    const builtinDir = resolve(__dirname_test, '..', 'builtin');
    const loader = new StrategyLoader([builtinDir]);
    const result = await loader.discoverAll();

    // Should find at least the 3 freqtrade strategies
    expect(result.loaded).toContain('bollinger-bounce');
    expect(result.loaded).toContain('macd-crossover');
    expect(result.loaded).toContain('rsi-mean-reversion');
  });

  it('discovers both native and freqtrade strategies', async () => {
    const builtinDir = resolve(__dirname_test, '..', 'builtin');
    const loader = new StrategyLoader([builtinDir]);
    const result = await loader.discoverAll();

    // Should find native strategies too
    expect(result.loaded).toContain('yield-hunter');
    expect(result.loaded).toContain('cross-chain-arb');

    // Total should be > 3 (includes both native + freqtrade)
    expect(result.loaded.length).toBeGreaterThan(5);
  });

  it('regex matches extends FreqtradeAdapter in scanDirectory', async () => {
    const freqtradeDir = resolve(__dirname_test, '..', 'builtin', 'freqtrade');
    const loader = new StrategyLoader([freqtradeDir]);
    const result = await loader.discoverAll();

    expect(result.loaded.length).toBeGreaterThanOrEqual(3);
    expect(result.loaded).toContain('bollinger-bounce');
  });
});
