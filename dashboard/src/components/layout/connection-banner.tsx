'use client';

import { useSyncExternalStore } from 'react';
import { useWebSocket } from '@/providers/ws-provider';
import type { ConnectionStatus } from '@/lib/ws-client';

/**
 * Connection banner showing reconnecting/connected states.
 * Uses useSyncExternalStore to avoid setState-in-effect lint issues.
 */

type BannerState = 'hidden' | 'reconnecting' | 'connected';

function createBannerStore() {
  let state: BannerState = 'hidden';
  let prevStatus: ConnectionStatus = 'disconnected';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  function notify() {
    listeners.forEach((l) => l());
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return state;
    },
    update(status: ConnectionStatus) {
      if (status === 'reconnecting' || status === 'connecting') {
        if (timer) clearTimeout(timer);
        state = 'reconnecting';
        prevStatus = status;
        notify();
        return;
      }

      if (status === 'connected' && (prevStatus === 'reconnecting' || prevStatus === 'connecting')) {
        if (timer) clearTimeout(timer);
        state = 'connected';
        prevStatus = status;
        notify();
        timer = setTimeout(() => {
          state = 'hidden';
          timer = null;
          notify();
        }, 3000);
        return;
      }

      prevStatus = status;
      if (state !== 'hidden') {
        if (timer) clearTimeout(timer);
        state = 'hidden';
        notify();
      }
    },
  };
}

const bannerStore = createBannerStore();

export function ConnectionBanner() {
  const { status } = useWebSocket();
  bannerStore.update(status);

  const bannerState = useSyncExternalStore(
    bannerStore.subscribe,
    bannerStore.getSnapshot,
    () => 'hidden' as BannerState
  );

  if (bannerState === 'reconnecting') {
    return (
      <div className="flex items-center justify-center gap-2 bg-warning/20 px-4 py-2 text-sm text-warning">
        <span className="h-2 w-2 animate-pulse rounded-full bg-warning" />
        Reconnecting to agent...
      </div>
    );
  }

  if (bannerState === 'connected') {
    return (
      <div className="flex items-center justify-center gap-2 bg-positive/20 px-4 py-2 text-sm text-positive">
        <span className="h-2 w-2 rounded-full bg-positive" />
        Connected
      </div>
    );
  }

  return null;
}
