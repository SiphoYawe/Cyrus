import { describe, it, expect, vi } from 'vitest';
import { CyrusAgent } from './cyrus-agent.js';
import { ActionQueue } from './action-queue.js';
import { ExecutorOrchestrator } from '../executors/executor-orchestrator.js';
import type { Executor } from '../executors/executor-orchestrator.js';
import { CyrusConfigSchema } from './config.js';
import type { SwapAction } from './action-types.js';
import { chainId, tokenAddress, transferId } from './types.js';

function makeTestConfig() {
  return CyrusConfigSchema.parse({});
}

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

describe('CyrusAgent', () => {
  it('starts, ticks, and stops', async () => {
    const config = makeTestConfig();
    const actionQueue = new ActionQueue();
    const executorOrchestrator = new ExecutorOrchestrator();

    const agent = new CyrusAgent({
      config,
      actionQueue,
      executorOrchestrator,
      tickIntervalMs: 5,
    });

    expect(agent.isRunning()).toBe(false);

    // Stop after a few ticks
    const startPromise = agent.start();

    // Let it tick a few times then stop
    await new Promise((resolve) => setTimeout(resolve, 30));
    agent.stop();
    await startPromise;

    expect(agent.isRunning()).toBe(false);
    expect(agent.getTickCount()).toBeGreaterThanOrEqual(1);
  });

  it('processes queued actions during tick', async () => {
    const config = makeTestConfig();
    const actionQueue = new ActionQueue();
    const executorOrchestrator = new ExecutorOrchestrator();

    const executeFn = vi.fn(async () => ({
      success: true as const,
      transferId: transferId('tx-1'),
      txHash: '0xabc',
      error: null,
      metadata: {},
    }));

    const swapExecutor: Executor = {
      canHandle: () => true,
      execute: executeFn,
    };

    executorOrchestrator.registerExecutor('swap', swapExecutor);

    const agent = new CyrusAgent({
      config,
      actionQueue,
      executorOrchestrator,
      tickIntervalMs: 5,
    });

    // Pre-load an action into the queue
    actionQueue.enqueue(makeSwapAction());

    const startPromise = agent.start();
    // Wait for at least one tick to process
    await new Promise((resolve) => setTimeout(resolve, 30));
    agent.stop();
    await startPromise;

    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(actionQueue.isEmpty()).toBe(true);
  });

  it('does not throw when queue is empty', async () => {
    const config = makeTestConfig();
    const actionQueue = new ActionQueue();
    const executorOrchestrator = new ExecutorOrchestrator();

    const agent = new CyrusAgent({
      config,
      actionQueue,
      executorOrchestrator,
      tickIntervalMs: 5,
    });

    const startPromise = agent.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    agent.stop();

    // Should complete without error
    await expect(startPromise).resolves.toBeUndefined();
  });

  it('exposes config via getConfig', () => {
    const config = makeTestConfig();
    const actionQueue = new ActionQueue();
    const executorOrchestrator = new ExecutorOrchestrator();

    const agent = new CyrusAgent({
      config,
      actionQueue,
      executorOrchestrator,
    });

    expect(agent.getConfig().mode).toBe('dry-run');
    expect(agent.getConfig().tickIntervalMs).toBe(30_000);
  });

  it('gracefully shuts down with remaining actions', async () => {
    const config = makeTestConfig();
    const actionQueue = new ActionQueue();
    const executorOrchestrator = new ExecutorOrchestrator();

    const agent = new CyrusAgent({
      config,
      actionQueue,
      executorOrchestrator,
      tickIntervalMs: 5,
    });

    const startPromise = agent.start();

    // Let it tick once, then enqueue and stop
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Enqueue an action that won't be processed because we stop right away
    actionQueue.enqueue(makeSwapAction({ id: 'leftover' }));
    agent.stop();

    await startPromise;

    expect(agent.isRunning()).toBe(false);
    // The leftover action may still be in the queue since stop was called immediately
  });
});
