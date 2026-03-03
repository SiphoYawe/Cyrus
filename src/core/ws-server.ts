import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '../utils/logger.js';
import type { Store, StoreEventName } from './store.js';
import type { WsEventEnvelope, WsCommand } from './ws-types.js';
import { WS_EVENT_TYPES, WS_COMMANDS, createEventEnvelope } from './ws-types.js';

const logger = createLogger('ws-server');

const HEARTBEAT_INTERVAL_MS = 30_000;

// BigInt-safe JSON serializer: converts bigint values to strings
function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    typeof val === 'bigint' ? val.toString() : (val as unknown),
  );
}

// Store event name -> WS event type mapping
const STORE_EVENT_MAP: Record<StoreEventName, string> = {
  'balance.updated': WS_EVENT_TYPES.STATE_BALANCE_UPDATED,
  'transfer.created': WS_EVENT_TYPES.STATE_TRANSFER_CREATED,
  'transfer.updated': WS_EVENT_TYPES.STATE_TRANSFER_UPDATED,
  'transfer.completed': WS_EVENT_TYPES.STATE_TRANSFER_COMPLETED,
  'position.updated': WS_EVENT_TYPES.STATE_POSITION_UPDATED,
  'price.updated': WS_EVENT_TYPES.STATE_PRICE_UPDATED,
  'regime_changed': WS_EVENT_TYPES.AI_REGIME_CHANGED,
  'regime_detection_failed': WS_EVENT_TYPES.AI_REGIME_DETECTION_FAILED,
  'strategy_selection_changed': WS_EVENT_TYPES.AI_STRATEGY_SELECTION_CHANGED,
};

// Valid command values for validation
const VALID_COMMANDS = new Set<string>(Object.values(WS_COMMANDS));

// Track alive status on WebSocket instances
const aliveMap = new WeakMap<WebSocket, boolean>();

export interface AgentWebSocketServerOptions {
  port: number;
}

type CommandHandler = (payload: unknown) => Promise<unknown>;

export class AgentWebSocketServer {
  private readonly port: number;
  private server: WebSocketServer | null = null;
  private readonly clients: Set<WebSocket> = new Set();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly commandHandlers: Map<string, CommandHandler> = new Map();
  private readonly storeListeners: Array<{ event: StoreEventName; handler: (...args: unknown[]) => void }> = [];
  private subscribedStore: Store | null = null;

  constructor(options: AgentWebSocketServerOptions) {
    this.port = options.port;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = new WebSocketServer({ port: this.port });

        this.server.on('listening', () => {
          const addr = this.server!.address();
          const boundPort = typeof addr === 'object' && addr !== null ? addr.port : this.port;
          logger.info({ port: boundPort }, 'WebSocket server started');
          this.startHeartbeat();
          resolve();
        });

        this.server.on('error', (err) => {
          logger.error({ err }, 'WebSocket server error');
          reject(err);
        });

        this.server.on('connection', (ws: WebSocket) => {
          this.handleConnection(ws);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.stopHeartbeat();
      this.unsubscribeFromStore();

      // Close all client connections
      for (const client of this.clients) {
        try {
          client.close(1001, 'Server shutting down');
        } catch {
          // Ignore errors during close
        }
      }
      this.clients.clear();

      if (this.server) {
        this.server.close(() => {
          logger.info('WebSocket server stopped');
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  subscribeToStore(store: Store): void {
    // Unsubscribe from previous store if any
    this.unsubscribeFromStore();
    this.subscribedStore = store;

    for (const [storeEvent, wsEvent] of Object.entries(STORE_EVENT_MAP)) {
      const handler = (data: unknown) => {
        const envelope = createEventEnvelope(wsEvent, data);
        this.broadcast(envelope);
      };

      store.emitter.on(storeEvent, handler);
      this.storeListeners.push({
        event: storeEvent as StoreEventName,
        handler,
      });
    }

    logger.debug('Subscribed to store events');
  }

  broadcast(envelope: WsEventEnvelope): void {
    if (this.clients.size === 0) {
      return;
    }

    const message = safeStringify(envelope);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  sendTo(client: WebSocket, envelope: WsEventEnvelope): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(safeStringify(envelope));
    }
  }

  registerCommandHandler(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }

  emitAgentEvent(event: string, data: unknown): void {
    const envelope = createEventEnvelope(event, data);
    this.broadcast(envelope);
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getPort(): number {
    if (this.server) {
      const addr = this.server.address();
      if (typeof addr === 'object' && addr !== null) {
        return addr.port;
      }
    }
    return this.port;
  }

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
    aliveMap.set(ws, true);

    logger.info({ clientCount: this.clients.size }, 'Client connected');

    ws.on('message', (raw: Buffer | string) => {
      this.handleMessage(ws, raw);
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      aliveMap.delete(ws);
      logger.info({ clientCount: this.clients.size }, 'Client disconnected');
    });

    ws.on('error', (err: Error) => {
      logger.warn({ err }, 'Client connection error');
      this.clients.delete(ws);
      aliveMap.delete(ws);
    });

    ws.on('pong', () => {
      aliveMap.set(ws, true);
    });
  }

  private handleMessage(ws: WebSocket, raw: Buffer | string): void {
    let parsed: WsCommand;

    try {
      parsed = JSON.parse(raw.toString()) as WsCommand;
    } catch {
      const errorEnvelope = createEventEnvelope(WS_EVENT_TYPES.COMMAND_ERROR, {
        error: 'Invalid JSON',
      });
      this.sendTo(ws, errorEnvelope);
      return;
    }

    if (!parsed.command || typeof parsed.command !== 'string') {
      const errorEnvelope = createEventEnvelope(WS_EVENT_TYPES.COMMAND_ERROR, {
        error: 'Missing or invalid "command" field',
        requestId: parsed.requestId,
      });
      this.sendTo(ws, errorEnvelope);
      return;
    }

    if (!VALID_COMMANDS.has(parsed.command)) {
      const errorEnvelope = createEventEnvelope(WS_EVENT_TYPES.COMMAND_ERROR, {
        error: `Unknown command: ${parsed.command}`,
        requestId: parsed.requestId,
      });
      this.sendTo(ws, errorEnvelope);
      return;
    }

    const handler = this.commandHandlers.get(parsed.command);
    if (!handler) {
      const errorEnvelope = createEventEnvelope(WS_EVENT_TYPES.COMMAND_ERROR, {
        error: `No handler registered for command: ${parsed.command}`,
        requestId: parsed.requestId,
      });
      this.sendTo(ws, errorEnvelope);
      return;
    }

    handler(parsed.payload)
      .then((result) => {
        const responseEnvelope = createEventEnvelope(WS_EVENT_TYPES.COMMAND_RESPONSE, {
          command: parsed.command,
          result,
          requestId: parsed.requestId,
        });
        this.sendTo(ws, responseEnvelope);
      })
      .catch((err: Error) => {
        const errorEnvelope = createEventEnvelope(WS_EVENT_TYPES.COMMAND_ERROR, {
          command: parsed.command,
          error: err.message,
          requestId: parsed.requestId,
        });
        this.sendTo(ws, errorEnvelope);
      });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (aliveMap.get(client) === false) {
          logger.debug('Terminating dead client connection');
          client.terminate();
          this.clients.delete(client);
          aliveMap.delete(client);
          continue;
        }

        aliveMap.set(client, false);
        client.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private unsubscribeFromStore(): void {
    if (this.subscribedStore) {
      for (const { event, handler } of this.storeListeners) {
        this.subscribedStore.emitter.removeListener(event, handler);
      }
      this.storeListeners.length = 0;
      this.subscribedStore = null;
    }
  }
}
