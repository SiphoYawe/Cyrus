'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { WebSocketClient, type ConnectionStatus } from '@/lib/ws-client';
import type { WsCommand } from '@/types/ws';
import { usePortfolioStore } from '@/stores/portfolio-store';
import { useTransfersStore } from '@/stores/transfers-store';
import { useAgentStore } from '@/stores/agent-store';
import { useChatStore } from '@/stores/chat-store';
import { useStrategiesStore } from '@/stores/strategies-store';

interface WsContextValue {
  status: ConnectionStatus;
  send: (command: WsCommand) => void;
}

const WsContext = createContext<WsContextValue>({
  status: 'disconnected',
  send: () => {},
});

export function useWebSocket(): WsContextValue {
  return useContext(WsContext);
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const clientRef = useRef<WebSocketClient | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  const send = useCallback((command: WsCommand) => {
    clientRef.current?.send(command);
  }, []);

  // Poll health endpoint to get initial agent status
  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
    let cancelled = false;

    const pollHealth = async () => {
      try {
        const res = await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok || cancelled) return;
        const body = await res.json();
        if (cancelled) return;
        const agentStatus = body?.data?.status;
        if (agentStatus === 'healthy') {
          useAgentStore.getState().setStatus('running');
        } else if (agentStatus === 'degraded') {
          useAgentStore.getState().setStatus('stopped');
        }
      } catch {
        // Backend unreachable — status stays unknown
      }
    };

    pollHealth();
    const interval = setInterval(pollHealth, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  useEffect(() => {
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8080';
    const client = new WebSocketClient(wsUrl);
    clientRef.current = client;

    const unsubStatus = client.onStatusChange(setStatus);

    const portfolioHandler = usePortfolioStore.getState().handleWsEvent;
    const transfersHandler = useTransfersStore.getState().handleWsEvent;
    const agentHandler = useAgentStore.getState().handleWsEvent;
    const chatHandler = useChatStore.getState().handleWsEvent;
    const strategiesHandler = useStrategiesStore.getState().handleWsEvent;

    const unsubMessage = client.onMessage((event) => {
      portfolioHandler(event);
      transfersHandler(event);
      agentHandler(event);
      chatHandler(event);
      strategiesHandler(event);
    });

    client.connect();

    return () => {
      unsubStatus();
      unsubMessage();
      client.disconnect();
    };
  }, []);

  return (
    <WsContext.Provider value={{ status, send }}>
      {children}
    </WsContext.Provider>
  );
}
