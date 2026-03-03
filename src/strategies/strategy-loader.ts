import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { createLogger } from '../utils/logger.js';
import { CrossChainStrategy } from './cross-chain-strategy.js';
import { StrategyConfigError } from '../utils/errors.js';

const logger = createLogger('strategy-loader');

const STRATEGY_PATTERN = /extends\s+CrossChainStrategy/;

export interface DiscoveryResult {
  readonly loaded: string[];
  readonly failed: ReadonlyArray<{ name: string; error: string }>;
}

export class StrategyLoader {
  private readonly searchPaths: readonly string[];
  private readonly discovered: Map<string, string> = new Map(); // name -> file path
  private readonly instances: Map<string, CrossChainStrategy> = new Map(); // name -> instance
  private scanned = false;

  constructor(searchPaths?: string[]) {
    this.searchPaths = searchPaths ?? ['./strategies', './src/strategies/builtin'];
  }

  async discoverAll(): Promise<DiscoveryResult> {
    this.discovered.clear();
    const loaded: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    for (const dir of this.searchPaths) {
      try {
        const dirStrategies = await this.scanDirectory(dir);
        for (const [name, filePath] of dirStrategies) {
          if (this.discovered.has(name)) {
            logger.warn(
              { name, userPath: this.discovered.get(name), builtinPath: filePath },
              'User strategy shadows built-in strategy',
            );
            continue; // earlier search path wins
          }
          this.discovered.set(name, filePath);
          loaded.push(name);
        }
      } catch (err) {
        logger.debug({ dir, error: (err as Error).message }, 'Search path not found or unreadable');
      }
    }

    this.scanned = true;
    logger.info({ count: loaded.length, strategies: loaded }, 'Strategy discovery complete');
    return { loaded, failed };
  }

  async scanDirectory(dirPath: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const absDir = resolve(dirPath);

    let entries: string[];
    try {
      const dirEntries = await readdir(absDir);
      entries = dirEntries.filter((e) => e.endsWith('.ts') && !e.endsWith('.test.ts') && !e.endsWith('.d.ts'));
    } catch {
      return result;
    }

    for (const entry of entries) {
      const filePath = join(absDir, entry);
      try {
        const content = await readFile(filePath, 'utf-8');
        if (!STRATEGY_PATTERN.test(content)) {
          continue; // fast pre-check: not a strategy file
        }
        const name = basename(entry, '.ts');
        result.set(name, filePath);
      } catch (err) {
        logger.warn({ file: filePath, error: (err as Error).message }, 'Failed to read strategy file');
      }
    }

    return result;
  }

  async load(strategyName: string): Promise<CrossChainStrategy> {
    // Return cached instance
    const cached = this.instances.get(strategyName);
    if (cached) return cached;

    // Ensure discovery has run
    if (!this.scanned) {
      await this.discoverAll();
    }

    const filePath = this.discovered.get(strategyName);
    if (!filePath) {
      throw new Error(
        `Strategy "${strategyName}" not found. Available: [${Array.from(this.discovered.keys()).join(', ')}]`,
      );
    }

    try {
      const mod = await import(filePath);
      const StrategyClass = this.findStrategyClass(mod);
      if (!StrategyClass) {
        throw new Error(`No class extending CrossChainStrategy found in ${filePath}`);
      }

      const instance = new StrategyClass();
      instance.validateConfig();
      this.instances.set(strategyName, instance);

      logger.info({ name: instance.name, timeframe: instance.timeframe }, 'Strategy loaded');
      return instance;
    } catch (err) {
      if (err instanceof StrategyConfigError) {
        throw err;
      }
      logger.warn({ strategyName, filePath, error: (err as Error).message }, 'Failed to load strategy');
      throw new Error(`Failed to load strategy "${strategyName}": ${(err as Error).message}`);
    }
  }

  async listAvailable(): Promise<string[]> {
    if (!this.scanned) {
      await this.discoverAll();
    }
    return Array.from(this.discovered.keys()).sort();
  }

  private findStrategyClass(
    mod: Record<string, unknown>,
  ): (new () => CrossChainStrategy) | null {
    for (const key of Object.keys(mod)) {
      const val = mod[key];
      if (
        typeof val === 'function' &&
        val.prototype instanceof CrossChainStrategy
      ) {
        return val as new () => CrossChainStrategy;
      }
    }
    return null;
  }
}
