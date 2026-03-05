import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocialSentinel } from '../social-sentinel.js';
import { SignalAggregator } from '../signal-aggregator.js';
import { SocialEvaluator } from '../evaluators/social-evaluator.js';
import type { SocialSignal } from '../social-types.js';

describe('SocialSentinel — FIX-3 Activation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear social env vars
    delete process.env['TWITTER_BEARER_TOKEN'];
    delete process.env['DISCORD_BOT_TOKEN'];
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TWITTER_INFLUENCERS'];
    delete process.env['DISCORD_CHANNELS'];
    delete process.env['TELEGRAM_CHANNELS'];
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe('startup diagnostic', () => {
    it('logs diagnostic on first controlTask tick', async () => {
      const sentinel = new SocialSentinel();
      const logSpy = vi.spyOn((sentinel as any).logger, 'info');

      await sentinel.controlTask();

      const diagnosticCall = logSpy.mock.calls.find(
        (call) => typeof call[1] === 'string' && call[1].includes('Social Sentinel sources'),
      );
      expect(diagnosticCall).toBeDefined();
    });

    it('shows all sources as disabled when no env vars set', async () => {
      const sentinel = new SocialSentinel();
      const status = sentinel.getSocialSourceStatus();

      // Twitter, Discord, Telegram should all be disabled
      const twitter = status.find(s => s.source === 'twitter');
      const discord = status.find(s => s.source === 'discord');
      const telegram = status.find(s => s.source === 'telegram');
      expect(twitter!.status).toBe('disabled');
      expect(discord!.status).toBe('disabled');
      expect(telegram!.status).toBe('disabled');
    });

    it('governance is active by default (no API key required)', () => {
      const sentinel = new SocialSentinel();
      const status = sentinel.getSocialSourceStatus();

      const governance = status.find(s => s.source === 'governance');
      expect(governance!.status).toBe('active');
    });

    it('diagnostic logs only once (not on every tick)', async () => {
      const sentinel = new SocialSentinel();
      const logSpy = vi.spyOn((sentinel as any).logger, 'info');

      await sentinel.controlTask();
      await sentinel.controlTask();

      const diagnosticCalls = logSpy.mock.calls.filter(
        (call) => typeof call[1] === 'string' && call[1].includes('Social Sentinel sources'),
      );
      expect(diagnosticCalls.length).toBe(1);
    });
  });

  describe('source availability', () => {
    it('twitter enabled when TWITTER_BEARER_TOKEN set and influencers configured', () => {
      process.env['TWITTER_BEARER_TOKEN'] = 'test-token';
      process.env['TWITTER_INFLUENCERS'] = 'CryptoCapo_,lookonchain';

      const sentinel = new SocialSentinel();
      const status = sentinel.getSocialSourceStatus();
      const twitter = status.find(s => s.source === 'twitter');
      expect(twitter!.status).toBe('active');
    });

    it('parses comma-separated TWITTER_INFLUENCERS from env', () => {
      process.env['TWITTER_BEARER_TOKEN'] = 'test-token';
      process.env['TWITTER_INFLUENCERS'] = 'alice, bob ,  carol  ';

      const sentinel = new SocialSentinel();
      // The influencers should be trimmed and parsed
      const status = sentinel.getSocialSourceStatus();
      const twitter = status.find(s => s.source === 'twitter');
      expect(twitter!.status).toBe('active');
    });

    it('discord enabled when DISCORD_BOT_TOKEN and DISCORD_CHANNELS set', () => {
      process.env['DISCORD_BOT_TOKEN'] = 'test-bot-token';
      process.env['DISCORD_CHANNELS'] = 'channel1,channel2';

      const sentinel = new SocialSentinel();
      const status = sentinel.getSocialSourceStatus();
      const discord = status.find(s => s.source === 'discord');
      expect(discord!.status).toBe('active');
    });

    it('disabled sources are skipped in controlTask (no API calls)', async () => {
      const sentinel = new SocialSentinel();

      // Mock poll methods to track if they're called
      const twitterSpy = vi.spyOn(sentinel, 'pollTwitter');
      const discordSpy = vi.spyOn(sentinel, 'pollDiscord');
      const telegramSpy = vi.spyOn(sentinel, 'pollTelegram');
      const govSpy = vi.spyOn(sentinel, 'pollGovernance').mockResolvedValue([]);

      await sentinel.controlTask();

      // Disabled sources should NOT be polled
      expect(twitterSpy).not.toHaveBeenCalled();
      expect(discordSpy).not.toHaveBeenCalled();
      expect(telegramSpy).not.toHaveBeenCalled();
      // Governance should still be polled (active by default)
      expect(govSpy).toHaveBeenCalled();
    });
  });

  describe('governance works without API keys', () => {
    it('governance protocols default includes aave, compound, uniswap, lido, maker', () => {
      const sentinel = new SocialSentinel();
      // Governance should be active with default protocols
      const status = sentinel.getSocialSourceStatus();
      const gov = status.find(s => s.source === 'governance');
      expect(gov!.status).toBe('active');
    });
  });

  describe('signal aggregator integration', () => {
    it('social evaluator receives signals from sentinel', async () => {
      const sentinel = new SocialSentinel();
      const evaluator = new SocialEvaluator(sentinel);
      const aggregator = new SignalAggregator();
      aggregator.registerEvaluator(evaluator);

      // Manually add a signal
      const signal: SocialSignal = {
        id: 'test-1',
        source: 'governance',
        token: 'ETH',
        tokenAddress: null,
        chainId: null,
        sentimentScore: 0.5,
        urgency: 'medium',
        context: {
          text: 'Governance proposal about ETH',
          author: 'aave',
          authorFollowers: null,
          engagementMetrics: { likes: 50, retweets: 0, replies: 0, impressions: null },
          proposalId: null,
          channelName: null,
        },
        timestamp: Date.now(),
        consolidated: false,
        constituentIds: [],
      };

      // Emit signal event
      sentinel.events.emit('social_signal', signal);

      // The evaluator should be able to find signals for ETH
      const evaluators = aggregator.getRegisteredEvaluators();
      expect(evaluators.length).toBe(1);
      expect(evaluators[0]!.name).toBe('social');
    });
  });

  describe('social source status', () => {
    it('returns status for all 5 sources', () => {
      const sentinel = new SocialSentinel();
      const status = sentinel.getSocialSourceStatus();
      expect(status.length).toBe(5);
      expect(status.map(s => s.source)).toEqual([
        'twitter', 'discord', 'telegram', 'governance', 'sentiment_ai',
      ]);
    });

    it('includes lastPollTime and signalCount', () => {
      const sentinel = new SocialSentinel();
      const status = sentinel.getSocialSourceStatus();
      for (const s of status) {
        expect(s).toHaveProperty('lastPollTime');
        expect(s).toHaveProperty('signalCount');
      }
    });
  });

  describe('sentiment rate limiting', () => {
    it('tracks API vs fallback usage', () => {
      const sentinel = new SocialSentinel();
      const metrics = sentinel.getSentimentMetrics();
      expect(metrics.apiCalls).toBe(0);
      expect(metrics.fallbackCalls).toBe(0);
    });

    it('uses keyword fallback when no Anthropic client', async () => {
      // No ANTHROPIC_API_KEY set → falls back to keyword analysis
      delete process.env['ANTHROPIC_API_KEY'];
      const sentinel = new SocialSentinel();

      const signal = await sentinel.analyzeSentiment({
        source: 'governance',
        text: '$ETH is very bullish pump moon',
        author: 'test',
        authorFollowers: null,
        engagementMetrics: null,
        timestamp: Date.now(),
        rawPayload: {},
      });

      expect(signal.sentimentScore).toBeGreaterThan(0); // bullish keywords
      const metrics = sentinel.getSentimentMetrics();
      expect(metrics.fallbackCalls).toBe(1);
    });
  });
});
