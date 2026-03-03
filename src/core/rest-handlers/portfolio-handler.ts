import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store.js';
import type { ChainId } from '../types.js';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';

export interface ChainAllocation {
  chainId: ChainId;
  usdValue: number;
  percentage: number;
}

export interface InFlightTransferSummary {
  id: string;
  fromChain: ChainId;
  toChain: ChainId;
  bridge: string;
  status: string;
}

export interface PortfolioResponse {
  balances: Array<{
    chainId: ChainId;
    tokenAddress: string;
    symbol: string;
    decimals: number;
    amount: string;
    usdValue: number;
  }>;
  totalUsdValue: number;
  chainAllocation: ChainAllocation[];
  inFlightTransfers: {
    count: number;
    transfers: InFlightTransferSummary[];
  };
}

export function createPortfolioHandler(store: Store) {
  return function handlePortfolio(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return Promise.resolve();
    }

    const allBalances = store.getAllBalances();

    // Serialize balances (bigint amount -> string)
    const balances = allBalances.map((b) => ({
      chainId: b.chainId,
      tokenAddress: b.tokenAddress as string,
      symbol: b.symbol,
      decimals: b.decimals,
      amount: b.amount.toString(),
      usdValue: b.usdValue,
    }));

    // Total USD value
    const totalUsdValue = allBalances.reduce((sum, b) => sum + b.usdValue, 0);

    // Group by chain
    const chainMap = new Map<number, number>();
    for (const b of allBalances) {
      const current = chainMap.get(b.chainId as number) ?? 0;
      chainMap.set(b.chainId as number, current + b.usdValue);
    }

    const chainAllocation: ChainAllocation[] = Array.from(chainMap.entries()).map(
      ([cId, usdValue]) => ({
        chainId: cId as ChainId,
        usdValue,
        percentage: totalUsdValue > 0 ? usdValue / totalUsdValue : 0,
      }),
    );

    // In-flight transfers
    const activeTransfers = store.getActiveTransfers();
    const transfers: InFlightTransferSummary[] = activeTransfers.map((t) => ({
      id: t.id as string,
      fromChain: t.fromChain,
      toChain: t.toChain,
      bridge: t.bridge,
      status: t.status,
    }));

    const data: PortfolioResponse = {
      balances,
      totalUsdValue,
      chainAllocation,
      inFlightTransfers: {
        count: transfers.length,
        transfers,
      },
    };

    sendSuccess(res, data);
    return Promise.resolve();
  };
}
