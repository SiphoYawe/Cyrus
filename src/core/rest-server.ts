import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../utils/logger.js';
import { captureError } from '../utils/sentry.js';
import type { Store } from './store.js';
import type { PersistenceService } from './persistence.js';
import type { CyrusConfig } from './config.js';
import { sendError, ERROR_CODES } from './rest-types.js';
import { createHealthHandler } from './rest-handlers/health-handler.js';
import { createPortfolioHandler } from './rest-handlers/portfolio-handler.js';
import { createActivityHandler } from './rest-handlers/activity-handler.js';
import { createStrategiesHandler } from './rest-handlers/strategies-handler.js';
import { createConfigHandler } from './rest-handlers/config-handler.js';
import { createAnalyticsHandler } from './rest-handlers/analytics-handler.js';

const logger = createLogger('rest-server');

export interface AgentRestServerDeps {
  readonly port: number;
  readonly corsOrigin: string;
  readonly store: Store;
  readonly persistence: PersistenceService;
  readonly config: CyrusConfig;
  readonly agent?: { getTickCount: () => number; isRunning: () => boolean };
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export class AgentRestServer {
  private readonly server: Server;
  private readonly port: number;
  private readonly corsOrigin: string;
  private readonly routes: Map<string, RouteHandler>;

  constructor(deps: AgentRestServerDeps) {
    this.port = deps.port;
    this.corsOrigin = deps.corsOrigin;

    // Register route handlers
    this.routes = new Map<string, RouteHandler>();
    this.routes.set('/api/health', createHealthHandler(deps.agent));
    this.routes.set('/api/portfolio', createPortfolioHandler(deps.store));
    this.routes.set('/api/activity', createActivityHandler(deps.persistence));
    this.routes.set('/api/strategies', createStrategiesHandler(deps.store, deps.config));
    this.routes.set('/api/config', createConfigHandler(deps.config));
    this.routes.set('/api/analytics', createAnalyticsHandler(deps.store));

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Set CORS headers on every response
    res.setHeader('Access-Control-Allow-Origin', this.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

    const handler = this.routes.get(pathname);

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
      this.server.once('error', reject);
      this.server.listen(this.port, () => {
        const addr = this.server.address();
        const boundPort = typeof addr === 'object' && addr ? addr.port : this.port;
        logger.info({ port: boundPort }, 'REST server listening');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
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
