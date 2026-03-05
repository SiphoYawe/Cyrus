import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../utils/logger.js';
import { CrossChainStrategy } from './cross-chain-strategy.js';
import { StrategyConfigError } from '../utils/errors.js';

const logger = createLogger('strategy-loader');

const STRATEGY_PATTERN_TS = /extends\s+CrossChainStrategy/;
const STRATEGY_PATTERN_JS = /CrossChainStrategy/;

const __filename_loader = fileURLToPath(import.meta.url);
const __dirname_loader = dirname(__filename_loader);

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
    // Use __dirname-relative path so it works from both src (tsx) and dist (node)
    const builtinDir = join(__dirname_loader, 'builtin');
    this.searchPaths = searchPaths ?? ['./strategies', builtinDir];
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
      entries = dirEntries.filter((e) =>
        (e.endsWith('.ts') || e.endsWith('.js')) &&
        !e.endsWith('.test.ts') &&
        !e.endsWith('.test.js') &&
        !e.endsWith('.d.ts') &&
        !e.endsWith('.d.ts.map') &&
        !e.endsWith('.js.map'),
      );
    } catch {
      return result;
    }

    for (const entry of entries) {
      const filePath = join(absDir, entry);
      const ext = entry.endsWith('.ts') ? '.ts' : '.js';
      try {
        const content = await readFile(filePath, 'utf-8');
        const pattern = ext === '.ts' ? STRATEGY_PATTERN_TS : STRATEGY_PATTERN_JS;
        if (!pattern.test(content)) {
          continue; // fast pre-check: not a strategy file
        }
        const name = basename(entry, ext);
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

    // Try exact match first, then kebab-case conversion (PascalCase → kebab-case)
    let filePath = this.discovered.get(strategyName);
    if (!filePath) {
      const kebab = strategyName
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase();
      filePath = this.discovered.get(kebab);
    }
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
