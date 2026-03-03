import { describe, it, expect } from 'vitest';
import { ActionQueue } from './action-queue.js';
import type { SwapAction, BridgeAction, ExecutorAction } from './action-types.js';
import { chainId, tokenAddress } from './types.js';

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

describe('ActionQueue', () => {
  it('starts empty', () => {
    const queue = new ActionQueue();
    expect(queue.isEmpty()).toBe(true);
    expect(queue.size()).toBe(0);
  });

  it('enqueues and dequeues a single action', () => {
    const queue = new ActionQueue();
    const action = makeSwapAction();

    queue.enqueue(action);
    expect(queue.size()).toBe(1);
    expect(queue.isEmpty()).toBe(false);

    const dequeued = queue.dequeue();
    expect(dequeued).toEqual(action);
    expect(queue.isEmpty()).toBe(true);
  });

  it('sorts by priority (higher priority first)', () => {
    const queue = new ActionQueue();

    const low = makeSwapAction({ id: 'low', priority: 1 });
    const mid = makeBridgeAction({ id: 'mid', priority: 5 });
    const high = makeSwapAction({ id: 'high', priority: 10 });

    // Enqueue in mixed order
    queue.enqueue(mid);
    queue.enqueue(low);
    queue.enqueue(high);

    expect(queue.dequeue()?.id).toBe('high');
    expect(queue.dequeue()?.id).toBe('mid');
    expect(queue.dequeue()?.id).toBe('low');
  });

  it('peek returns highest priority without removing', () => {
    const queue = new ActionQueue();

    queue.enqueue(makeSwapAction({ id: 'a', priority: 3 }));
    queue.enqueue(makeSwapAction({ id: 'b', priority: 7 }));

    expect(queue.peek()?.id).toBe('b');
    expect(queue.size()).toBe(2); // not removed
  });

  it('dequeue returns undefined when empty', () => {
    const queue = new ActionQueue();
    expect(queue.dequeue()).toBeUndefined();
  });

  it('peek returns undefined when empty', () => {
    const queue = new ActionQueue();
    expect(queue.peek()).toBeUndefined();
  });

  it('drain returns all items and empties queue', () => {
    const queue = new ActionQueue();

    queue.enqueue(makeSwapAction({ id: 'a', priority: 1 }));
    queue.enqueue(makeBridgeAction({ id: 'b', priority: 5 }));
    queue.enqueue(makeSwapAction({ id: 'c', priority: 3 }));

    const drained = queue.drain();

    // Returned in priority order (sorted on insert)
    expect(drained).toHaveLength(3);
    expect(drained[0].id).toBe('b');  // priority 5
    expect(drained[1].id).toBe('c');  // priority 3
    expect(drained[2].id).toBe('a');  // priority 1
    expect(queue.isEmpty()).toBe(true);
  });

  it('clear removes all items', () => {
    const queue = new ActionQueue();

    queue.enqueue(makeSwapAction({ id: 'a', priority: 1 }));
    queue.enqueue(makeSwapAction({ id: 'b', priority: 2 }));
    expect(queue.size()).toBe(2);

    queue.clear();
    expect(queue.size()).toBe(0);
    expect(queue.isEmpty()).toBe(true);
  });

  it('maintains priority order after multiple enqueue/dequeue cycles', () => {
    const queue = new ActionQueue();

    queue.enqueue(makeSwapAction({ id: 'a', priority: 5 }));
    queue.enqueue(makeSwapAction({ id: 'b', priority: 10 }));

    // Dequeue highest
    expect(queue.dequeue()?.id).toBe('b');

    // Enqueue another with mid priority
    queue.enqueue(makeSwapAction({ id: 'c', priority: 7 }));

    // c (7) should come before a (5)
    expect(queue.dequeue()?.id).toBe('c');
    expect(queue.dequeue()?.id).toBe('a');
  });
});
