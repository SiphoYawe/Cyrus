import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketClient } from '../ws-client';

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    setTimeout(() => this.onclose?.(), 0);
  }
}

describe('WebSocketClient', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    originalWebSocket = globalThis.WebSocket;
    // @ts-expect-error mock WebSocket
    globalThis.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  it('connects and reports connected status', async () => {
    const client = new WebSocketClient('ws://localhost:8080');
    const statuses: string[] = [];
    client.onStatusChange((s) => statuses.push(s));

    client.connect();
    await vi.advanceTimersByTimeAsync(10);

    expect(statuses).toContain('connecting');
    expect(statuses).toContain('connected');
    expect(client.status).toBe('connected');
    client.disconnect();
  });

  it('reports disconnected status after disconnect', async () => {
    const client = new WebSocketClient('ws://localhost:8080');
    client.connect();
    await vi.advanceTimersByTimeAsync(10);

    client.disconnect();
    await vi.advanceTimersByTimeAsync(10);

    expect(client.status).toBe('disconnected');
  });

  it('routes incoming messages to handlers', async () => {
    const client = new WebSocketClient('ws://localhost:8080');
    const messages: unknown[] = [];
    client.onMessage((e) => messages.push(e));

    client.connect();
    await vi.advanceTimersByTimeAsync(10);

    // Simulate incoming message by accessing the mock
    const ws = (client as unknown as { ws: MockWebSocket }).ws;
    ws.onmessage?.({
      data: JSON.stringify({ event: 'agent.tick', data: {}, timestamp: 123 }),
    });

    expect(messages).toHaveLength(1);
    expect((messages[0] as { event: string }).event).toBe('agent.tick');
    client.disconnect();
  });

  it('sends commands as JSON', async () => {
    const client = new WebSocketClient('ws://localhost:8080');
    client.connect();
    await vi.advanceTimersByTimeAsync(10);

    client.send({ command: 'agent.start' });

    const ws = (client as unknown as { ws: MockWebSocket }).ws;
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ command: 'agent.start' });
    client.disconnect();
  });

  it('unsubscribe removes handler', async () => {
    const client = new WebSocketClient('ws://localhost:8080');
    const messages: unknown[] = [];
    const unsub = client.onMessage((e) => messages.push(e));

    client.connect();
    await vi.advanceTimersByTimeAsync(10);

    unsub();

    const ws = (client as unknown as { ws: MockWebSocket }).ws;
    ws.onmessage?.({
      data: JSON.stringify({ event: 'test', data: {}, timestamp: 0 }),
    });

    expect(messages).toHaveLength(0);
    client.disconnect();
  });
});
