import { describe, it, expect, vi } from 'vitest';
import { ExecutorOrchestrator } from './executor-orchestrator.js';
import type { Executor } from './executor-orchestrator.js';
import { ActionQueue } from '../core/action-queue.js';
import type { SwapAction, BridgeAction, ExecutorAction } from '../core/action-types.js';
import type { ExecutionResult } from '../core/types.js';
import { chainId, tokenAddress, transferId } from '../core/types.js';

function makeSwapAction(overrides: Partial<SwapAction> = {}): SwapAction {
  return {
    id: 'swap-1',
    type: 'swap',
    priority: 5,
    createdAt: Date.now(),
    strategyId: 'test-strategy',
    fromChain: chainId(1),
    toChain: chainId(42161),
    fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
    toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
    amount: 1_000_000n,
    slippage: 0.005,
    metadata: {},
    ...overrides,
  };
}

function makeBridgeAction(overrides: Partial<BridgeAction> = {}): BridgeAction {
  return {
    id: 'bridge-1',
    type: 'bridge',
    priority: 3,
    createdAt: Date.now(),
    strategyId: 'test-strategy',
    fromChain: chainId(1),
    toChain: chainId(42161),
    fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
    toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
    amount: 5_000_000n,
    metadata: {},
    ...overrides,
  };
}

function makeSuccessResult(actionId: string): ExecutionResult {
  return {
    success: true,
    transferId: transferId(`tx-${actionId}`),
    txHash: `0x${actionId}hash`,
    error: null,
    metadata: { actionId },
  };
}

describe('ExecutorOrchestrator', () => {
  it('routes action to the correct executor', async () => {
    const orchestrator = new ExecutorOrchestrator();

    const swapExecutor: Executor = {
      canHandle: (action) => action.type === 'swap',
      execute: vi.fn(async (action) => makeSuccessResult(action.id)),
    };

    orchestrator.registerExecutor('swap', swapExecutor);

    const action = makeSwapAction();
    const result = await orchestrator.processAction(action);

    expect(result.success).toBe(true);
    expect(swapExecutor.execute).toHaveBeenCalledWith(action);
  });

  it('returns error result for unknown action type', async () => {
    const orchestrator = new ExecutorOrchestrator();

    // No executors registered
    const action = makeSwapAction();
    const result = await orchestrator.processAction(action);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No executor registered');
    expect(result.transferId).toBeNull();
  });

  it('returns error result when executor cannot handle action', async () => {
    const orchestrator = new ExecutorOrchestrator();

    const swapExecutor: Executor = {
      canHandle: () => false, // always returns false
      execute: vi.fn(async (action) => makeSuccessResult(action.id)),
    };

    orchestrator.registerExecutor('swap', swapExecutor);

    const action = makeSwapAction();
    const result = await orchestrator.processAction(action);

    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot handle');
    expect(swapExecutor.execute).not.toHaveBeenCalled();
  });

  it('processes multiple actions from queue in priority order', async () => {
    const orchestrator = new ExecutorOrchestrator();
    const executionOrder: string[] = [];

    const swapExecutor: Executor = {
      canHandle: (action) => action.type === 'swap',
      execute: async (action) => {
        executionOrder.push(action.id);
        return makeSuccessResult(action.id);
      },
    };

    const bridgeExecutor: Executor = {
      canHandle: (action) => action.type === 'bridge',
      execute: async (action) => {
        executionOrder.push(action.id);
        return makeSuccessResult(action.id);
      },
    };

    orchestrator.registerExecutor('swap', swapExecutor);
    orchestrator.registerExecutor('bridge', bridgeExecutor);

    const queue = new ActionQueue();
    queue.enqueue(makeSwapAction({ id: 'low-swap', priority: 1 }));
    queue.enqueue(makeBridgeAction({ id: 'high-bridge', priority: 10 }));
    queue.enqueue(makeSwapAction({ id: 'mid-swap', priority: 5 }));

    const results = await orchestrator.processQueue(queue);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    // Priority order: high-bridge (10) > mid-swap (5) > low-swap (1)
    expect(executionOrder).toEqual(['high-bridge', 'mid-swap', 'low-swap']);
    expect(queue.isEmpty()).toBe(true);
  });

  it('returns empty array for empty queue', async () => {
    const orchestrator = new ExecutorOrchestrator();
    const queue = new ActionQueue();

    const results = await orchestrator.processQueue(queue);
    expect(results).toHaveLength(0);
  });

  it('does not throw when processing an action with no registered executor', async () => {
    const orchestrator = new ExecutorOrchestrator();
    const queue = new ActionQueue();

    queue.enqueue(makeSwapAction({ id: 'unhandled' }));

    // Should not throw
    const results = await orchestrator.processQueue(queue);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
  });
});
