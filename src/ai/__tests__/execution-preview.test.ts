import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionPreview } from '../execution-preview.js';
import { ConfirmationManager } from '../confirmation-manager.js';
import { Store } from '../../core/store.js';
import type { NLExecutionPlan } from '../types.js';

function createMockPlan(stepCount = 2): NLExecutionPlan {
  const steps = Array.from({ length: stepCount }, (_, i) => ({
    action: `swap-${i}`,
    chainId: 10,
    token: 'USDC',
    amount: '1000000',
    details: `Step ${i}: swap tokens`,
  }));
  return { intent: 'move', steps, summary: 'Test plan', estimatedCost: null };
}

function createMockConnector() {
  return {
    getQuote: vi.fn().mockResolvedValue({
      tool: 'test',
      action: { fromAmount: '1000000' },
      estimate: {
        toAmount: '990000',
        gasCosts: [{ amountUSD: '0.50' }],
        feeCosts: [{ amountUSD: '1.20' }],
        executionDuration: 45,
      },
    }),
    getChains: vi.fn(),
    getTokens: vi.fn(),
    getStatus: vi.fn(),
    getConnections: vi.fn(),
    getRoutes: vi.fn(),
    getTools: vi.fn(),
  } as unknown as import('../../connectors/types.js').LiFiConnectorInterface;
}

describe('ExecutionPreview', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  it('generates preview with valid fields', async () => {
    const preview = new ExecutionPreview();
    const result = await preview.generatePreview(createMockPlan());
    expect(result.planId).toBeDefined();
    expect(result.steps).toHaveLength(2);
    expect(result.totalCost).toBeDefined();
    expect(result.estimatedCompletionSeconds).toBeGreaterThan(0);
    expect(result.createdAt).toBeGreaterThan(0);
  });

  it('per-step costs sum to total', async () => {
    const preview = new ExecutionPreview();
    const result = await preview.generatePreview(createMockPlan(3));
    const sumGas = result.steps.reduce((s, step) => s + step.cost.gasUsd, 0);
    expect(result.totalCost.gasUsd).toBeCloseTo(sumGas, 5);
  });

  it('uses connector for cost estimation when available', async () => {
    const connector = createMockConnector();
    const preview = new ExecutionPreview({ connector });
    const result = await preview.generatePreview(createMockPlan(1));
    expect(connector.getQuote).toHaveBeenCalledTimes(1);
    expect(result.steps[0].cost.gasUsd).toBe(0.5);
    expect(result.steps[0].cost.bridgeFeeUsd).toBe(1.2);
    expect(result.steps[0].estimatedSeconds).toBe(45);
  });

  it('falls back to estimates on connector error', async () => {
    const connector = createMockConnector();
    connector.getQuote = vi.fn().mockRejectedValue(new Error('API error'));
    const preview = new ExecutionPreview({ connector });
    const result = await preview.generatePreview(createMockPlan(1));
    expect(result.steps[0].cost.gasUsd).toBe(0.5);
    expect(result.steps[0].cost.totalUsd).toBe(0.5);
  });

  it('uses defaults when no connector provided', async () => {
    const preview = new ExecutionPreview();
    const result = await preview.generatePreview(createMockPlan(1));
    expect(result.steps[0].cost.gasUsd).toBe(0.5);
  });

  it('handles empty plan', async () => {
    const preview = new ExecutionPreview();
    const plan: NLExecutionPlan = { intent: 'status', steps: [], summary: 'Status check', estimatedCost: null };
    const result = await preview.generatePreview(plan);
    expect(result.steps).toHaveLength(0);
    expect(result.totalCost.totalUsd).toBe(0);
  });
});

describe('ConfirmationManager', () => {
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
  });

  it('user-initiated always requires confirmation', () => {
    const manager = new ConfirmationManager();
    expect(manager.requiresConfirmation(100, true)).toBe(true);
    expect(manager.requiresConfirmation(0, true)).toBe(true);
    manager.cleanup();
  });

  it('autonomous below threshold does not require confirmation', () => {
    const manager = new ConfirmationManager({ thresholdUsd: 1000 });
    expect(manager.requiresConfirmation(500, false)).toBe(false);
    manager.cleanup();
  });

  it('autonomous above threshold requires confirmation', () => {
    const manager = new ConfirmationManager({ thresholdUsd: 1000 });
    expect(manager.requiresConfirmation(1500, false)).toBe(true);
    manager.cleanup();
  });

  it('threshold is configurable', () => {
    const manager = new ConfirmationManager({ thresholdUsd: 500 });
    expect(manager.getThresholdUsd()).toBe(500);
    expect(manager.requiresConfirmation(600, false)).toBe(true);
    manager.cleanup();
  });

  it('sends confirmation_request event', async () => {
    const listener = vi.fn();
    store.emitter.on('confirmation_request', listener);

    const manager = new ConfirmationManager({ timeoutMs: 100 });
    const preview = { planId: 'test', steps: [], totalCost: { gasUsd: 0, bridgeFeeUsd: 0, slippageEstimate: 0, totalUsd: 0 }, estimatedCompletionSeconds: 0, createdAt: Date.now() };

    // Start confirmation (don't await — it will timeout)
    const promise = manager.requestConfirmation(preview as any);
    expect(listener).toHaveBeenCalledTimes(1);

    const result = await promise;
    expect(result).toBe('timeout');
    manager.cleanup();
  });

  it('handleResponse resolves with approved', async () => {
    const manager = new ConfirmationManager({ timeoutMs: 5000 });
    const preview = { planId: 'test', steps: [], totalCost: { gasUsd: 0, bridgeFeeUsd: 0, slippageEstimate: 0, totalUsd: 0 }, estimatedCompletionSeconds: 0, createdAt: Date.now() };

    const listener = vi.fn();
    store.emitter.on('confirmation_request', listener);

    const promise = manager.requestConfirmation(preview as any);

    // Get the confirmationId from the emitted event
    const confirmationId = listener.mock.calls[0][0].confirmationId;
    manager.handleResponse(confirmationId, 'approved');

    const result = await promise;
    expect(result).toBe('approved');
    manager.cleanup();
  });

  it('handleResponse resolves with rejected', async () => {
    const manager = new ConfirmationManager({ timeoutMs: 5000 });
    const preview = { planId: 'test', steps: [], totalCost: { gasUsd: 0, bridgeFeeUsd: 0, slippageEstimate: 0, totalUsd: 0 }, estimatedCompletionSeconds: 0, createdAt: Date.now() };

    const listener = vi.fn();
    store.emitter.on('confirmation_request', listener);

    const promise = manager.requestConfirmation(preview as any);
    const confirmationId = listener.mock.calls[0][0].confirmationId;
    manager.handleResponse(confirmationId, 'rejected');

    const result = await promise;
    expect(result).toBe('rejected');
    manager.cleanup();
  });

  it('timeout auto-rejects after configured duration', async () => {
    const manager = new ConfirmationManager({ timeoutMs: 50 });
    const preview = { planId: 'test', steps: [], totalCost: { gasUsd: 0, bridgeFeeUsd: 0, slippageEstimate: 0, totalUsd: 0 }, estimatedCompletionSeconds: 0, createdAt: Date.now() };

    const result = await manager.requestConfirmation(preview as any);
    expect(result).toBe('timeout');
    manager.cleanup();
  });

  it('ignores unknown confirmation IDs', () => {
    const manager = new ConfirmationManager();
    // Should not throw
    manager.handleResponse('nonexistent-id', 'approved');
    manager.cleanup();
  });
});
