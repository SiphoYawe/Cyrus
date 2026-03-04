// Domain error classes — always include context for debugging

export class CyrusError extends Error {
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
  }
}

export class LiFiQuoteError extends CyrusError {
  constructor(message: string, context: {
    chainId?: number;
    fromToken?: string;
    toToken?: string;
    amount?: string;
    statusCode?: number;
  }) {
    super(message, context);
  }
}

export class BridgeTimeoutError extends CyrusError {
  constructor(context: {
    transferId: string;
    bridge: string;
    fromChain: number;
    toChain: number;
    elapsed: number;
  }) {
    super(
      `Bridge timeout after ${context.elapsed}ms: ${context.bridge} from chain ${context.fromChain} to ${context.toChain}`,
      context
    );
  }
}

export class InsufficientBalanceError extends CyrusError {
  constructor(context: {
    chainId: number;
    token: string;
    required: bigint;
    available: bigint;
  }) {
    super(
      `Insufficient balance on chain ${context.chainId}: need ${context.required}, have ${context.available}`,
      { ...context, required: context.required.toString(), available: context.available.toString() }
    );
  }
}

export class ConfigValidationError extends CyrusError {
  constructor(context: {
    path: string;
    expected: string;
    received: string;
  }) {
    super(
      `Invalid config at ${context.path}: expected ${context.expected}, got ${context.received}`,
      context
    );
  }
}

export class ApprovalError extends CyrusError {
  constructor(context: {
    token: string;
    spender: string;
    amount: string;
  }) {
    super(
      `Token approval failed for ${context.token} to spender ${context.spender}`,
      context
    );
  }
}

export class TransactionExecutionError extends CyrusError {
  constructor(message: string, context: {
    chainId?: number;
    txHash?: string;
    to?: string;
  }) {
    super(message, context);
  }
}

export class RateLimitError extends CyrusError {
  constructor(context: {
    endpoint: string;
    retryAfter?: number;
  }) {
    super(`Rate limited on ${context.endpoint}`, context);
  }
}

export class HyperliquidApiError extends CyrusError {
  constructor(context: {
    statusCode: number;
    statusText: string;
    requestType?: string;
    endpoint?: string;
  }) {
    super(
      `Hyperliquid API error: ${context.statusCode} ${context.statusText}`,
      context,
    );
  }
}

export class HyperliquidOrderError extends CyrusError {
  constructor(context: {
    symbol: string;
    side: string;
    size: string;
    error: string;
  }) {
    super(
      `Hyperliquid order failed for ${context.symbol} ${context.side}: ${context.error}`,
      context,
    );
  }
}

export class PerpExecutionError extends CyrusError {
  constructor(context: {
    symbol: string;
    stage: string;
    reason: string;
  }) {
    super(
      `Perp execution failed at ${context.stage} for ${context.symbol}: ${context.reason}`,
      context,
    );
  }
}

export class StrategyConfigError extends CyrusError {
  readonly field: string;
  readonly value: unknown;

  constructor(context: {
    field: string;
    value: unknown;
    message?: string;
  }) {
    const msg = context.message ?? `Invalid strategy config: ${context.field} = ${String(context.value)}`;
    super(msg, { field: context.field, value: String(context.value) });
    this.field = context.field;
    this.value = context.value;
  }
}
