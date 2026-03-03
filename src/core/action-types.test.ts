import { describe, it, expect } from 'vitest';
import { ACTION_TYPES } from './action-types.js';
import type { ExecutorAction, SwapAction, BridgeAction, ComposerAction, RebalanceAction } from './action-types.js';
import { chainId, tokenAddress } from './types.js';

describe('ACTION_TYPES', () => {
  it('has correct string values', () => {
    expect(ACTION_TYPES.SWAP).toBe('swap');
    expect(ACTION_TYPES.BRIDGE).toBe('bridge');
    expect(ACTION_TYPES.COMPOSER).toBe('composer');
    expect(ACTION_TYPES.REBALANCE).toBe('rebalance');
  });
});

describe('ExecutorAction discriminated union', () => {
  const baseFields = {
    id: 'test-1',
    priority: 5,
    createdAt: Date.now(),
    strategyId: 'strategy-1',
    metadata: {},
  } as const;

  const fromChain = chainId(1);
  const toChain = chainId(42161);
  const fromToken = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  const toToken = tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831');

  it('narrows SwapAction via type discriminant', () => {
    const action: ExecutorAction = {
      ...baseFields,
      type: 'swap',
      fromChain,
      toChain,
      fromToken,
      toToken,
      amount: 1000000n,
      slippage: 0.005,
    };

    if (action.type === 'swap') {
      // TypeScript narrows to SwapAction
      const swap: SwapAction = action;
      expect(swap.slippage).toBe(0.005);
      expect(swap.amount).toBe(1000000n);
    } else {
      // Should not reach here
      expect.unreachable('Expected swap type');
    }
  });

  it('narrows BridgeAction via type discriminant', () => {
    const action: ExecutorAction = {
      ...baseFields,
      type: 'bridge',
      fromChain,
      toChain,
      fromToken,
      toToken,
      amount: 5000000n,
      preferredBridge: 'stargate',
      metadata: {},
    };

    if (action.type === 'bridge') {
      const bridge: BridgeAction = action;
      expect(bridge.preferredBridge).toBe('stargate');
      expect(bridge.amount).toBe(5000000n);
    } else {
      expect.unreachable('Expected bridge type');
    }
  });

  it('narrows ComposerAction via type discriminant', () => {
    const action: ExecutorAction = {
      ...baseFields,
      type: 'composer',
      fromChain,
      toChain,
      fromToken,
      toToken,
      amount: 2000000n,
      protocol: 'aave-v3',
      metadata: {},
    };

    if (action.type === 'composer') {
      const composer: ComposerAction = action;
      expect(composer.protocol).toBe('aave-v3');
      expect(composer.amount).toBe(2000000n);
    } else {
      expect.unreachable('Expected composer type');
    }
  });

  it('narrows RebalanceAction via type discriminant', () => {
    const swapAction: SwapAction = {
      ...baseFields,
      id: 'sub-1',
      type: 'swap',
      fromChain,
      toChain,
      fromToken,
      toToken,
      amount: 1000000n,
      slippage: 0.005,
    };

    const action: ExecutorAction = {
      ...baseFields,
      type: 'rebalance',
      actions: [swapAction],
      metadata: {},
    };

    if (action.type === 'rebalance') {
      const rebalance: RebalanceAction = action;
      expect(rebalance.actions).toHaveLength(1);
      expect(rebalance.actions[0].type).toBe('swap');
    } else {
      expect.unreachable('Expected rebalance type');
    }
  });

  it('uses bigint for amounts, not number', () => {
    const action: SwapAction = {
      ...baseFields,
      type: 'swap',
      fromChain,
      toChain,
      fromToken,
      toToken,
      amount: 1_000_000_000_000_000_000n, // 1 ETH in wei
      slippage: 0.005,
    };

    expect(typeof action.amount).toBe('bigint');
  });

  it('exhaustively handles all action types via switch', () => {
    const actions: ExecutorAction[] = [
      {
        ...baseFields, id: 'a1', type: 'swap', fromChain, toChain, fromToken, toToken,
        amount: 1n, slippage: 0.005,
      },
      {
        ...baseFields, id: 'a2', type: 'bridge', fromChain, toChain, fromToken, toToken,
        amount: 1n, metadata: {},
      },
      {
        ...baseFields, id: 'a3', type: 'composer', fromChain, toChain, fromToken, toToken,
        amount: 1n, protocol: 'aave', metadata: {},
      },
      {
        ...baseFields, id: 'a4', type: 'rebalance', actions: [], metadata: {},
      },
    ];

    const typesSeen: string[] = [];

    for (const action of actions) {
      switch (action.type) {
        case 'swap':
          typesSeen.push('swap');
          break;
        case 'bridge':
          typesSeen.push('bridge');
          break;
        case 'composer':
          typesSeen.push('composer');
          break;
        case 'rebalance':
          typesSeen.push('rebalance');
          break;
        default: {
          // exhaustiveness check
          const _exhaustive: never = action;
          throw new Error(`Unhandled action type: ${(_exhaustive as ExecutorAction).type}`);
        }
      }
    }

    expect(typesSeen).toEqual(['swap', 'bridge', 'composer', 'rebalance']);
  });
});
