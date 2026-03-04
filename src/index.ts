import { initSentry, captureError, Sentry } from './utils/sentry.js';

initSentry();

import { loadConfig } from './core/config.js';
import { createLogger } from './utils/logger.js';
import { Store } from './core/store.js';
import { PersistenceService } from './core/persistence.js';
import { ActionQueue } from './core/action-queue.js';
import { ExecutorOrchestrator } from './executors/executor-orchestrator.js';
import { CyrusAgent } from './core/cyrus-agent.js';
import { AgentRestServer } from './core/rest-server.js';
import { AgentWebSocketServer } from './core/ws-server.js';

const logger = createLogger('main');

async function main(): Promise<void> {
  const { config, secrets } = loadConfig();

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

  // 3. Executor orchestrator + action queue (no executors registered yet — strategies will enqueue actions)
  const orchestrator = new ExecutorOrchestrator();
  const actionQueue = new ActionQueue();

  // 4. Agent (OODA loop — processes queued actions each tick)
  const agent = new CyrusAgent({
    config,
    actionQueue,
    executorOrchestrator: orchestrator,
  });

  // 5. REST server
  const restServer = new AgentRestServer({
    port: config.rest.port,
    corsOrigin: config.rest.corsOrigin,
    store,
    persistence,
    config,
  });

  // Start REST first so HTTP server is listening
  await restServer.start();

  // 6. WebSocket server — attach to same HTTP server (single port for Railway/cloud)
  const wsServer = new AgentWebSocketServer({
    httpServer: restServer.httpServer,
  });

  await wsServer.start();
  wsServer.subscribeToStore(store);

  // Start agent loop (non-blocking — runs in background)
  const agentPromise = agent.start();
  logger.info('Cyrus agent OODA loop started');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    agent.stop();
    await agentPromise;
    await wsServer.stop();
    await restServer.stop();
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
