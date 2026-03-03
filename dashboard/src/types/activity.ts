export type ActivityType = 'trade' | 'bridge' | 'deposit';

export type TransferStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'REFUNDED'
  | 'FAILED'
  | 'NOT_FOUND';

export interface TransferStep {
  id: string;
  action: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  txHash?: string;
  chainId?: number;
  timestamp?: number;
}

export interface ActivityTransfer {
  id: string;
  txHash?: string;
  fromChainId: number;
  toChainId: number;
  fromToken: { symbol: string; address: string; decimals: number };
  toToken: { symbol: string; address: string; decimals: number };
  fromAmount: string;
  toAmount?: string;
  fromAmountUsd?: number;
  toAmountUsd?: number;
  status: TransferStatus;
  substatus?: string;
  bridge?: string;
  steps?: TransferStep[];
  estimatedTimeMs?: number;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export type StrategyTier = 'Safe' | 'Growth' | 'Degen' | 'Reserve';

export interface ActivityReport {
  id: string;
  timestamp: string;
  type: ActivityType;
  tier: StrategyTier;
  strategyName: string;
  summary: string;
  narrative: string;
  transfer?: ActivityTransfer;
  gasCostUsd?: number;
  pnlUsd?: number;
  success: boolean;
}

export interface ActivityStats {
  totalOperations: number;
  successCount: number;
  successRate: number;
  totalGasUsd: number;
  netPnlUsd: number;
}

export interface ActivityFilters {
  type?: ActivityType;
  chains?: number[];
  strategies?: string[];
  dateFrom?: string;
  dateTo?: string;
}
