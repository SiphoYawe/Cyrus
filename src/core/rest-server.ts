import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../utils/logger.js';
import { captureError } from '../utils/sentry.js';
import type { Store } from './store.js';
import type { PersistenceService } from './persistence.js';
import type { CyrusConfig } from './config.js';
import type { ConfigManager } from './config-manager.js';
import type { AgentWebSocketServer } from './ws-server.js';
import { sendSuccess, sendError, ERROR_CODES } from './rest-types.js';
import { createHealthHandler } from './rest-handlers/health-handler.js';
import { createPortfolioHandler } from './rest-handlers/portfolio-handler.js';
import { createActivityHandler } from './rest-handlers/activity-handler.js';
import { createStrategiesHandler } from './rest-handlers/strategies-handler.js';
import { createConfigHandler } from './rest-handlers/config-handler.js';
import { createAnalyticsHandler } from './rest-handlers/analytics-handler.js';
import { createYieldOpportunitiesHandler } from './rest-handlers/yield-handler.js';
import { createRiskStatusHandler } from './rest-handlers/risk-status-handler.js';
import { createPerformanceHandler } from './rest-handlers/performance-handler.js';
import { createDecisionsHandler } from './rest-handlers/decisions-handler.js';
import { createDetailedHealthHandler } from './rest-handlers/detailed-health-handler.js';
import {
  createActionsPreviewHandler,
  createActionsApproveHandler,
  createActionsDenyHandler,
} from './rest-handlers/actions-handler.js';
import { createBacktestingResultsHandler } from './rest-handlers/backtesting-handler.js';
import type { OpenClawPlugin } from '../openclaw/plugin.js';

const logger = createLogger('rest-server');

export interface AgentRestServerDeps {
  readonly port: number;
  readonly corsOrigin: string;
  readonly store: Store;
  readonly persistence: PersistenceService;
  readonly config: CyrusConfig;
  readonly configManager?: ConfigManager;
  readonly agent?: { getTickCount: () => number; isRunning: () => boolean };
  readonly openClawPlugin?: OpenClawPlugin;
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export class AgentRestServer {
  private readonly server: Server;
  private readonly port: number;
  private readonly corsOrigin: string;
  private readonly routes: Map<string, RouteHandler>;
  private readonly prefixRoutes: Map<string, RouteHandler>;
  private readonly configManager?: ConfigManager;

  constructor(deps: AgentRestServerDeps) {
    this.port = deps.port;
    this.corsOrigin = deps.corsOrigin;
    this.configManager = deps.configManager;

    // Register route handlers
    this.routes = new Map<string, RouteHandler>();
    this.prefixRoutes = new Map<string, RouteHandler>();
    this.routes.set('/api/health', createHealthHandler(deps.agent));
    this.routes.set('/api/portfolio', createPortfolioHandler(deps.store));
    this.routes.set('/api/activity', createActivityHandler(deps.persistence));
    this.routes.set('/api/strategies', createStrategiesHandler(deps.store, deps.config));

    // Config handler — starts without wsServer, upgraded via setWsServer()
    if (deps.configManager) {
      this.routes.set('/api/config', createConfigHandler(deps.configManager));
    } else {
      this.routes.set('/api/config', async (req, res) => {
        if (req.method !== 'GET') {
          sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
          return;
        }
        const { redactConfig } = await import('./config.js');
        sendSuccess(res, redactConfig(deps.config));
      });
    }

    this.routes.set('/api/analytics', createAnalyticsHandler(deps.store));

    // Epic 14: OpenClaw gateway REST endpoints
    this.routes.set('/api/strategies/yield/opportunities', createYieldOpportunitiesHandler());
    this.routes.set('/api/risk/status', createRiskStatusHandler(deps.store));
    this.routes.set('/api/strategies/performance', createPerformanceHandler(deps.store, deps.config));
    this.routes.set('/api/activity/decisions', createDecisionsHandler(deps.store));
    this.routes.set('/api/health/detailed', createDetailedHealthHandler(deps.store, deps.agent));
    this.routes.set('/api/backtesting/results', createBacktestingResultsHandler(deps.persistence));

    // Action preview/approve/deny — requires OpenClaw plugin
    if (deps.openClawPlugin) {
      this.routes.set('/api/actions/preview', createActionsPreviewHandler(deps.openClawPlugin));
      this.prefixRoutes.set('/api/actions/approve/', createActionsApproveHandler(deps.openClawPlugin));
      this.prefixRoutes.set('/api/actions/deny/', createActionsDenyHandler(deps.openClawPlugin));
    }

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Set CORS headers on every response
    res.setHeader('Access-Control-Allow-Origin', this.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Parse pathname from the URL
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // Try exact match first, then prefix match for parameterized routes
    let handler = this.routes.get(pathname);

    if (!handler) {
      // Check prefix routes (e.g., /api/actions/approve/:id)
      for (const [route, h] of this.prefixRoutes) {
        if (pathname.startsWith(route)) {
          handler = h;
          break;
        }
      }
    }

    if (!handler) {
      sendError(res, ERROR_CODES.NOT_FOUND, 'Endpoint not found', 404);
      return;
    }

    try {
      await handler(req, res);
    } catch (err) {
      logger.error({ err, pathname, method: req.method }, 'Unhandled error in route handler');
      captureError(err, { pathname, method: req.method });
      sendError(res, ERROR_CODES.INTERNAL_ERROR, 'Internal server error', 500);
    }
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.error(
            { port: this.port },
            `Port ${this.port} is already in use. Is another Cyrus instance running?`,
          );
        }
        reject(err);
      });
      this.server.listen(this.port, () => {
        const addr = this.server.address();
        const boundPort = typeof addr === 'object' && addr ? addr.port : this.port;
        logger.info({ port: boundPort }, 'REST server listening');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server.listening) {
      logger.debug('REST server already stopped, skipping close');
      return;
    }
    return new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          logger.info('REST server stopped');
          resolve();
        }
      });
    });
  }

  /** Upgrade config handler with wsServer reference for broadcasting config updates. */
  setWsServer(wsServer: AgentWebSocketServer): void {
    if (this.configManager) {
      this.routes.set('/api/config', createConfigHandler(this.configManager, wsServer));
    }
  }

  /** Returns the actual bound port (useful when started with port 0). */
  get boundPort(): number {
    const addr = this.server.address();
    if (typeof addr === 'object' && addr) {
      return addr.port;
    }
    return this.port;
  }

  /** Exposes the underlying HTTP server for WebSocket attachment. */
  get httpServer(): Server {
    return this.server;
  }
}
