// OpenClaw Yield Tool — Returns yield opportunities across chains and protocols

import type { OpenClawPlugin } from '../plugin.js';
import type { OpenClawToolDefinition, OpenClawToolResult } from '../types.js';

interface YieldOpportunity {
  readonly protocol: string;
  readonly chain: number;
  readonly chainName: string;
  readonly token: string;
  readonly apy: number;
  readonly tvl: number;
  readonly risk: 'low' | 'medium' | 'high';
}

// Static yield data — in production, this would come from the market data service
const YIELD_OPPORTUNITIES: YieldOpportunity[] = [
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

export function createYieldTool(plugin: OpenClawPlugin): OpenClawToolDefinition {
  return {
    name: 'yield',
    description: 'List yield opportunities across chains and protocols, sorted by APY',
    parameters: [
      { name: 'token', type: 'string', description: 'Filter by token symbol (e.g. USDC, ETH)', required: false },
      { name: 'chain', type: 'number', description: 'Filter by chain ID', required: false },
      { name: 'minApy', type: 'number', description: 'Minimum APY filter (e.g. 5 for 5%)', required: false },
      { name: 'risk', type: 'string', description: 'Filter by risk level: low, medium, high', required: false },
    ],
    handler: async (params): Promise<OpenClawToolResult> => {
      const tokenFilter = params.token as string | undefined;
      const chainFilter = params.chain as number | undefined;
      const minApy = params.minApy as number | undefined;
      const riskFilter = params.risk as string | undefined;

      let opportunities = [...YIELD_OPPORTUNITIES];

      if (tokenFilter) {
        opportunities = opportunities.filter(
          (o) => o.token.toLowerCase() === tokenFilter.toLowerCase(),
        );
      }
      if (chainFilter) {
        opportunities = opportunities.filter((o) => o.chain === chainFilter);
      }
      if (minApy !== undefined) {
        opportunities = opportunities.filter((o) => o.apy >= minApy);
      }
      if (riskFilter) {
        opportunities = opportunities.filter(
          (o) => o.risk === riskFilter.toLowerCase(),
        );
      }

      // Sort by APY descending
      opportunities.sort((a, b) => b.apy - a.apy);

      const bestApy = opportunities.length > 0 ? opportunities[0].apy : 0;
      const bestProtocol = opportunities.length > 0 ? opportunities[0].protocol : 'N/A';

      return {
        success: true,
        message: `Found ${opportunities.length} yield opportunity(ies). Best: ${bestApy}% APY on ${bestProtocol}`,
        data: {
          opportunities,
          count: opportunities.length,
          bestApy,
          bestProtocol,
        },
      };
    },
  };
}
