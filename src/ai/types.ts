// AI module types — all AI-related types live here

// --- Market Regime ---

export type MarketRegime = 'bull' | 'bear' | 'crab' | 'volatile';

export interface RegimeClassification {
  readonly regime: MarketRegime;
  readonly confidence: number; // 0-1
  readonly reasoning: string;
  readonly timestamp: number;
}

// --- Strategy Selection ---

export type StrategyTier = 'safe' | 'growth' | 'degen' | 'yield' | 'hedging';

export interface StrategySelectionResult {
  readonly activate: readonly string[];
  readonly deactivate: readonly string[];
  readonly reasoning: string;
  readonly timestamp: number;
}

// --- NL Command Processing ---

export type CommandIntent = 'move' | 'rebalance' | 'allocate' | 'stop' | 'status' | 'unknown';

export interface NLExecutionStep {
  readonly action: string;
  readonly chainId: number;
  readonly token: string;
  readonly amount: string;
  readonly protocol?: string;
  readonly details: string;
}

export interface NLExecutionPlan {
  readonly intent: CommandIntent;
  readonly steps: readonly NLExecutionStep[];
  readonly summary: string;
  readonly estimatedCost: CostEstimate | null;
}

export type CommandParseResult =
  | { readonly type: 'plan'; readonly plan: NLExecutionPlan }
  | { readonly type: 'clarification'; readonly question: string; readonly options: readonly string[] }
  | { readonly type: 'rejection'; readonly reason: string; readonly supportedCommands: readonly string[] };

// --- Decision Reports ---

export type OutcomeClassification = 'positive' | 'negative' | 'neutral' | 'pending' | 'failed';

export interface DecisionContext {
  readonly regime: MarketRegime;
  readonly actionType: string;
  readonly fromChain: number;
  readonly toChain: number;
  readonly tokenSymbol: string;
  readonly amountUsd: number;
  readonly gasCostUsd: number;
  readonly bridgeFeeUsd: number;
  readonly estimatedApy?: number;
  readonly slippage: number;
}

export interface DecisionReport {
  readonly id: string;
  readonly timestamp: number;
  readonly strategyName: string;
  narrative: string;
  readonly transferIds: readonly string[];
  outcome: OutcomeClassification;
  readonly context: DecisionContext;
}

export interface ReportFilter {
  readonly strategyName?: string;
  readonly outcome?: OutcomeClassification;
  readonly fromTimestamp?: number;
  readonly toTimestamp?: number;
  readonly limit?: number;
  readonly offset?: number;
}

// --- Execution Preview ---

export interface CostEstimate {
  readonly gasUsd: number;
  readonly bridgeFeeUsd: number;
  readonly slippageEstimate: number;
  readonly totalUsd: number;
}

export interface PreviewStep {
  readonly index: number;
  readonly action: string;
  readonly description: string;
  readonly fromChain: number;
  readonly toChain: number;
  readonly token: string;
  readonly amount: string;
  readonly cost: CostEstimate;
  readonly estimatedSeconds: number;
}

export interface Preview {
  readonly planId: string;
  readonly steps: readonly PreviewStep[];
  readonly totalCost: CostEstimate;
  readonly estimatedCompletionSeconds: number;
  readonly createdAt: number;
}

export type ConfirmationDecision = 'approved' | 'rejected' | 'timeout';

// --- Error Recovery ---

export type ErrorClassification =
  | 'slippage'
  | 'deposit-failure'
  | 'quote-expired'
  | 'insufficient-balance'
  | 'bridge-timeout'
  | 'unknown';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RecoveryOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly estimatedCostUsd: number;
  readonly riskLevel: RiskLevel;
  readonly isDefault: boolean;
}

export interface ErrorContext {
  readonly errorType: ErrorClassification;
  readonly originalAction: string;
  readonly transferId?: string;
  readonly fromChain: number;
  readonly toChain: number;
  readonly token: string;
  readonly amount: string;
  readonly bridgeSucceeded: boolean;
  readonly errorMessage: string;
}

export interface RetryParams {
  readonly slippage?: number;
  readonly maxRetries?: number;
}

export interface BridgeBackParams {
  readonly fromChain: number;
  readonly toChain: number;
  readonly token: string;
  readonly amount: string;
}

export interface DepositParams {
  readonly chain: number;
  readonly protocol: string;
  readonly token: string;
  readonly amount: string;
}

export type RecoveryStrategy =
  | { readonly type: 'retry'; readonly params: RetryParams }
  | { readonly type: 'hold' }
  | { readonly type: 'bridge-back'; readonly params: BridgeBackParams }
  | { readonly type: 'retry-deposit'; readonly params: DepositParams };

// --- MCP Integration ---

export interface RankedOpportunity {
  readonly rank: number;
  readonly protocol: string;
  readonly chain: number;
  readonly token: string;
  readonly grossApy: number;
  readonly netApy: number;
  readonly gasCostUsd: number;
  readonly bridgeFeeUsd: number;
  readonly reasoning: string;
}

export interface EvaluationContext {
  readonly regime: MarketRegime;
  readonly balancesUsd: Record<string, number>;
  readonly activeStrategies: readonly string[];
}
