// REST handler: GET /api/risk/status

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store.js';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';
import { calculateTierAllocation } from '../../risk/risk-dial.js';
import type { RiskDialLevel } from '../../risk/types.js';

export interface RiskStatusResponse {
  currentDial: number;
  allocation: {
    safe: number;
    growth: number;
    degen: number;
    reserve: number;
  };
  circuitBreakerActive: boolean;
  activeTransfers: number;
  openPositions: number;
  regime: string | null;
}

export function createRiskStatusHandler(store: Store, getCurrentDial?: () => RiskDialLevel) {
  return function handleRiskStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return Promise.resolve();
    }

    const dial = getCurrentDial ? getCurrentDial() : (5 as RiskDialLevel);
    const allocation = calculateTierAllocation(dial);
    const regime = store.getLatestRegime();

    const data: RiskStatusResponse = {
      currentDial: dial,
      allocation,
      circuitBreakerActive: false,
      activeTransfers: store.getActiveTransfers().length,
      openPositions: store.getAllPositions().length,
      regime: regime?.regime ?? null,
    };

    sendSuccess(res, data);
    return Promise.resolve();
  };
}
