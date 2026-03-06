import { initSentry, captureError, Sentry } from './utils/sentry.js';

initSentry();

import { resolve } from 'node:path';
import { loadConfig } from './core/config.js';
import { ConfigManager, buildEnvOverrides } from './core/config-manager.js';
import { createLogger } from './utils/logger.js';
import { Store } from './core/store.js';
import { PersistenceService } from './core/persistence.js';
import { ActionQueue } from './core/action-queue.js';
import { ExecutorOrchestrator } from './executors/executor-orchestrator.js';
import { CyrusAgent } from './core/cyrus-agent.js';
import { AgentRestServer } from './core/rest-server.js';
import { AgentWebSocketServer } from './core/ws-server.js';

// Wallet
import { createWalletSetup } from './utils/wallet.js';

// Connectors
import { LiFiConnector } from './connectors/lifi-connector.js';
import { HyperliquidConnector } from './connectors/hyperliquid-connector.js';
import { PearProtocolConnector } from './connectors/pear-protocol-connector.js';

// Utility executors
import { ApprovalHandler } from './executors/approval-handler.js';
import { TransactionExecutor } from './executors/transaction-executor.js';
import { PreFlightChecker } from './executors/pre-flight-checks.js';

// Trading executors
import { SwapExecutor } from './executors/swap-executor.js';
import { BridgeExecutor } from './executors/bridge-executor.js';
import { ComposerExecutor } from './executors/composer-executor.js';
import { PerpExecutor } from './executors/perp-executor.js';
import { PairExecutor } from './executors/pair-executor.js';
import { StatArbPairExecutor } from './executors/stat-arb-pair-executor.js';
import { FundingBridgeExecutor } from './executors/funding-bridge-executor.js';
import { WithdrawalExecutor } from './executors/withdrawal-executor.js';
import { MarketMakerExecutor } from './executors/market-maker-executor.js';

// Data pipelines
import { MarketDataService } from './data/market-data-service.js';
import { ChainScout } from './data/chain-scout.js';
import { OnChainIndexer } from './data/on-chain-indexer.js';
import { SocialSentinel } from './data/social-sentinel.js';
import { SignalAggregator } from './data/signal-aggregator.js';
import { SocialEvaluator } from './data/evaluators/social-evaluator.js';

// Stat-arb pipeline
import { HourlyPriceFeed } from './stat-arb/hourly-price-feed.js';
import { UniverseScanner } from './stat-arb/universe-scanner.js';
import { HyperliquidOrderManager } from './connectors/hyperliquid-order-manager.js';
import { FundingRateTracker } from './stat-arb/funding-rate-tracker.js';
import { SignalGenerator } from './stat-arb/signal-generator.js';

// Controllers
import { FundingController } from './controllers/funding-controller.js';
import { WithdrawalController } from './controllers/withdrawal-controller.js';
import { FundingMutex } from './controllers/funding-mutex.js';

// Strategies
import { StrategyLoader } from './strategies/strategy-loader.js';
import { StrategyRunner } from './core/strategy-runner.js';
import type { CrossChainStrategy } from './strategies/cross-chain-strategy.js';
import { YieldHunter } from './strategies/builtin/yield-hunter.js';
import { LiquidStakingStrategy } from './strategies/builtin/liquid-staking.js';

// Types
import type { RunnableBase } from './core/runnable-base.js';

// OpenClaw gateway
import { OpenClawPlugin } from './openclaw/plugin.js';
import { createPortfolioTool } from './openclaw/tools/portfolio-tool.js';
import { createPositionsTool } from './openclaw/tools/positions-tool.js';
import { createStrategiesTool } from './openclaw/tools/strategies-tool.js';
import { createSwapTool } from './openclaw/tools/swap-tool.js';
import { createBridgeTool } from './openclaw/tools/bridge-tool.js';
import { createYieldTool } from './openclaw/tools/yield-tool.js';
import { createRiskDialTool } from './openclaw/tools/risk-dial-tool.js';
import { createHeartbeatTool } from './openclaw/tools/heartbeat-tool.js';
import { createReportTool } from './openclaw/tools/report-tool.js';
import { createTradePreviewTool } from './openclaw/tools/trade-preview-tool.js';
import { createTradeApproveTool } from './openclaw/tools/trade-approve-tool.js';

const logger = createLogger('main');

const ARBITRUM_CHAIN_ID = 42161;
const STAT_ARB_TOKENS = ['ETH', 'BTC', 'SOL', 'ARB', 'OP', 'AVAX', 'LINK', 'UNI', 'DOGE'] as const;

async function main(): Promise<void> {
  const { config, secrets } = loadConfig();
  const configManager = new ConfigManager(
    config,
    buildEnvOverrides(),
    resolve(process.cwd(), 'cyrus.config.json'),
  );

  logger.info(
    {
      mode: config.mode,
      tickIntervalMs: config.tickIntervalMs,
      integrator: config.integrator,
    },
    'Cyrus agent starting'
  );

  // 1. Store (singleton)
  const store = Store.getInstance();

  // 2. Persistence (auto-migrates DB, subscribes to store events, restores transfers)
  const persistence = new PersistenceService(config.dbPath, store);
  logger.info({ dbPath: config.dbPath }, 'Persistence initialized');

  // 3. Executor orchestrator + action queue
  const orchestrator = new ExecutorOrchestrator();
  const actionQueue = new ActionQueue();

  // 4. Agent (OODA loop — processes queued actions each tick)
  const agent = new CyrusAgent({
    config,
    actionQueue,
    executorOrchestrator: orchestrator,
  });

  // 5. OpenClaw plugin — register all 11 tools for gateway integration
  const openClawPlugin = new OpenClawPlugin({ store, config, persistence, agent });
  openClawPlugin.registerTool(createPortfolioTool(openClawPlugin));
  openClawPlugin.registerTool(createPositionsTool(openClawPlugin));
  openClawPlugin.registerTool(createStrategiesTool(openClawPlugin));
  openClawPlugin.registerTool(createSwapTool(openClawPlugin));
  openClawPlugin.registerTool(createBridgeTool(openClawPlugin));
  openClawPlugin.registerTool(createYieldTool(openClawPlugin));
  openClawPlugin.registerTool(createRiskDialTool(openClawPlugin));
  openClawPlugin.registerTool(createHeartbeatTool(openClawPlugin));
  openClawPlugin.registerTool(createReportTool(openClawPlugin));
  openClawPlugin.registerTool(createTradePreviewTool(openClawPlugin));
  openClawPlugin.registerTool(createTradeApproveTool(openClawPlugin));
  logger.info({ toolCount: openClawPlugin.getTools().length }, 'OpenClaw plugin initialized');

  // 6. REST server (ConfigManager wired later after wsServer is created)
  const restServer = new AgentRestServer({
    port: config.rest.port,
    corsOrigin: config.rest.corsOrigin,
    store,
    persistence,
    config,
    configManager,
    agent,
    openClawPlugin,
  });

  await restServer.start();

  // 6. WebSocket server — attach to same HTTP server (single port for Railway/cloud)
  const wsServer = new AgentWebSocketServer({
    httpServer: restServer.httpServer,
  });

  await wsServer.start();
  wsServer.subscribeToStore(store);

  // Wire wsServer to REST config handler for broadcasting config updates
  restServer.setWsServer(wsServer);

  // Wire ConfigManager listeners for hot-updatable fields
  configManager.onChange((newConfig) => {
    logger.info({ logLevel: newConfig.logLevel }, 'Config change detected, applying hot-updates');
    // Hot-update log level
    logger.level = newConfig.logLevel;
  });

  // --- Trading components (guarded on privateKey) ---

  // Outer-scope references for shutdown handler
  let strategyRunner: RunnableBase | null = null;
  let chainScout: RunnableBase | null = null;
  let onChainIndexer: RunnableBase | null = null;
  let socialSentinel: RunnableBase | null = null;
  let signalGenerator: RunnableBase | null = null;
  let strategyRunnerPromise: Promise<void> | null = null;
  let fundingController: RunnableBase | null = null;
  let withdrawalController: RunnableBase | null = null;
  let fundingMutex: FundingMutex | null = null;

  if (secrets.privateKey) {
    // 7a. Wallet setup
    const wallet = createWalletSetup({
      privateKey: secrets.privateKey,
      chainRpcUrls: config.chains.rpcUrls,
    });
    logger.info({ address: wallet.account.address }, 'Wallet initialized');

    // 7b. Connectors
    const lifiConnector = new LiFiConnector({ apiKey: secrets.lifiApiKey });
    const hlConnector = new HyperliquidConnector({
      walletAddress: wallet.account.address,
    });
    const pearConnector = new PearProtocolConnector({
      walletAddress: wallet.account.address,
    });

    // 7c. Utility executors (Arbitrum as primary chain)
    const publicClient = wallet.getPublicClient(ARBITRUM_CHAIN_ID);
    const walletClient = wallet.getWalletClient(ARBITRUM_CHAIN_ID);
    const approvalHandler = new ApprovalHandler(publicClient, walletClient);
    const txExecutor = new TransactionExecutor(publicClient, walletClient);
    const preFlightChecker = new PreFlightChecker();

    // 7d. Stat-arb dependencies (needed by StatArbPairExecutor)
    const priceFeed = new HourlyPriceFeed();
    const universeScanner = new UniverseScanner(
      { tokens: STAT_ARB_TOKENS },
      priceFeed,
      store,
    );
    const orderManager = new HyperliquidOrderManager(hlConnector);
    const fundingTracker = new FundingRateTracker(hlConnector);

    // 7e. Trading executors — register with orchestrator
    orchestrator.registerExecutor('swap', new SwapExecutor(
      lifiConnector, approvalHandler, txExecutor, preFlightChecker, store,
      { maxGasCostUsd: config.risk.maxGasCostUsd, defaultSlippage: config.risk.defaultSlippage },
    ));

    orchestrator.registerExecutor('bridge', new BridgeExecutor(
      lifiConnector, approvalHandler, txExecutor, preFlightChecker, store,
    ));

    orchestrator.registerExecutor('composer', new ComposerExecutor(
      lifiConnector, approvalHandler, txExecutor, preFlightChecker, store,
    ));

    orchestrator.registerExecutor('perp', new PerpExecutor(
      hlConnector,
      { maxLeverage: 20, defaultSlippage: 0.005, maxFundingRateThreshold: 0.01 },
    ));

    orchestrator.registerExecutor('pair', new PairExecutor(
      pearConnector,
      { maxLeverage: 20, maxOpenPositions: 5 },
    ));

    orchestrator.registerExecutor('stat_arb_pair', new StatArbPairExecutor(
      hlConnector, orderManager, fundingTracker,
    ));

    orchestrator.registerExecutor('funding_bridge', new FundingBridgeExecutor(
      lifiConnector, hlConnector, approvalHandler, txExecutor, preFlightChecker, store,
    ));

    orchestrator.registerExecutor('withdrawal', new WithdrawalExecutor(
      lifiConnector, hlConnector, approvalHandler, txExecutor, preFlightChecker, store,
    ));

    orchestrator.registerExecutor('market_make', new MarketMakerExecutor(
      { minCapitalUsd: 1000, maxSpread: 0.005, maxLevels: 5, staleOrderThreshold: 60, fillSimulation: false },
    ));

    // 7f. Data pipelines
    const indexerInstance = new OnChainIndexer();
    onChainIndexer = indexerInstance;
    indexerInstance.start().catch((err) =>
      logger.error({ error: err }, 'On-chain indexer crashed')
    );
    logger.info('On-chain indexer started');

    const marketDataService = new MarketDataService({
      mode: config.mode,
      connector: lifiConnector,
      onChainIndexer: indexerInstance,
    });
    await marketDataService.initialize();
    logger.info('Market data service initialized');

    const chainScoutInstance = new ChainScout({}, lifiConnector, store);
    chainScout = chainScoutInstance;
    chainScoutInstance.start().catch((err) =>
      logger.error({ error: err }, 'Chain scout crashed')
    );
    logger.info('Chain scout started');

    const sentinelInstance = new SocialSentinel();
    socialSentinel = sentinelInstance;
    sentinelInstance.start().catch((err) =>
      logger.error({ error: err }, 'Social sentinel crashed')
    );
    logger.info('Social sentinel started');

    // Wire SignalAggregator with SocialEvaluator (subscribes to social_signal events)
    const socialEvaluator = new SocialEvaluator(sentinelInstance);
    const signalAggregator = new SignalAggregator();
    signalAggregator.registerEvaluator(socialEvaluator);
    logger.info('Signal aggregator wired with social evaluator');

    // 7g. Stat-arb signal pipeline
    const signalGen = new SignalGenerator({}, universeScanner, priceFeed, store);
    signalGenerator = signalGen;
    signalGen.start().catch((err) =>
      logger.error({ error: err }, 'Signal generator crashed')
    );
    logger.info('Signal generator started');

    // 7h. Strategy loading
    const strategyLoader = new StrategyLoader();
    await strategyLoader.discoverAll();

    const strategies: CrossChainStrategy[] = [];
    for (const name of config.strategies.enabled) {
      try {
        const strategy = await strategyLoader.load(name);
        await strategy.onBotStart();
        strategies.push(strategy);
        logger.info({ strategy: name }, 'Strategy loaded and initialized');
      } catch (error) {
        logger.error({ strategy: name, error }, 'Failed to load strategy, skipping');
      }
    }

    // 7h-b. Yield data auto-population — initial load for yield-dependent strategies
    try {
      const [yieldOpportunities, stakingRates] = await Promise.all([
        marketDataService.fetchYieldOpportunities(),
        marketDataService.fetchStakingRates(),
      ]);
      for (const strategy of strategies) {
        if (strategy instanceof YieldHunter) {
          strategy.setYieldData(yieldOpportunities);
          logger.info({ count: yieldOpportunities.length }, 'Yield data injected into YieldHunter');
        }
        if (strategy instanceof LiquidStakingStrategy) {
          strategy.setStakingRates(stakingRates);
          logger.info({ count: stakingRates.length }, 'Staking rates injected into LiquidStakingStrategy');
        }
      }
    } catch (err) {
      logger.warn({ error: err }, 'Initial yield data population failed (non-fatal)');
    }

    // 7i. Strategy runner
    const runner = new StrategyRunner({
      strategies,
      marketDataService,
      actionQueue,
      tickIntervalMs: config.tickIntervalMs,
    });
    strategyRunner = runner;
    strategyRunnerPromise = runner.start();
    logger.info(
      { strategies: strategies.map((s) => s.name), tickIntervalMs: config.tickIntervalMs },
      'Strategy runner started'
    );

    // 7j. Funding & Withdrawal controllers (conditional on Hyperliquid config)
    if (process.env.HYPERLIQUID_WALLET_ADDRESS || hlConnector) {
      fundingMutex = new FundingMutex();

      const fc = new FundingController(store, actionQueue, undefined, fundingMutex);
      fundingController = fc;
      fc.start().catch((err) =>
        logger.error({ error: err }, 'Funding controller crashed')
      );
      logger.info('Funding controller started');

      const wc = new WithdrawalController(
        store, actionQueue, hlConnector, undefined, fundingMutex,
      );
      withdrawalController = wc;
      wc.start().catch((err) =>
        logger.error({ error: err }, 'Withdrawal controller crashed')
      );
      logger.info('Withdrawal controller started');
    } else {
      logger.info('FundingController: DISABLED (no Hyperliquid config)');
      logger.info('WithdrawalController: DISABLED (no Hyperliquid config)');
    }

    // 7k. Notify dashboard
    wsServer.emitAgentEvent('AGENT_STARTED', {
      mode: config.mode,
      strategies: strategies.map((s) => s.name),
      chains: config.chains.enabled,
      walletAddress: wallet.account.address,
      timestamp: Date.now(),
    });
  } else {
    logger.warn('No CYRUS_PRIVATE_KEY set — running in monitoring-only mode (no trading)');
  }

  // Start agent OODA loop (non-blocking — runs in background)
  const agentPromise = agent.start();
  logger.info('Cyrus agent OODA loop started');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    // 1. Stop strategy runner first (stops enqueuing new actions)
    if (strategyRunner) {
      strategyRunner.stop();
      if (strategyRunnerPromise) await strategyRunnerPromise;
    }

    // 2. Stop controllers & data pipelines
    if (fundingController) fundingController.stop();
    if (withdrawalController) withdrawalController.stop();
    if (fundingMutex) fundingMutex.forceRelease();
    if (signalGenerator) signalGenerator.stop();
    if (chainScout) chainScout.stop();
    if (onChainIndexer) onChainIndexer.stop();
    if (socialSentinel) socialSentinel.stop();

    // 3. Stop agent (finishes processing current queue)
    agent.stop();
    await agentPromise;

    // 4. Servers (guard against already-stopped servers)
    try { await wsServer.stop(); } catch (err) {
      logger.debug({ error: err }, 'WebSocket server stop error (non-fatal)');
    }
    try { await restServer.stop(); } catch (err) {
      logger.debug({ error: err }, 'REST server stop error (non-fatal)');
    }

    // 5. Persistence
    persistence.close();

    logger.info('Cyrus agent shut down cleanly');
    await Sentry.close(2000);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info(
    {
      restPort: config.rest.port,
      wsPort: config.ws.port,
      mode: config.mode,
      chains: config.chains.enabled,
    },
    'Cyrus agent fully operational'
  );
}

main().catch(async (error) => {
  logger.fatal({ error }, 'Cyrus agent failed to start');
  captureError(error, { phase: 'startup' });
  await Sentry.close(2000);
  process.exit(1);
});
