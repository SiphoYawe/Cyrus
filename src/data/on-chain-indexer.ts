import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { RunnableBase } from '../core/runnable-base.js';
import type { ChainId, TokenAddress } from '../core/types.js';
import { chainId, tokenAddress } from '../core/types.js';
import type {
  OnChainIndexerConfig,
  OnChainEventFilter,
  OnChainEvent,
  ConcreteOnChainEvent,
  TvlChangeEvent,
  WhaleTradeEvent,
  LiquidityChangeEvent,
  GasUpdateEvent,
  FlowPatternEvent,
  ApyUpdateEvent,
  GasPriceInfo,
  WhaleWalletEntry,
  TvlSnapshot,
  FlowWindowEntry,
} from './on-chain-types.js';

const DEFAULT_CONFIG: OnChainIndexerConfig = {
  monitoredChains: [1, 42161, 10, 137, 8453, 56].map(chainId) as ChainId[],
  monitoredProtocols: ['aave-v3', 'morpho', 'euler'],
  whaleThresholdUsd: 50_000,
  tvlChangeThresholdPercent: 5,
  pollIntervalMs: 60_000,
  maxEventRetention: 10_000,
};

export class OnChainIndexer extends RunnableBase {
  readonly events: EventEmitter;
  private readonly config: OnChainIndexerConfig;

  // Ring buffer for events
  private readonly eventBuffer: ConcreteOnChainEvent[] = [];

  // TVL snapshots: key = `${protocol}-${chainId}`
  private readonly tvlSnapshots = new Map<string, TvlSnapshot>();

  // Gas prices: key = chainId
  private readonly gasPrices = new Map<number, GasPriceInfo>();
  private readonly previousGasPrices = new Map<number, number>();

  // Whale wallets
  private readonly whaleWallets: WhaleWalletEntry[] = [
    { address: '0x28c6c06298d514db089934071355e5743bf21d60', label: 'Binance Hot Wallet' },
    { address: '0x21a31ee1afc51d94c2efccaa2092ad1028285549', label: 'Binance' },
    { address: '0xdfd5293d8e347dfe59e90efd55b2956a1343963d', label: 'Binance' },
    { address: '0x56eddb7aa87536c09ccc2793473599fd21a8b17f', label: 'Alameda Research' },
    { address: '0x1db3439a222c519ab44bb1144fc28167b4fa6ee6', label: 'Wintermute' },
    { address: '0x0d0707963952f2fba59dd06f2b425ace40b492fe', label: 'Gate.io' },
    { address: '0x5041ed759dd4afc3a72b8192c143f72f4724081a', label: 'OKX' },
  ];

  // Transaction dedup
  private readonly seenTxHashes = new Set<string>();

  // Flow pattern tracking: key = `${chainId}-${tokenAddress}`
  private readonly flowWindows = new Map<string, FlowWindowEntry[]>();

  // APY snapshots: key = `${protocol}-${chainId}-${asset}`
  private readonly apySnapshots = new Map<string, number>();

  constructor(config: Partial<OnChainIndexerConfig> = {}) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    super(merged.pollIntervalMs, 'on-chain-indexer');
    this.config = merged;
    this.events = new EventEmitter();
  }

  async controlTask(): Promise<void> {
    const results = await Promise.allSettled([
      this.pollTvlChanges(),
      this.pollWhaleActivity(),
      this.pollLiquidityEvents(),
      this.pollGasPrices(),
      this.detectFlowPatterns(),
      this.pollApyUpdates(),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn(
          { error: (result.reason as Error).message },
          'Monitoring subroutine failed (graceful degradation)',
        );
      }
    }
  }

  async onStop(): Promise<void> {
    this.events.removeAllListeners();
    this.seenTxHashes.clear();
    this.logger.info('On-chain indexer stopped');
  }

  // --- Public query API ---

  queryEvents(filter: OnChainEventFilter): OnChainEvent[] {
    let results: ConcreteOnChainEvent[] = [...this.eventBuffer];

    if (filter.type !== undefined) {
      results = results.filter((e) => e.type === filter.type);
    }
    if (filter.chain !== undefined) {
      results = results.filter((e) => e.chain === filter.chain);
    }
    if (filter.token !== undefined) {
      results = results.filter((e) => {
        if ('token' in e) return (e as { token: TokenAddress }).token === filter.token;
        return false;
      });
    }
    if (filter.fromTimestamp !== undefined) {
      results = results.filter((e) => e.timestamp >= filter.fromTimestamp!);
    }
    if (filter.toTimestamp !== undefined) {
      results = results.filter((e) => e.timestamp <= filter.toTimestamp!);
    }

    // Sort by timestamp descending (newest first)
    results.sort((a, b) => b.timestamp - a.timestamp);
    return results;
  }

  getLatestEvents(count: number): OnChainEvent[] {
    const sorted = [...this.eventBuffer].sort((a, b) => b.timestamp - a.timestamp);
    return sorted.slice(0, count);
  }

  getGasPrice(chain: ChainId): GasPriceInfo | undefined {
    return this.gasPrices.get(chain as number);
  }

  getOptimalChain(): ChainId | undefined {
    let lowestGas = Infinity;
    let bestChain: ChainId | undefined;

    for (const [chain, info] of this.gasPrices) {
      if (info.gasPriceGwei < lowestGas) {
        lowestGas = info.gasPriceGwei;
        bestChain = chainId(chain);
      }
    }

    return bestChain;
  }

  getEventCount(): number {
    return this.eventBuffer.length;
  }

  // --- Private monitoring subroutines ---

  private async pollTvlChanges(): Promise<void> {
    for (const protocol of this.config.monitoredProtocols) {
      for (const chain of this.config.monitoredChains) {
        try {
          const currentTvl = await this.fetchProtocolTvl(protocol, chain);
          const snapshotKey = `${protocol}-${chain as number}`;
          const previous = this.tvlSnapshots.get(snapshotKey);

          if (previous) {
            const changePercent = ((currentTvl - previous.tvl) / previous.tvl) * 100;
            if (Math.abs(changePercent) >= this.config.tvlChangeThresholdPercent) {
              const event: TvlChangeEvent = {
                id: randomUUID(),
                type: 'tvl_change',
                chain,
                timestamp: Date.now(),
                metadata: {},
                protocol,
                oldTvl: previous.tvl,
                newTvl: currentTvl,
                changePercent,
              };
              this.addEvent(event);
            }
          }

          this.tvlSnapshots.set(snapshotKey, {
            protocol,
            chain,
            tvl: currentTvl,
            timestamp: Date.now(),
          });
        } catch (err) {
          this.logger.warn(
            { protocol, chain: chain as number, error: (err as Error).message },
            'Failed to fetch TVL for protocol on chain',
          );
        }
      }
    }
  }

  private async pollWhaleActivity(): Promise<void> {
    for (const chain of this.config.monitoredChains) {
      try {
        const trades = await this.fetchWhaleTransactions(chain);
        for (const trade of trades) {
          if (this.seenTxHashes.has(trade.txHash)) continue;
          if (trade.amountUsd < this.config.whaleThresholdUsd) continue;

          this.seenTxHashes.add(trade.txHash);

          const wallet = this.whaleWallets.find(
            (w) => w.address.toLowerCase() === trade.wallet.toLowerCase(),
          );

          const event: WhaleTradeEvent = {
            id: randomUUID(),
            type: 'whale_trade',
            chain,
            timestamp: Date.now(),
            metadata: { txHash: trade.txHash },
            walletAddress: trade.wallet,
            walletLabel: wallet?.label ?? null,
            token: tokenAddress(trade.token),
            amount: trade.amount,
            amountUsd: trade.amountUsd,
            direction: trade.direction,
            dex: trade.dex,
          };
          this.addEvent(event);
        }
      } catch (err) {
        this.logger.warn(
          { chain: chain as number, error: (err as Error).message },
          'Failed to poll whale activity',
        );
      }
    }

    // Prune old tx hashes to prevent memory leak (keep last 50k)
    if (this.seenTxHashes.size > 50_000) {
      const entries = [...this.seenTxHashes];
      for (let i = 0; i < entries.length - 25_000; i++) {
        this.seenTxHashes.delete(entries[i]!);
      }
    }
  }

  private async pollLiquidityEvents(): Promise<void> {
    for (const chain of this.config.monitoredChains) {
      try {
        const events = await this.fetchLiquidityEvents(chain);
        for (const liq of events) {
          const event: LiquidityChangeEvent = {
            id: randomUUID(),
            type: 'liquidity_change',
            chain,
            timestamp: Date.now(),
            metadata: {},
            poolAddress: liq.poolAddress,
            tokenPair: [tokenAddress(liq.token0), tokenAddress(liq.token1)],
            amount: liq.amount,
            amountUsd: liq.amountUsd,
            direction: liq.direction,
          };
          this.addEvent(event);
        }
      } catch (err) {
        this.logger.warn(
          { chain: chain as number, error: (err as Error).message },
          'Failed to poll liquidity events',
        );
      }
    }
  }

  private async pollGasPrices(): Promise<void> {
    for (const chain of this.config.monitoredChains) {
      try {
        const gas = await this.fetchGasPrice(chain);
        const prevGas = this.previousGasPrices.get(chain as number);

        this.gasPrices.set(chain as number, {
          gasPriceGwei: gas.gasPriceGwei,
          baseFeeGwei: gas.baseFeeGwei,
          priorityFeeGwei: gas.priorityFeeGwei,
          updatedAt: Date.now(),
        });

        // Emit event if gas changed >20%
        if (prevGas !== undefined && prevGas > 0) {
          const changePercent = Math.abs((gas.gasPriceGwei - prevGas) / prevGas) * 100;
          if (changePercent >= 20) {
            const event: GasUpdateEvent = {
              id: randomUUID(),
              type: 'gas_update',
              chain,
              timestamp: Date.now(),
              metadata: { changePercent },
              gasPriceGwei: gas.gasPriceGwei,
              baseFeeGwei: gas.baseFeeGwei,
              priorityFeeGwei: gas.priorityFeeGwei,
            };
            this.addEvent(event);
          }
        }

        this.previousGasPrices.set(chain as number, gas.gasPriceGwei);
      } catch (err) {
        this.logger.warn(
          { chain: chain as number, error: (err as Error).message },
          'Failed to fetch gas price',
        );
      }
    }
  }

  private async detectFlowPatterns(): Promise<void> {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000; // 1 hour

    for (const [key, entries] of this.flowWindows) {
      // Prune old entries
      const recent = entries.filter((e) => now - e.timestamp <= windowMs);
      this.flowWindows.set(key, recent);

      if (recent.length < 10) continue; // Need minimum transactions

      const buys = recent.filter((e) => e.direction === 'buy');
      const sells = recent.filter((e) => e.direction === 'sell');

      const buyVolume = buys.reduce((sum, e) => sum + e.volumeUsd, 0);
      const sellVolume = sells.reduce((sum, e) => sum + e.volumeUsd, 0);

      if (buyVolume === 0 && sellVolume === 0) continue;

      const volumeRatio = sellVolume > 0 ? buyVolume / sellVolume : buyVolume > 0 ? Infinity : 1;
      let patternType: 'accumulation' | 'distribution' | null = null;

      if (volumeRatio > 2) {
        patternType = 'accumulation';
      } else if (volumeRatio < 0.5) {
        patternType = 'distribution';
      }

      if (!patternType) continue;

      // Confidence: based on transaction count and ratio magnitude
      const txCountFactor = Math.min(recent.length / 50, 1); // More txs = higher confidence
      const ratioFactor = patternType === 'accumulation'
        ? Math.min((volumeRatio - 2) / 3, 1) // Ratio 2-5 maps to 0-1
        : Math.min((1 / volumeRatio - 2) / 3, 1);
      const confidenceScore = 0.5 * txCountFactor + 0.5 * ratioFactor;

      if (confidenceScore < 0.6) continue;

      // Parse chain and token from key
      const parts = key.split('-');
      const chain = chainId(parseInt(parts[0]!, 10));
      const token = tokenAddress(parts.slice(1).join('-'));

      const event: FlowPatternEvent = {
        id: randomUUID(),
        type: 'flow_pattern',
        chain,
        timestamp: now,
        metadata: {},
        token,
        patternType,
        confidenceScore,
        buyCount: buys.length,
        sellCount: sells.length,
        volumeRatio,
      };
      this.addEvent(event);
    }
  }

  private async pollApyUpdates(): Promise<void> {
    for (const protocol of this.config.monitoredProtocols) {
      for (const chain of this.config.monitoredChains) {
        try {
          const apyData = await this.fetchApyRates(protocol, chain);
          for (const { asset, apy } of apyData) {
            const snapshotKey = `${protocol}-${chain as number}-${asset as string}`;
            const previousApy = this.apySnapshots.get(snapshotKey);

            if (previousApy !== undefined && previousApy !== apy) {
              const event: ApyUpdateEvent = {
                id: randomUUID(),
                type: 'apy_update',
                chain,
                timestamp: Date.now(),
                metadata: {},
                protocol,
                asset,
                oldApy: previousApy,
                newApy: apy,
              };
              this.addEvent(event);
            }

            this.apySnapshots.set(snapshotKey, apy);
          }
        } catch (err) {
          this.logger.warn(
            { protocol, chain: chain as number, error: (err as Error).message },
            'Failed to fetch APY rates',
          );
        }
      }
    }
  }

  // --- Ring buffer management ---

  private addEvent(event: ConcreteOnChainEvent): void {
    this.eventBuffer.push(event);

    // Prune if over retention limit
    if (this.eventBuffer.length > this.config.maxEventRetention) {
      const excess = this.eventBuffer.length - this.config.maxEventRetention;
      this.eventBuffer.splice(0, excess);
    }

    // Emit for real-time consumers
    this.events.emit('event', event);
    this.events.emit(event.type, event);

    this.logger.debug(
      { type: event.type, chain: event.chain as number, id: event.id },
      'On-chain event emitted',
    );
  }

  // --- Data source abstractions (mockable in tests) ---

  async fetchProtocolTvl(_protocol: string, _chain: ChainId): Promise<number> {
    // In production, this would call DeFiLlama or protocol APIs
    // For now, return simulated data — strategies will override via dependency injection
    return 0;
  }

  async fetchWhaleTransactions(
    _chain: ChainId,
  ): Promise<
    Array<{
      txHash: string;
      wallet: string;
      token: string;
      amount: bigint;
      amountUsd: number;
      direction: 'buy' | 'sell';
      dex: string;
    }>
  > {
    // In production, this would query block explorers or RPC event logs
    return [];
  }

  async fetchLiquidityEvents(
    _chain: ChainId,
  ): Promise<
    Array<{
      poolAddress: string;
      token0: string;
      token1: string;
      amount: bigint;
      amountUsd: number;
      direction: 'add' | 'remove';
    }>
  > {
    // In production, this would monitor DEX pool events
    return [];
  }

  async fetchGasPrice(
    _chain: ChainId,
  ): Promise<{ gasPriceGwei: number; baseFeeGwei: number; priorityFeeGwei: number }> {
    // In production, this would call eth_gasPrice / eth_feeHistory via RPC
    return { gasPriceGwei: 0, baseFeeGwei: 0, priorityFeeGwei: 0 };
  }

  async fetchApyRates(
    _protocol: string,
    _chain: ChainId,
  ): Promise<Array<{ asset: TokenAddress; apy: number }>> {
    // In production, this would query protocol APIs for current APY rates
    return [];
  }

  // --- Public method to add flow data (called by external data sources) ---

  addFlowEntry(chain: ChainId, token: TokenAddress, entry: FlowWindowEntry): void {
    const key = `${chain as number}-${token as string}`;
    const existing = this.flowWindows.get(key) ?? [];
    existing.push(entry);
    this.flowWindows.set(key, existing);
  }

  // --- Reset for tests ---

  resetState(): void {
    this.eventBuffer.length = 0;
    this.tvlSnapshots.clear();
    this.gasPrices.clear();
    this.previousGasPrices.clear();
    this.seenTxHashes.clear();
    this.flowWindows.clear();
    this.apySnapshots.clear();
    this.events.removeAllListeners();
  }
}
