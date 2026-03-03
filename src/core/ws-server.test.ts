import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { AgentWebSocketServer } from './ws-server.js';
import { Store } from './store.js';
import { chainId, tokenAddress } from './types.js';
import { WS_EVENT_TYPES, WS_COMMANDS, createEventEnvelope } from './ws-types.js';
import type { WsEventEnvelope } from './ws-types.js';

// Helper: create a WS client connected to the server, resolving when open
function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Helper: wait for the next message from a WS client
function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<WsEventEnvelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as WsEventEnvelope);
    });
  });
}

// Helper: small delay for event propagation
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AgentWebSocketServer', () => {
  let server: AgentWebSocketServer;
  let port: number;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    // Use port 0 to let OS pick a free port
    server = new AgentWebSocketServer({ port: 0 });
    await server.start();
    port = server.getPort();
  });

  afterEach(async () => {
    // Close all test clients
    for (const c of clients) {
      try {
        c.close();
      } catch {
        // ignore
      }
    }
    clients.length = 0;
    await server.stop();
  });

  function trackClient(ws: WebSocket): WebSocket {
    clients.push(ws);
    return ws;
  }

  // --- Connection handling ---

  describe('connection handling', () => {
    it('starts and accepts connections', async () => {
      const ws = trackClient(await connectClient(port));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(server.getClientCount()).toBe(1);
    });

    it('tracks multiple client connections', async () => {
      const ws1 = trackClient(await connectClient(port));
      const ws2 = trackClient(await connectClient(port));
      const ws3 = trackClient(await connectClient(port));

      expect(server.getClientCount()).toBe(3);
    });

    it('removes client on disconnect and updates count', async () => {
      const ws1 = trackClient(await connectClient(port));
      const ws2 = trackClient(await connectClient(port));

      expect(server.getClientCount()).toBe(2);

      // Close one client and wait for cleanup
      await new Promise<void>((resolve) => {
        ws1.on('close', () => resolve());
        ws1.close();
      });

      // Small delay for server to process the close event
      await delay(50);

      expect(server.getClientCount()).toBe(1);
    });
  });

  // --- Broadcast ---

  describe('broadcast', () => {
    it('sends envelope to all connected clients', async () => {
      const ws1 = trackClient(await connectClient(port));
      const ws2 = trackClient(await connectClient(port));

      const msg1Promise = waitForMessage(ws1);
      const msg2Promise = waitForMessage(ws2);

      const envelope = createEventEnvelope('test.broadcast', { value: 42 });
      server.broadcast(envelope);

      const [msg1, msg2] = await Promise.all([msg1Promise, msg2Promise]);

      expect(msg1.event).toBe('test.broadcast');
      expect(msg1.data).toEqual({ value: 42 });
      expect(typeof msg1.timestamp).toBe('number');

      expect(msg2.event).toBe('test.broadcast');
      expect(msg2.data).toEqual({ value: 42 });
    });

    it('does not error when no clients are connected (no buffering)', () => {
      expect(server.getClientCount()).toBe(0);

      // Should not throw
      const envelope = createEventEnvelope('test.nobuffer', { data: 'lost' });
      server.broadcast(envelope);
    });
  });

  // --- sendTo ---

  describe('sendTo', () => {
    it('sends envelope to a specific client only', async () => {
      const ws1 = trackClient(await connectClient(port));
      const ws2 = trackClient(await connectClient(port));

      // We need access to the server-side client reference.
      // Instead, use broadcast for ws1 and verify ws2 does not get it via sendTo indirectly.
      // Actually, sendTo is used internally. Let's test via command handling.
      // We'll test sendTo indirectly through command responses.

      const msg1Promise = waitForMessage(ws1);

      // Send a command from ws1 that has a registered handler
      server.registerCommandHandler(WS_COMMANDS.AGENT_STATUS, async () => {
        return { status: 'running' };
      });

      ws1.send(JSON.stringify({ command: WS_COMMANDS.AGENT_STATUS, requestId: 'req-1' }));

      const msg1 = await msg1Promise;
      expect(msg1.event).toBe(WS_EVENT_TYPES.COMMAND_RESPONSE);
      expect((msg1.data as Record<string, unknown>).result).toEqual({ status: 'running' });

      // ws2 should NOT receive this response (wait a bit to confirm)
      let ws2Received = false;
      ws2.once('message', () => {
        ws2Received = true;
      });

      await delay(100);
      expect(ws2Received).toBe(false);
    });
  });

  // --- Command handling ---

  describe('command handling', () => {
    it('routes valid command to registered handler', async () => {
      const ws = trackClient(await connectClient(port));

      server.registerCommandHandler(WS_COMMANDS.AGENT_STATUS, async (payload) => {
        return { status: 'idle', payload };
      });

      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({
        command: WS_COMMANDS.AGENT_STATUS,
        payload: { detail: true },
        requestId: 'req-42',
      }));

      const msg = await msgPromise;
      expect(msg.event).toBe(WS_EVENT_TYPES.COMMAND_RESPONSE);

      const data = msg.data as Record<string, unknown>;
      expect(data.command).toBe(WS_COMMANDS.AGENT_STATUS);
      expect(data.requestId).toBe('req-42');
      expect(data.result).toEqual({ status: 'idle', payload: { detail: true } });
    });

    it('returns error for invalid JSON', async () => {
      const ws = trackClient(await connectClient(port));

      const msgPromise = waitForMessage(ws);
      ws.send('not valid json {{{');

      const msg = await msgPromise;
      expect(msg.event).toBe(WS_EVENT_TYPES.COMMAND_ERROR);
      expect((msg.data as Record<string, unknown>).error).toBe('Invalid JSON');
    });

    it('returns error for unknown command', async () => {
      const ws = trackClient(await connectClient(port));

      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ command: 'unknown.command' }));

      const msg = await msgPromise;
      expect(msg.event).toBe(WS_EVENT_TYPES.COMMAND_ERROR);
      expect((msg.data as Record<string, unknown>).error).toContain('Unknown command');
    });

    it('returns error for missing command field', async () => {
      const ws = trackClient(await connectClient(port));

      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ payload: 'no command here' }));

      const msg = await msgPromise;
      expect(msg.event).toBe(WS_EVENT_TYPES.COMMAND_ERROR);
      expect((msg.data as Record<string, unknown>).error).toContain('Missing or invalid "command" field');
    });

    it('returns error when handler is not registered for a valid command', async () => {
      const ws = trackClient(await connectClient(port));

      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ command: WS_COMMANDS.AGENT_START, requestId: 'req-99' }));

      const msg = await msgPromise;
      expect(msg.event).toBe(WS_EVENT_TYPES.COMMAND_ERROR);
      expect((msg.data as Record<string, unknown>).error).toContain('No handler registered');
      expect((msg.data as Record<string, unknown>).requestId).toBe('req-99');
    });

    it('returns error when handler throws', async () => {
      const ws = trackClient(await connectClient(port));

      server.registerCommandHandler(WS_COMMANDS.AGENT_STOP, async () => {
        throw new Error('Something went wrong');
      });

      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ command: WS_COMMANDS.AGENT_STOP, requestId: 'req-err' }));

      const msg = await msgPromise;
      expect(msg.event).toBe(WS_EVENT_TYPES.COMMAND_ERROR);

      const data = msg.data as Record<string, unknown>;
      expect(data.error).toBe('Something went wrong');
      expect(data.command).toBe(WS_COMMANDS.AGENT_STOP);
      expect(data.requestId).toBe('req-err');
    });
  });

  // --- emitAgentEvent ---

  describe('emitAgentEvent', () => {
    it('broadcasts agent lifecycle events to all clients', async () => {
      const ws = trackClient(await connectClient(port));

      const msgPromise = waitForMessage(ws);
      server.emitAgentEvent(WS_EVENT_TYPES.AGENT_STARTED, { strategies: ['arb'] });

      const msg = await msgPromise;
      expect(msg.event).toBe(WS_EVENT_TYPES.AGENT_STARTED);
      expect(msg.data).toEqual({ strategies: ['arb'] });
      expect(typeof msg.timestamp).toBe('number');
    });
  });

  // --- Event envelope format ---

  describe('event envelope format', () => {
    it('all messages have event, data, and timestamp fields', async () => {
      const ws = trackClient(await connectClient(port));

      const msgPromise = waitForMessage(ws);
      server.emitAgentEvent(WS_EVENT_TYPES.AGENT_TICK, { tickNumber: 1 });

      const msg = await msgPromise;
      expect(msg).toHaveProperty('event');
      expect(msg).toHaveProperty('data');
      expect(msg).toHaveProperty('timestamp');
      expect(typeof msg.event).toBe('string');
      expect(typeof msg.timestamp).toBe('number');
    });
  });

  // --- Store subscription ---

  describe('subscribeToStore', () => {
    let store: Store;

    beforeEach(() => {
      Store.getInstance().reset();
      store = Store.getInstance();
    });

    afterEach(() => {
      store.reset();
    });

    it('forwards balance.updated events from store to clients', async () => {
      const ws = trackClient(await connectClient(port));
      server.subscribeToStore(store);

      const msgPromise = waitForMessage(ws);

      store.setBalance(
        chainId(1),
        tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        5000000n,
        5.0,
        'USDC',
        6,
      );

      const msg = await msgPromise;
      expect(msg.event).toBe(WS_EVENT_TYPES.STATE_BALANCE_UPDATED);
      expect((msg.data as Record<string, unknown>).symbol).toBe('USDC');
    });

    it('forwards transfer.created events from store to clients', async () => {
      const ws = trackClient(await connectClient(port));
      server.subscribeToStore(store);

      const msgPromise = waitForMessage(ws);

      store.createTransfer({
        txHash: '0xabc',
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
        amount: 1000n,
        bridge: 'stargate',
        quoteData: {},
      });

      const msg = await msgPromise;
      expect(msg.event).toBe(WS_EVENT_TYPES.STATE_TRANSFER_CREATED);
      expect((msg.data as Record<string, unknown>).bridge).toBe('stargate');
    });

    it('forwards price.updated events from store to clients', async () => {
      const ws = trackClient(await connectClient(port));
      server.subscribeToStore(store);

      const msgPromise = waitForMessage(ws);

      store.setPrice(
        chainId(1),
        tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        1.001,
      );

      const msg = await msgPromise;
      expect(msg.event).toBe(WS_EVENT_TYPES.STATE_PRICE_UPDATED);
      expect((msg.data as Record<string, unknown>).priceUsd).toBe(1.001);
    });

    it('does not broadcast store events when no clients connected', () => {
      server.subscribeToStore(store);

      // Should not throw with zero clients
      store.setBalance(
        chainId(1),
        tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        1000n,
        1.0,
        'USDC',
        6,
      );
    });
  });

  // --- getClientCount ---

  describe('getClientCount', () => {
    it('returns 0 when no clients are connected', () => {
      expect(server.getClientCount()).toBe(0);
    });

    it('accurately tracks connections', async () => {
      expect(server.getClientCount()).toBe(0);

      const ws1 = trackClient(await connectClient(port));
      expect(server.getClientCount()).toBe(1);

      const ws2 = trackClient(await connectClient(port));
      expect(server.getClientCount()).toBe(2);
    });

    it('decrements on disconnect', async () => {
      const ws1 = trackClient(await connectClient(port));
      const ws2 = trackClient(await connectClient(port));
      expect(server.getClientCount()).toBe(2);

      await new Promise<void>((resolve) => {
        ws1.on('close', () => resolve());
        ws1.close();
      });
      await delay(50);

      expect(server.getClientCount()).toBe(1);
    });
  });

  // --- Server stop ---

  describe('stop', () => {
    it('closes all connections on stop', async () => {
      const ws1 = trackClient(await connectClient(port));
      const ws2 = trackClient(await connectClient(port));

      const closed1 = new Promise<void>((resolve) => ws1.on('close', () => resolve()));
      const closed2 = new Promise<void>((resolve) => ws2.on('close', () => resolve()));

      await server.stop();

      await Promise.all([closed1, closed2]);

      expect(server.getClientCount()).toBe(0);
    });
  });
});
