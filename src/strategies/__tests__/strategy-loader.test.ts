import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrategyLoader } from '../strategy-loader.js';
import { CrossChainStrategy } from '../cross-chain-strategy.js';

// Helper: create a temp directory for test strategy files
async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `cyrus-test-${prefix}-`));
}

// Helper: write a valid strategy file
async function writeValidStrategy(dir: string, name: string, strategyName?: string): Promise<void> {
  const sName = strategyName ?? name;
  const content = `
import { CrossChainStrategy } from '${join(process.cwd(), 'src/strategies/cross-chain-strategy.js')}';

export class ${capitalize(sName)}Strategy extends CrossChainStrategy {
  readonly name = '${sName}';
  readonly timeframe = '5m';

  shouldExecute() { return null; }
  buildExecution(signal, ctx) {
    return { id: '1', strategyName: this.name, actions: [], estimatedCostUsd: 0, estimatedDurationMs: 0, metadata: {} };
  }
}
`;
  await writeFile(join(dir, `${name}.ts`), content, 'utf-8');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

let tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  tempDirs = [];
});

describe('StrategyLoader', () => {
  describe('scanDirectory', () => {
    it('discovers valid strategy files', async () => {
      const dir = await makeTempDir('scan');
      await writeValidStrategy(dir, 'alpha');

      const loader = new StrategyLoader([dir]);
      const result = await loader.scanDirectory(dir);

      expect(result.size).toBe(1);
      expect(result.has('alpha')).toBe(true);
    });

    it('filters out non-strategy files', async () => {
      const dir = await makeTempDir('filter');
      await writeFile(join(dir, 'helper.ts'), 'export const x = 1;', 'utf-8');
      await writeFile(join(dir, 'util.test.ts'), 'import { test } from "vitest";', 'utf-8');
      await writeValidStrategy(dir, 'beta');

      const loader = new StrategyLoader([dir]);
      const result = await loader.scanDirectory(dir);

      expect(result.size).toBe(1);
      expect(result.has('beta')).toBe(true);
    });

    it('returns empty map for non-existent directory', async () => {
      const loader = new StrategyLoader(['/tmp/nonexistent-dir-xyz']);
      const result = await loader.scanDirectory('/tmp/nonexistent-dir-xyz');
      expect(result.size).toBe(0);
    });
  });

  describe('discoverAll', () => {
    it('discovers strategies from multiple directories', async () => {
      const dir1 = await makeTempDir('multi1');
      const dir2 = await makeTempDir('multi2');
      await writeValidStrategy(dir1, 'alpha');
      await writeValidStrategy(dir2, 'beta');

      const loader = new StrategyLoader([dir1, dir2]);
      const result = await loader.discoverAll();

      expect(result.loaded).toContain('alpha');
      expect(result.loaded).toContain('beta');
    });

    it('first search path takes priority on name collision', async () => {
      const userDir = await makeTempDir('user');
      const builtinDir = await makeTempDir('builtin');
      await writeValidStrategy(userDir, 'gamma', 'gamma');
      await writeValidStrategy(builtinDir, 'gamma', 'gamma');

      const loader = new StrategyLoader([userDir, builtinDir]);
      await loader.discoverAll();

      const available = await loader.listAvailable();
      expect(available).toContain('gamma');
      // Only one entry for 'gamma'
      expect(available.filter((n) => n === 'gamma')).toHaveLength(1);
    });
  });

  describe('listAvailable', () => {
    it('returns sorted strategy names', async () => {
      const dir = await makeTempDir('list');
      await writeValidStrategy(dir, 'zulu');
      await writeValidStrategy(dir, 'alpha');
      await writeValidStrategy(dir, 'mike');

      const loader = new StrategyLoader([dir]);
      const names = await loader.listAvailable();

      expect(names).toEqual(['alpha', 'mike', 'zulu']);
    });
  });

  describe('load', () => {
    it('loads and instantiates a valid strategy', async () => {
      const dir = await makeTempDir('load');
      await writeValidStrategy(dir, 'delta');

      const loader = new StrategyLoader([dir]);
      const strategy = await loader.load('delta');

      expect(strategy).toBeInstanceOf(CrossChainStrategy);
      expect(strategy.name).toBe('delta');
      expect(strategy.timeframe).toBe('5m');
    });

    it('throws for non-existent strategy name', async () => {
      const dir = await makeTempDir('missing');
      const loader = new StrategyLoader([dir]);

      await expect(loader.load('nonexistent')).rejects.toThrow('not found');
    });

    it('returns cached instance on second call', async () => {
      const dir = await makeTempDir('cache');
      await writeValidStrategy(dir, 'echo');

      const loader = new StrategyLoader([dir]);
      const first = await loader.load('echo');
      const second = await loader.load('echo');

      expect(first).toBe(second);
    });

    it('handles invalid strategy file gracefully', async () => {
      const dir = await makeTempDir('error');
      await writeFile(
        join(dir, 'broken.ts'),
        'export class BrokenStrategy extends CrossChainStrategy { /* missing implementations */ }',
        'utf-8',
      );

      const loader = new StrategyLoader([dir]);
      // broken.ts doesn't actually match the pattern properly for import,
      // but scanDirectory found it. Load will fail gracefully.
      await expect(loader.load('broken')).rejects.toThrow();
    });
  });
});
