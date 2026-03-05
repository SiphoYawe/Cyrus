// REST handler: GET /api/strategies/yield/opportunities

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';

interface YieldOpportunity {
  protocol: string;
  chain: number;
  chainName: string;
  token: string;
  apy: number;
  tvl: number;
  risk: 'low' | 'medium' | 'high';
}

const YIELD_DATA: YieldOpportunity[] = [
  { protocol: 'Aave V3', chain: 1, chainName: 'Ethereum', token: 'USDC', apy: 3.2, tvl: 2_000_000_000, risk: 'low' },
  { protocol: 'Aave V3', chain: 42161, chainName: 'Arbitrum', token: 'USDC', apy: 4.1, tvl: 500_000_000, risk: 'low' },
  { protocol: 'Aave V3', chain: 10, chainName: 'Optimism', token: 'USDC', apy: 3.8, tvl: 300_000_000, risk: 'low' },
  { protocol: 'Morpho', chain: 1, chainName: 'Ethereum', token: 'USDC', apy: 5.5, tvl: 800_000_000, risk: 'medium' },
  { protocol: 'Morpho', chain: 8453, chainName: 'Base', token: 'USDC', apy: 6.2, tvl: 200_000_000, risk: 'medium' },
  { protocol: 'Euler', chain: 1, chainName: 'Ethereum', token: 'USDC', apy: 4.8, tvl: 400_000_000, risk: 'medium' },
  { protocol: 'Lido', chain: 1, chainName: 'Ethereum', token: 'ETH', apy: 3.5, tvl: 15_000_000_000, risk: 'low' },
  { protocol: 'EtherFi', chain: 1, chainName: 'Ethereum', token: 'ETH', apy: 4.2, tvl: 3_000_000_000, risk: 'medium' },
  { protocol: 'Ethena', chain: 1, chainName: 'Ethereum', token: 'USDe', apy: 8.5, tvl: 1_500_000_000, risk: 'high' },
  { protocol: 'Pendle', chain: 42161, chainName: 'Arbitrum', token: 'ETH', apy: 7.1, tvl: 600_000_000, risk: 'high' },
];

export function createYieldOpportunitiesHandler() {
  return function handleYieldOpportunities(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return Promise.resolve();
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const tokenFilter = url.searchParams.get('token');
    const chainFilter = url.searchParams.get('chain');
    const riskFilter = url.searchParams.get('risk');

    let results = [...YIELD_DATA];

    if (tokenFilter) {
      results = results.filter((o) => o.token.toLowerCase() === tokenFilter.toLowerCase());
    }
    if (chainFilter) {
      const chainId = parseInt(chainFilter, 10);
      if (!isNaN(chainId)) {
        results = results.filter((o) => o.chain === chainId);
      }
    }
    if (riskFilter) {
      results = results.filter((o) => o.risk === riskFilter.toLowerCase());
    }

    results.sort((a, b) => b.apy - a.apy);

    sendSuccess(res, { opportunities: results, count: results.length });
    return Promise.resolve();
  };
}
