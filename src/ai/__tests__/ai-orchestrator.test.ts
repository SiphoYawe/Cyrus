import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIOrchestrator } from '../ai-orchestrator.js';
import { Store } from '../../core/store.js';
import type { MarketDataSnapshot } from '../prompts/regime-classification.js';
import type { RegimeClassification } from '../types.js';

// Mock Anthropic client
function createMockClient(response: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: response }],
      }),
    },
  } as unknown as import('@anthropic-ai/sdk').default;
}

function createSnapshot(overrides: Partial<MarketDataSnapshot> = {}): MarketDataSnapshot {
  return {
    topTokenChanges: [
      { symbol: 'BTC', priceChange24h: 2.5 },
      { symbol: 'ETH', priceChange24h: 3.1 },
      { symbol: 'SOL', priceChange24h: 1.8 },
    ],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('AIOrchestrator', () => {
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
  });

  describe('classifyMarketRegime', () => {
    it('returns valid classification for bull regime', async () => {
      const mockClient = createMockClient(
        '{"regime":"bull","confidence":0.85,"reasoning":"Strong positive momentum across major tokens."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });
      const snapshot = createSnapshot();

      const result = await orchestrator.classifyMarketRegime(snapshot);

      expect(result.regime).toBe('bull');
      expect(result.confidence).toBe(0.85);
      expect(result.reasoning).toBe('Strong positive momentum across major tokens.');
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('returns valid classification for bear regime', async () => {
      const mockClient = createMockClient(
        '{"regime":"bear","confidence":0.90,"reasoning":"Broad decline across all tokens."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });

      const result = await orchestrator.classifyMarketRegime(createSnapshot());

      expect(result.regime).toBe('bear');
      expect(result.confidence).toBe(0.90);
    });

    it('returns valid classification for crab regime', async () => {
      const mockClient = createMockClient(
        '{"regime":"crab","confidence":0.80,"reasoning":"Minimal price movement."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });

      const result = await orchestrator.classifyMarketRegime(createSnapshot());

      expect(result.regime).toBe('crab');
    });

    it('returns valid classification for volatile regime', async () => {
      const mockClient = createMockClient(
        '{"regime":"volatile","confidence":0.88,"reasoning":"Large swings both directions."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });

      const result = await orchestrator.classifyMarketRegime(createSnapshot());

      expect(result.regime).toBe('volatile');
    });

    it('stores classification in state store', async () => {
      const mockClient = createMockClient(
        '{"regime":"bull","confidence":0.85,"reasoning":"Positive momentum."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });

      await orchestrator.classifyMarketRegime(createSnapshot());

      const stored = store.getLatestRegime();
      expect(stored).not.toBeNull();
      expect(stored!.regime).toBe('bull');
      expect(stored!.confidence).toBe(0.85);
    });

    it('emits regime_changed event when regime differs from previous', async () => {
      // Set initial regime
      store.setRegimeClassification({
        regime: 'bull',
        confidence: 0.85,
        reasoning: 'Initial',
        timestamp: Date.now() - 60_000,
      });

      const listener = vi.fn();
      store.emitter.on('regime_changed', listener);

      const mockClient = createMockClient(
        '{"regime":"bear","confidence":0.90,"reasoning":"Market shifted."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });

      await orchestrator.classifyMarketRegime(createSnapshot());

      expect(listener).toHaveBeenCalledTimes(1);
      const emitted = listener.mock.calls[0][0] as RegimeClassification;
      expect(emitted.regime).toBe('bear');
    });

    it('does not emit regime_changed when regime is the same', async () => {
      store.setRegimeClassification({
        regime: 'bull',
        confidence: 0.85,
        reasoning: 'Initial',
        timestamp: Date.now() - 60_000,
      });

      const listener = vi.fn();
      store.emitter.on('regime_changed', listener);

      const mockClient = createMockClient(
        '{"regime":"bull","confidence":0.90,"reasoning":"Still bullish."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });

      await orchestrator.classifyMarketRegime(createSnapshot());

      expect(listener).not.toHaveBeenCalled();
    });

    it('returns cached result within TTL', async () => {
      const mockClient = createMockClient(
        '{"regime":"bull","confidence":0.85,"reasoning":"Positive momentum."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient, cacheTtlMs: 60_000 });

      const first = await orchestrator.classifyMarketRegime(createSnapshot());
      const second = await orchestrator.classifyMarketRegime(createSnapshot());

      expect(first).toBe(second);
      expect(mockClient.messages.create).toHaveBeenCalledTimes(1);
    });

    it('makes fresh call after TTL expires', async () => {
      const mockClient = createMockClient(
        '{"regime":"bull","confidence":0.85,"reasoning":"Positive momentum."}',
      );
      // TTL of 0 = always fresh
      const orchestrator = new AIOrchestrator({ client: mockClient, cacheTtlMs: 0 });

      await orchestrator.classifyMarketRegime(createSnapshot());
      await orchestrator.classifyMarketRegime(createSnapshot());

      expect(mockClient.messages.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('graceful degradation', () => {
    it('returns last known regime on API failure', async () => {
      store.setRegimeClassification({
        regime: 'bull',
        confidence: 0.85,
        reasoning: 'Previous classification',
        timestamp: Date.now() - 60_000,
      });

      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue(new Error('API unreachable')),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const orchestrator = new AIOrchestrator({ client: mockClient });

      const result = await orchestrator.classifyMarketRegime(createSnapshot());

      expect(result.regime).toBe('bull');
      expect(result.reasoning).toBe('Previous classification');
    });

    it('defaults to crab when no prior classification exists', async () => {
      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue(new Error('API unreachable')),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const orchestrator = new AIOrchestrator({ client: mockClient });

      const result = await orchestrator.classifyMarketRegime(createSnapshot());

      expect(result.regime).toBe('crab');
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toContain('failed');
    });

    it('emits regime_detection_failed event on API failure', async () => {
      const listener = vi.fn();
      store.emitter.on('regime_detection_failed', listener);

      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue(new Error('Network error')),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const orchestrator = new AIOrchestrator({ client: mockClient });

      await orchestrator.classifyMarketRegime(createSnapshot());

      expect(listener).toHaveBeenCalledTimes(1);
      const emitted = listener.mock.calls[0][0] as { error: string; timestamp: number };
      expect(emitted.error).toBe('Network error');
    });

    it('never throws from classifyMarketRegime', async () => {
      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue(new Error('Fatal error')),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const orchestrator = new AIOrchestrator({ client: mockClient });

      // Should NOT throw
      const result = await orchestrator.classifyMarketRegime(createSnapshot());
      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
    });
  });

  describe('regime store', () => {
    it('caps history at 100 entries', () => {
      for (let i = 0; i < 110; i++) {
        store.setRegimeClassification({
          regime: 'bull',
          confidence: 0.8,
          reasoning: `Entry ${i}`,
          timestamp: Date.now() + i,
        });
      }

      const history = store.getRegimeHistory();
      expect(history.length).toBe(100);
    });

    it('getRegimeHistory returns limited entries', () => {
      for (let i = 0; i < 10; i++) {
        store.setRegimeClassification({
          regime: 'bull',
          confidence: 0.8,
          reasoning: `Entry ${i}`,
          timestamp: Date.now() + i,
        });
      }

      const limited = store.getRegimeHistory(3);
      expect(limited.length).toBe(3);
    });

    it('getLatestRegime returns null when empty', () => {
      expect(store.getLatestRegime()).toBeNull();
    });
  });
});
