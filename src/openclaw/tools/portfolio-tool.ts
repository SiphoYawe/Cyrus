// OpenClaw Portfolio Tool — Returns portfolio overview via conversational gateway

import type { OpenClawPlugin } from '../plugin.js';
import type { OpenClawToolDefinition, OpenClawToolResult } from '../types.js';

export function createPortfolioTool(plugin: OpenClawPlugin): OpenClawToolDefinition {
  return {
    name: 'portfolio',
    description: 'Get current portfolio overview including balances, total value, and chain allocation',
    parameters: [
      {
        name: 'chain',
        type: 'number',
        description: 'Filter by chain ID (optional)',
        required: false,
      },
    ],
    handler: async (params): Promise<OpenClawToolResult> => {
      const store = plugin.getStore();
      const chainFilter = params.chain as number | undefined;

      const allBalances = chainFilter
        ? store.getBalancesByChain(chainFilter as import('../../core/types.js').ChainId)
        : store.getAllBalances();

      const totalUsdValue = allBalances.reduce((sum, b) => sum + b.usdValue, 0);

      // Group by chain
      const chainMap = new Map<number, { usdValue: number; tokens: Array<{ symbol: string; amount: string; usdValue: number }> }>();
      for (const b of allBalances) {
        const chainId = b.chainId as number;
        const entry = chainMap.get(chainId) ?? { usdValue: 0, tokens: [] };
        entry.usdValue += b.usdValue;
        entry.tokens.push({
          symbol: b.symbol,
          amount: b.amount.toString(),
          usdValue: b.usdValue,
        });
        chainMap.set(chainId, entry);
      }

      const chains = Array.from(chainMap.entries()).map(([id, data]) => ({
        chainId: id,
        usdValue: data.usdValue,
        percentage: totalUsdValue > 0 ? data.usdValue / totalUsdValue : 0,
        tokens: data.tokens,
      }));

      const activeTransfers = store.getActiveTransfers();

      return {
        success: true,
        message: `Portfolio: $${totalUsdValue.toFixed(2)} across ${chains.length} chain(s), ${activeTransfers.length} in-flight transfer(s)`,
        data: {
          totalUsdValue,
          chains,
          activeTransfers: activeTransfers.length,
          tokenCount: allBalances.length,
        },
      };
    },
  };
}
