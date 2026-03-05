'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import { useAgentStore } from '@/stores/agent-store';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const REVALIDATE_INTERVAL_MS = 30_000;

export interface ConfigResponse {
  mode: string;
  tickIntervalMs: number;
  logLevel: string;
  integrator: string;
  risk: {
    defaultSlippage: number;
    maxGasCostUsd: number;
    maxPositionSizeUsd: number;
    maxConcurrentTransfers: number;
    drawdownThreshold: number;
  };
  chains: {
    enabled: number[];
    rpcUrls: Record<string, string>;
  };
  strategies: {
    enabled: string[];
    directory: string;
  };
  composer: {
    enabled: boolean;
    supportedProtocols: string[];
    defaultSlippage: number;
  };
  ws: { port: number; enabled: boolean };
  rest: { port: number; enabled: boolean; corsOrigin: string };
  dbPath: string;
  envOverrides: string[];
  secretsConfigured: {
    lifiApiKey: boolean;
    anthropicApiKey: boolean;
    privateKey: boolean;
  };
  requiresRestart?: boolean;
  [key: string]: unknown;
}

export interface UseConfigResult {
  config: ConfigResponse | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
  updateConfig: (patch: Record<string, unknown>) => Promise<ConfigResponse | null>;
}

export function useConfig(): UseConfigResult {
  const setConfig = useAgentStore((s) => s.setConfig);
  const [config, setLocalConfig] = useState<ConfigResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Track whether the last update was initiated by this hook (to avoid refetch loops)
  const selfUpdateRef = useRef(false);

  const fetchConfig = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/config`, {
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`Config fetch failed: ${res.status}`);
      }

      const json = (await res.json()) as { ok: boolean; data: ConfigResponse };
      if (json.ok && json.data) {
        selfUpdateRef.current = true;
        setLocalConfig(json.data);
        setError(null);
        // Sync to agent store
        setConfig({
          mode: json.data.mode,
          tickIntervalMs: json.data.tickIntervalMs,
          chains: json.data.chains.enabled,
          strategies: json.data.strategies.enabled,
          riskLevel: (json.data as Record<string, unknown>).riskLevel as number ?? 5,
        });
        selfUpdateRef.current = false;
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [setConfig]);

  const updateConfig = useCallback(
    async (patch: Record<string, unknown>): Promise<ConfigResponse | null> => {
      try {
        const res = await fetch(`${API_URL}/api/config`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });

        const json = (await res.json()) as { ok: boolean; data: ConfigResponse; error?: { message: string } };

        if (!res.ok || !json.ok) {
          const message = json.error?.message ?? `Config update failed: ${res.status}`;
          throw new Error(message);
        }

        selfUpdateRef.current = true;
        setLocalConfig(json.data);
        setError(null);

        // Sync to agent store
        if (json.data) {
          setConfig({
            mode: json.data.mode,
            tickIntervalMs: json.data.tickIntervalMs,
            chains: json.data.chains.enabled,
            strategies: json.data.strategies.enabled,
            riskLevel: (json.data as Record<string, unknown>).riskLevel as number ?? 5,
          });
        }
        selfUpdateRef.current = false;

        return json.data;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      }
    },
    [setConfig],
  );

  // Fetch on mount + poll
  useEffect(() => {
    void fetchConfig();

    const interval = setInterval(() => {
      void fetchConfig();
    }, REVALIDATE_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [fetchConfig]);

  // Subscribe to config.updated WS events (from other clients).
  // The agent store handles CONFIG_UPDATED events via the ws-provider.
  // When that happens, refetch the full config to get envOverrides, secretsConfigured, etc.
  useEffect(() => {
    let prevConfig = useAgentStore.getState().config;
    const unsub = useAgentStore.subscribe((state) => {
      if (state.config !== prevConfig && !selfUpdateRef.current) {
        prevConfig = state.config;
        void fetchConfig();
      }
      prevConfig = state.config;
    });
    return unsub;
  }, [fetchConfig]);

  return {
    config,
    isLoading,
    error,
    refetch: fetchConfig,
    updateConfig,
  };
}
