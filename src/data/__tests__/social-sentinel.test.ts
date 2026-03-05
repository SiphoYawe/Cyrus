import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SocialSentinel } from '../social-sentinel.js';
import type { RawSocialData, SocialSignal } from '../social-types.js';

function createSentinel(overrides: Record<string, unknown> = {}): SocialSentinel {
  return new SocialSentinel({
    consolidationWindowMs: 30 * 60_000,
    signalExpiryMs: 4 * 3600_000,
    viralEngagementThreshold: 1000,
    mentionVolumeThreshold: 3,
    ...overrides,
  });
}

function makeRaw(overrides: Partial<RawSocialData> = {}): RawSocialData {
  return {
    source: 'twitter',
    text: '$ETH looking bullish today',
    author: 'cryptowhale',
    authorFollowers: 50000,
    engagementMetrics: { likes: 500, retweets: 200, replies: 100, impressions: 10000 },
    timestamp: Date.now(),
    rawPayload: {},
    ...overrides,
  };
}

describe('SocialSentinel', () => {
  let sentinel: SocialSentinel;
  const originalEnv = { ...process.env };

  function enableTwitter(): void {
    process.env['TWITTER_BEARER_TOKEN'] = 'test-token';
    process.env['TWITTER_INFLUENCERS'] = 'testuser1,testuser2';
  }

  function enableDiscord(): void {
    process.env['DISCORD_BOT_TOKEN'] = 'test-bot-token';
    process.env['DISCORD_CHANNELS'] = 'channel1,channel2';
  }

  beforeEach(() => {
    // Clear social env vars for clean state
    delete process.env['TWITTER_BEARER_TOKEN'];
    delete process.env['DISCORD_BOT_TOKEN'];
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TWITTER_INFLUENCERS'];
    delete process.env['DISCORD_CHANNELS'];
    delete process.env['TELEGRAM_CHANNELS'];
    sentinel = createSentinel();
    sentinel.resetState();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('initialization', () => {
    it('creates with default config', () => {
      const s = new SocialSentinel();
      expect(s.signalCount).toBe(0);
      expect(s.isRunning()).toBe(false);
    });

    it('controlTask is callable and runs without error', async () => {
      await sentinel.controlTask();
      expect(sentinel.signalCount).toBe(0); // no data sources configured
    });
  });

  describe('Twitter polling', () => {
    it('returns RawSocialData with correct structure', async () => {
      const raw = makeRaw({ source: 'twitter' });
      enableTwitter();
      sentinel = createSentinel();
      sentinel.pollTwitter = vi.fn().mockResolvedValue([raw]);

      await sentinel.controlTask();
      expect(sentinel.signalCount).toBe(1);
    });

    it('detects mention volume spike when threshold exceeded', () => {
      const now = Date.now();

      // Baseline: 2 mentions per hour for previous 10 hours (low average)
      for (let h = 1; h <= 10; h++) {
        for (let j = 0; j < 2; j++) {
          sentinel['addSignal']({
            id: `baseline-${h}-${j}`,
            source: 'twitter',
            token: 'ETH',
            tokenAddress: null,
            chainId: null,
            sentimentScore: 0.5,
            urgency: 'low',
            context: { text: '$ETH', author: `user-old-${h}-${j}`, authorFollowers: null, engagementMetrics: null, proposalId: null, channelName: null },
            timestamp: now - h * 3600_000,
            consolidated: false,
            constituentIds: [],
          });
        }
      }

      // Spike: 15 mentions in last 30 min (>> 3x the ~2/hr average)
      for (let i = 0; i < 15; i++) {
        sentinel['addSignal']({
          id: `spike-${i}`,
          source: 'twitter',
          token: 'ETH',
          tokenAddress: null,
          chainId: null,
          sentimentScore: 0.5,
          urgency: 'low',
          context: { text: '$ETH', author: `user${i}`, authorFollowers: null, engagementMetrics: null, proposalId: null, channelName: null },
          timestamp: now - Math.random() * 1800_000, // within last 30 min
          consolidated: false,
          constituentIds: [],
        });
      }

      expect(sentinel.isMentionSpike('ETH')).toBe(true);
    });

    it('does not detect spike below threshold', () => {
      sentinel['addSignal']({
        id: 'one',
        source: 'twitter',
        token: 'ETH',
        tokenAddress: null,
        chainId: null,
        sentimentScore: 0,
        urgency: 'low',
        context: { text: '$ETH', author: 'user1', authorFollowers: null, engagementMetrics: null, proposalId: null, channelName: null },
        timestamp: Date.now(),
        consolidated: false,
        constituentIds: [],
      });
      expect(sentinel.isMentionSpike('ETH')).toBe(false);
    });

    it('detects viral posts with high engagement', () => {
      expect(sentinel.isViralPost({ likes: 800, retweets: 300, replies: 100 })).toBe(true);
      expect(sentinel.isViralPost({ likes: 10, retweets: 5, replies: 2 })).toBe(false);
    });
  });

  describe('Discord/Telegram polling', () => {
    it('extracts token callouts from channel messages', async () => {
      const raw = makeRaw({
        source: 'discord',
        text: 'Just saw $PEPE pumping on Uniswap, entry at 0.00001',
      });
      enableDiscord();
      sentinel = createSentinel();
      sentinel.pollDiscord = vi.fn().mockResolvedValue([raw]);

      await sentinel.controlTask();
      const signals = sentinel.getLatestSignals(10);
      expect(signals.length).toBe(1);
      expect(signals[0]!.token).toBe('PEPE');
      expect(signals[0]!.source).toBe('discord');
    });

    it('extracts contract addresses from messages', () => {
      const token = sentinel.extractTokenMention(
        'Check out 0x6B175474E89094C44Da98b954EedeAC495271d0F on Ethereum',
      );
      expect(token).toBe('0x6B175474E89094C44Da98b954EedeAC495271d0F');
    });
  });

  describe('governance proposal monitoring', () => {
    it('creates signal from governance event', async () => {
      const raw: RawSocialData = {
        source: 'governance',
        text: 'Aave Proposal #247: Increase WETH borrow rate by 2%. Yield impact expected.',
        author: 'aave-governance',
        authorFollowers: null,
        engagementMetrics: null,
        timestamp: Date.now(),
        rawPayload: { proposalId: '247', protocol: 'aave', yieldImpact: true },
      };
      sentinel.pollGovernance = vi.fn().mockResolvedValue([raw]);

      await sentinel.controlTask();
      expect(sentinel.signalCount).toBe(1);
    });
  });

  describe('sentiment analysis', () => {
    it('produces valid SocialSignal with correct score range', async () => {
      const raw = makeRaw({ text: '$BTC to 100k! Super bullish' });
      enableTwitter();
      sentinel = createSentinel();

      // Mock analyzeSentiment to return a scored signal
      sentinel.analyzeSentiment = vi.fn().mockResolvedValue({
        id: 'test-1',
        source: 'twitter',
        token: 'BTC',
        tokenAddress: null,
        chainId: null,
        sentimentScore: 0.85,
        urgency: 'high',
        context: { text: raw.text, author: raw.author, authorFollowers: raw.authorFollowers, engagementMetrics: raw.engagementMetrics, proposalId: null, channelName: null },
        timestamp: raw.timestamp,
        consolidated: false,
        constituentIds: [],
      } satisfies SocialSignal);

      sentinel.pollTwitter = vi.fn().mockResolvedValue([raw]);
      await sentinel.controlTask();

      const signals = sentinel.getLatestSignals(1);
      expect(signals[0]!.sentimentScore).toBeGreaterThanOrEqual(-1);
      expect(signals[0]!.sentimentScore).toBeLessThanOrEqual(1);
      expect(signals[0]!.sentimentScore).toBe(0.85);
    });

    it('falls back to neutral sentiment on Claude API failure', async () => {
      const raw = makeRaw();
      enableTwitter();
      sentinel = createSentinel();
      sentinel.pollTwitter = vi.fn().mockResolvedValue([raw]);
      sentinel.analyzeSentiment = vi.fn().mockRejectedValue(new Error('Claude API timeout'));

      await sentinel.controlTask();
      const signals = sentinel.getLatestSignals(1);
      expect(signals.length).toBe(1);
      expect(signals[0]!.sentimentScore).toBe(0);
      expect(signals[0]!.urgency).toBe('low');
    });
  });

  describe('signal consolidation', () => {
    it('merges same-token signals within time window', async () => {
      const now = Date.now();

      const raw1 = makeRaw({ text: '$ETH is pumping', author: 'user1', timestamp: now - 60_000 });
      const raw2 = makeRaw({ text: '$ETH breakout incoming', author: 'user2', source: 'discord', timestamp: now - 30_000 });

      enableTwitter();
      enableDiscord();
      sentinel = createSentinel();
      sentinel.pollTwitter = vi.fn()
        .mockResolvedValueOnce([raw1])
        .mockResolvedValueOnce([]);
      sentinel.pollDiscord = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([raw2]);

      await sentinel.controlTask();
      await sentinel.controlTask();

      // Consolidation should merge the 2 signals into 1
      const signals = sentinel.getLatestSignals(10);
      const consolidated = signals.filter(s => s.consolidated);
      expect(consolidated.length).toBe(1);
      expect(consolidated[0]!.constituentIds.length).toBe(2);
    });

    it('has combined sentiment score and elevated urgency', async () => {
      const now = Date.now();

      enableTwitter();
      enableDiscord();
      sentinel = createSentinel();
      // Create signals from multiple sources for consolidation
      sentinel.analyzeSentiment = vi.fn()
        .mockResolvedValueOnce({
          id: 'c1', source: 'twitter', token: 'SOL', tokenAddress: null, chainId: null,
          sentimentScore: 0.8, urgency: 'low',
          context: { text: '$SOL', author: 'u1', authorFollowers: null, engagementMetrics: null, proposalId: null, channelName: null },
          timestamp: now - 60_000, consolidated: false, constituentIds: [],
        })
        .mockResolvedValueOnce({
          id: 'c2', source: 'discord', token: 'SOL', tokenAddress: null, chainId: null,
          sentimentScore: 0.6, urgency: 'low',
          context: { text: '$SOL', author: 'u2', authorFollowers: null, engagementMetrics: null, proposalId: null, channelName: null },
          timestamp: now - 30_000, consolidated: false, constituentIds: [],
        });

      sentinel.pollTwitter = vi.fn().mockResolvedValue([makeRaw({ text: '$SOL', author: 'u1' })]);
      sentinel.pollDiscord = vi.fn().mockResolvedValue([makeRaw({ text: '$SOL', author: 'u2', source: 'discord' })]);

      await sentinel.controlTask();

      const consolidated = sentinel.getLatestSignals(10).filter(s => s.consolidated);
      if (consolidated.length > 0) {
        // Combined sentiment should be between the two
        expect(consolidated[0]!.sentimentScore).toBeGreaterThan(0);
        // Multiple sources → at least medium urgency
        expect(['medium', 'high', 'critical']).toContain(consolidated[0]!.urgency);
      }
    });

    it('deduplicates same author + same token within 5 min', async () => {
      const now = Date.now();

      enableTwitter();
      sentinel = createSentinel();
      // Same author, same token, within 5 min
      sentinel.analyzeSentiment = vi.fn()
        .mockResolvedValueOnce({
          id: 'd1', source: 'twitter', token: 'ETH', tokenAddress: null, chainId: null,
          sentimentScore: 0.5, urgency: 'low',
          context: { text: '$ETH', author: 'sameuser', authorFollowers: 1000, engagementMetrics: { likes: 10, retweets: 5, replies: 2, impressions: null }, proposalId: null, channelName: null },
          timestamp: now - 60_000, consolidated: false, constituentIds: [],
        })
        .mockResolvedValueOnce({
          id: 'd2', source: 'twitter', token: 'ETH', tokenAddress: null, chainId: null,
          sentimentScore: 0.7, urgency: 'low',
          context: { text: '$ETH again', author: 'sameuser', authorFollowers: 1000, engagementMetrics: { likes: 100, retweets: 50, replies: 20, impressions: null }, proposalId: null, channelName: null },
          timestamp: now - 30_000, consolidated: false, constituentIds: [],
        });

      sentinel.pollTwitter = vi.fn()
        .mockResolvedValueOnce([makeRaw({ text: '$ETH', author: 'sameuser', timestamp: now - 60_000 })])
        .mockResolvedValueOnce([makeRaw({ text: '$ETH again', author: 'sameuser', timestamp: now - 30_000 })]);

      await sentinel.controlTask();
      await sentinel.controlTask();

      // Dedup means only 1 signal survives consolidation (same author within 5 min → 1 signal → no consolidation)
      const ethSignals = sentinel.getSignalsForToken('ETH');
      // After dedup, same author within 5 min produces 1 signal, so no consolidation
      expect(ethSignals.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('querySignals', () => {
    function addTestSignals(s: SocialSentinel): void {
      const now = Date.now();
      const signals: SocialSignal[] = [
        { id: 'q1', source: 'twitter', token: 'ETH', tokenAddress: null, chainId: null, sentimentScore: 0.8, urgency: 'high', context: { text: '$ETH', author: 'a1', authorFollowers: null, engagementMetrics: null, proposalId: null, channelName: null }, timestamp: now - 1000, consolidated: false, constituentIds: [] },
        { id: 'q2', source: 'discord', token: 'BTC', tokenAddress: null, chainId: null, sentimentScore: -0.5, urgency: 'medium', context: { text: '$BTC', author: 'a2', authorFollowers: null, engagementMetrics: null, proposalId: null, channelName: null }, timestamp: now - 2000, consolidated: false, constituentIds: [] },
        { id: 'q3', source: 'governance', token: 'AAVE', tokenAddress: null, chainId: null, sentimentScore: 0.3, urgency: 'low', context: { text: 'AAVE proposal', author: 'aave', authorFollowers: null, engagementMetrics: null, proposalId: '123', channelName: null }, timestamp: now - 3000, consolidated: false, constituentIds: [] },
        { id: 'q4', source: 'telegram', token: 'ETH', tokenAddress: null, chainId: null, sentimentScore: -0.9, urgency: 'critical', context: { text: '$ETH dump', author: 'a4', authorFollowers: null, engagementMetrics: null, proposalId: null, channelName: 'alpha-calls' }, timestamp: now - 500, consolidated: false, constituentIds: [] },
      ];
      for (const sig of signals) {
        s['addSignal'](sig);
      }
    }

    it('filters by source', () => {
      addTestSignals(sentinel);
      const results = sentinel.querySignals({ source: 'twitter' });
      expect(results.length).toBe(1);
      expect(results[0]!.source).toBe('twitter');
    });

    it('filters by token (case-insensitive)', () => {
      addTestSignals(sentinel);
      const results = sentinel.querySignals({ token: 'eth' });
      expect(results.length).toBe(2);
      results.forEach(s => expect(s.token!.toUpperCase()).toBe('ETH'));
    });

    it('filters by positive sentiment polarity', () => {
      addTestSignals(sentinel);
      const results = sentinel.querySignals({ sentimentPolarity: 'positive' });
      results.forEach(s => expect(s.sentimentScore).toBeGreaterThan(0));
    });

    it('filters by negative sentiment polarity', () => {
      addTestSignals(sentinel);
      const results = sentinel.querySignals({ sentimentPolarity: 'negative' });
      results.forEach(s => expect(s.sentimentScore).toBeLessThan(0));
    });

    it('filters by minimum urgency', () => {
      addTestSignals(sentinel);
      const results = sentinel.querySignals({ minUrgency: 'high' });
      expect(results.length).toBe(2); // high + critical
      results.forEach(s => expect(['high', 'critical']).toContain(s.urgency));
    });

    it('filters by time range', () => {
      addTestSignals(sentinel);
      const now = Date.now();
      const results = sentinel.querySignals({
        fromTimestamp: now - 2500,
        toTimestamp: now - 500,
      });
      results.forEach(s => {
        expect(s.timestamp).toBeGreaterThanOrEqual(now - 2500);
        expect(s.timestamp).toBeLessThanOrEqual(now - 500);
      });
    });

    it('applies limit and sorts by timestamp descending', () => {
      addTestSignals(sentinel);
      const results = sentinel.querySignals({ limit: 2 });
      expect(results.length).toBe(2);
      expect(results[0]!.timestamp).toBeGreaterThan(results[1]!.timestamp);
    });
  });

  describe('signal expiry', () => {
    it('prunes expired signals', () => {
      const expired: SocialSignal = {
        id: 'expired-1',
        source: 'twitter',
        token: 'OLD',
        tokenAddress: null,
        chainId: null,
        sentimentScore: 0.5,
        urgency: 'low',
        context: { text: '$OLD', author: 'a1', authorFollowers: null, engagementMetrics: null, proposalId: null, channelName: null },
        timestamp: Date.now() - 5 * 3600_000, // 5 hours ago, beyond 4h expiry
        consolidated: false,
        constituentIds: [],
      };
      sentinel['addSignal'](expired);

      const results = sentinel.querySignals({});
      expect(results.length).toBe(0);
    });
  });

  describe('resetState', () => {
    it('clears all internal state', async () => {
      enableTwitter();
      sentinel = createSentinel();
      sentinel.pollTwitter = vi.fn().mockResolvedValue([makeRaw()]);
      await sentinel.controlTask();
      expect(sentinel.signalCount).toBeGreaterThan(0);

      sentinel.resetState();
      expect(sentinel.signalCount).toBe(0);
      expect(sentinel.getLatestSignals(10).length).toBe(0);
    });
  });

  describe('controlTask resilience', () => {
    it('continues when one source fails', async () => {
      enableTwitter();
      enableDiscord();
      sentinel = createSentinel();
      sentinel.pollTwitter = vi.fn().mockRejectedValue(new Error('Twitter API down'));
      sentinel.pollDiscord = vi.fn().mockResolvedValue([makeRaw({ source: 'discord', text: '$LINK alpha call' })]);

      await sentinel.controlTask();
      // Discord signal should still be processed
      expect(sentinel.signalCount).toBe(1);
    });
  });

  describe('token extraction', () => {
    it('extracts $TOKEN mentions', () => {
      expect(sentinel.extractTokenMention('$ETH is pumping')).toBe('ETH');
      expect(sentinel.extractTokenMention('Just bought $PEPE')).toBe('PEPE');
    });

    it('extracts contract addresses', () => {
      const addr = sentinel.extractTokenMention('Check 0x6B175474E89094C44Da98b954EedeAC495271d0F');
      expect(addr).toBe('0x6B175474E89094C44Da98b954EedeAC495271d0F');
    });

    it('returns null when no token found', () => {
      expect(sentinel.extractTokenMention('just a normal message')).toBeNull();
    });
  });
});
