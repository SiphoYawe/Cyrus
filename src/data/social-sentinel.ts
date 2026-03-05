// Social Sentinel — alpha extraction from social/governance feeds (Story 7.3)

import { EventEmitter } from 'node:events';
import Anthropic from '@anthropic-ai/sdk';
import { RunnableBase } from '../core/runnable-base.js';
import {
  URGENCY_ORDINAL,
  DEFAULT_SOCIAL_SENTINEL_CONFIG,
} from './social-types.js';
import type {
  SocialSignal,
  SocialSignalSource,
  SocialUrgency,
  SocialFeedQuery,
  SocialSentinelConfig,
  RawSocialData,
} from './social-types.js';

export interface SocialSourceStatus {
  readonly source: string;
  readonly status: 'active' | 'disabled' | 'error';
  readonly reason?: string;
  readonly lastPollTime: number | null;
  readonly signalCount: number;
}

export class SocialSentinel extends RunnableBase {
  readonly events = new EventEmitter();
  private readonly config: SocialSentinelConfig;
  private readonly signals = new Map<string, SocialSignal>();
  private readonly tokenIndex = new Map<string, SocialSignal[]>();
  private readonly mentionCounts = new Map<string, number[]>(); // token -> timestamps
  private signalCounter = 0;
  private anthropic: Anthropic | null = null;
  private sentimentCallCount = 0;
  private sentimentFallbackCount = 0;
  private sentimentCallResetTime = 0;
  private diagnosticLogged = false;

  // Per-source tracking
  private readonly sourceLastPollTime = new Map<string, number>();
  private readonly sourceSignalCount = new Map<string, number>();

  // Source availability
  private readonly twitterEnabled: boolean;
  private readonly discordEnabled: boolean;
  private readonly telegramEnabled: boolean;
  private readonly governanceEnabled: boolean;
  private readonly sentimentAiEnabled: boolean;

  constructor(config: Partial<SocialSentinelConfig> = {}) {
    super(60_000, 'social-sentinel');

    // Parse comma-separated env vars for influencers/channels
    const envInfluencers = process.env['TWITTER_INFLUENCERS']
      ? process.env['TWITTER_INFLUENCERS'].split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const envDiscordChannels = process.env['DISCORD_CHANNELS']
      ? process.env['DISCORD_CHANNELS'].split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const envTelegramChannels = process.env['TELEGRAM_CHANNELS']
      ? process.env['TELEGRAM_CHANNELS'].split(',').map(s => s.trim()).filter(Boolean)
      : [];

    this.config = {
      ...DEFAULT_SOCIAL_SENTINEL_CONFIG,
      // Env vars override defaults if set
      twitterInfluencers: envInfluencers.length > 0 ? envInfluencers : DEFAULT_SOCIAL_SENTINEL_CONFIG.twitterInfluencers,
      discordChannels: envDiscordChannels.length > 0 ? envDiscordChannels : DEFAULT_SOCIAL_SENTINEL_CONFIG.discordChannels,
      telegramChannels: envTelegramChannels.length > 0 ? envTelegramChannels : DEFAULT_SOCIAL_SENTINEL_CONFIG.telegramChannels,
      ...config,
    };

    // Initialize Anthropic client if API key is available
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
    }

    // Determine source availability from environment
    this.twitterEnabled = !!process.env['TWITTER_BEARER_TOKEN'] && this.config.twitterInfluencers.length > 0;
    this.discordEnabled = !!process.env['DISCORD_BOT_TOKEN'] && this.config.discordChannels.length > 0;
    this.telegramEnabled = !!process.env['TELEGRAM_BOT_TOKEN'] && this.config.telegramChannels.length > 0;
    this.governanceEnabled = this.config.governanceProtocols.length > 0;
    this.sentimentAiEnabled = !!this.anthropic;
  }

  private nextSignalId(): string {
    return `social-${++this.signalCounter}`;
  }

  async controlTask(): Promise<void> {
    // Log startup diagnostic on first tick
    if (!this.diagnosticLogged) {
      this.logDiagnostic();
      this.diagnosticLogged = true;
    }

    // Only poll enabled sources
    const polls: Promise<RawSocialData[]>[] = [];
    if (this.twitterEnabled) polls.push(this.pollTwitter().then(r => { this.sourceLastPollTime.set('twitter', Date.now()); return r; }));
    if (this.discordEnabled) polls.push(this.pollDiscord().then(r => { this.sourceLastPollTime.set('discord', Date.now()); return r; }));
    if (this.telegramEnabled) polls.push(this.pollTelegram().then(r => { this.sourceLastPollTime.set('telegram', Date.now()); return r; }));
    if (this.governanceEnabled) polls.push(this.pollGovernance().then(r => { this.sourceLastPollTime.set('governance', Date.now()); return r; }));

    const results = await Promise.allSettled(polls);

    const rawSignals: RawSocialData[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        rawSignals.push(...result.value);
      } else {
        this.logger.warn({ error: result.reason }, 'Social source poll failed');
      }
    }

    // Sentiment analysis on raw signals
    for (const raw of rawSignals) {
      try {
        const signal = await this.analyzeSentiment(raw);
        this.addSignal(signal);
        this.events.emit('social_signal', signal);
        // Track per-source signal count
        this.sourceSignalCount.set(raw.source, (this.sourceSignalCount.get(raw.source) ?? 0) + 1);
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Sentiment analysis failed, using fallback');
        const fallback = this.createFallbackSignal(raw);
        this.addSignal(fallback);
        this.events.emit('social_signal', fallback);
        this.sourceSignalCount.set(raw.source, (this.sourceSignalCount.get(raw.source) ?? 0) + 1);
      }
    }

    // Consolidate and prune
    this.consolidateSignals();
    this.pruneExpiredSignals();
  }

  private logDiagnostic(): void {
    const sources = [
      { name: 'Twitter', enabled: this.twitterEnabled, reason: !process.env['TWITTER_BEARER_TOKEN'] ? 'TWITTER_BEARER_TOKEN not set' : `${this.config.twitterInfluencers.length} influencers configured` },
      { name: 'Discord', enabled: this.discordEnabled, reason: !process.env['DISCORD_BOT_TOKEN'] ? 'DISCORD_BOT_TOKEN not set' : `${this.config.discordChannels.length} channels configured` },
      { name: 'Telegram', enabled: this.telegramEnabled, reason: !process.env['TELEGRAM_BOT_TOKEN'] ? 'TELEGRAM_BOT_TOKEN not set' : `${this.config.telegramChannels.length} channels configured` },
      { name: 'Governance', enabled: this.governanceEnabled, reason: `${this.config.governanceProtocols.length} protocols configured` },
      { name: 'Sentiment AI', enabled: this.sentimentAiEnabled, reason: !process.env['ANTHROPIC_API_KEY'] ? 'ANTHROPIC_API_KEY not set' : 'Claude API available' },
    ];

    const lines = sources.map(s => `  ${s.name}: ${s.enabled ? 'ACTIVE' : 'DISABLED'} (${s.reason})`);
    this.logger.info({ sources: sources.map(s => ({ name: s.name, enabled: s.enabled })) }, `Social Sentinel sources:\n${lines.join('\n')}`);
  }

  getSocialSourceStatus(): SocialSourceStatus[] {
    return [
      {
        source: 'twitter',
        status: this.twitterEnabled ? 'active' : 'disabled',
        reason: this.twitterEnabled ? undefined : 'TWITTER_BEARER_TOKEN not set',
        lastPollTime: this.sourceLastPollTime.get('twitter') ?? null,
        signalCount: this.sourceSignalCount.get('twitter') ?? 0,
      },
      {
        source: 'discord',
        status: this.discordEnabled ? 'active' : 'disabled',
        reason: this.discordEnabled ? undefined : 'DISCORD_BOT_TOKEN not set',
        lastPollTime: this.sourceLastPollTime.get('discord') ?? null,
        signalCount: this.sourceSignalCount.get('discord') ?? 0,
      },
      {
        source: 'telegram',
        status: this.telegramEnabled ? 'active' : 'disabled',
        reason: this.telegramEnabled ? undefined : 'TELEGRAM_BOT_TOKEN not set',
        lastPollTime: this.sourceLastPollTime.get('telegram') ?? null,
        signalCount: this.sourceSignalCount.get('telegram') ?? 0,
      },
      {
        source: 'governance',
        status: this.governanceEnabled ? 'active' : 'disabled',
        reason: this.governanceEnabled ? undefined : 'No governance protocols configured',
        lastPollTime: this.sourceLastPollTime.get('governance') ?? null,
        signalCount: this.sourceSignalCount.get('governance') ?? 0,
      },
      {
        source: 'sentiment_ai',
        status: this.sentimentAiEnabled ? 'active' : 'disabled',
        reason: this.sentimentAiEnabled ? undefined : 'ANTHROPIC_API_KEY not set',
        lastPollTime: null,
        signalCount: this.sentimentCallCount,
      },
    ];
  }

  getSentimentMetrics(): { apiCalls: number; fallbackCalls: number } {
    return {
      apiCalls: this.sentimentCallCount,
      fallbackCalls: this.sentimentFallbackCount,
    };
  }

  async onStop(): Promise<void> {
    this.events.removeAllListeners();
  }

  // --- Public query API ---

  querySignals(query: SocialFeedQuery): SocialSignal[] {
    // Prune first
    this.pruneExpiredSignals();

    let results = [...this.signals.values()];

    if (query.source) {
      results = results.filter(s => s.source === query.source);
    }
    if (query.token) {
      const tokenLower = query.token.toLowerCase();
      results = results.filter(s => s.token?.toLowerCase() === tokenLower);
    }
    if (query.sentimentPolarity === 'positive') {
      results = results.filter(s => s.sentimentScore > 0);
    } else if (query.sentimentPolarity === 'negative') {
      results = results.filter(s => s.sentimentScore < 0);
    }
    if (query.minUrgency) {
      const minOrd = URGENCY_ORDINAL[query.minUrgency];
      results = results.filter(s => URGENCY_ORDINAL[s.urgency] >= minOrd);
    }
    if (query.fromTimestamp !== undefined) {
      results = results.filter(s => s.timestamp >= query.fromTimestamp!);
    }
    if (query.toTimestamp !== undefined) {
      results = results.filter(s => s.timestamp <= query.toTimestamp!);
    }

    // Sort by timestamp descending
    results.sort((a, b) => b.timestamp - a.timestamp);

    const limit = query.limit ?? 100;
    return results.slice(0, limit);
  }

  getSignalsForToken(token: string): SocialSignal[] {
    const tokenLower = token.toLowerCase();
    return (this.tokenIndex.get(tokenLower) ?? [])
      .filter(s => !this.isExpired(s))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  getLatestSignals(limit: number): SocialSignal[] {
    return [...this.signals.values()]
      .filter(s => !this.isExpired(s))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  resetState(): void {
    this.signals.clear();
    this.tokenIndex.clear();
    this.mentionCounts.clear();
    this.signalCounter = 0;
  }

  get signalCount(): number {
    return this.signals.size;
  }

  // --- Data source implementations ---

  async pollTwitter(): Promise<RawSocialData[]> {
    // Twitter/X API v2 search for crypto-related content from influencers
    const bearerToken = process.env['TWITTER_BEARER_TOKEN'];
    if (!bearerToken || this.config.twitterInfluencers.length === 0) return [];

    try {
      // Search for recent tweets from configured influencers mentioning crypto tokens
      const influencerQuery = this.config.twitterInfluencers
        .slice(0, 5) // Limit to 5 to stay within query length
        .map((handle) => `from:${handle}`)
        .join(' OR ');

      const query = `(${influencerQuery}) (crypto OR $BTC OR $ETH OR $SOL OR DeFi OR airdrop OR yield)`;
      const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=10&tweet.fields=author_id,created_at,public_metrics`;

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });

      if (!response.ok) {
        this.logger.warn({ status: response.status }, 'Twitter API error');
        return [];
      }

      const data = (await response.json()) as {
        data?: Array<{
          id: string;
          text: string;
          author_id: string;
          created_at: string;
          public_metrics: { like_count: number; retweet_count: number; reply_count: number; impression_count: number };
        }>;
      };

      return (data.data ?? []).map((tweet) => ({
        source: 'twitter' as const,
        text: tweet.text,
        author: tweet.author_id,
        authorFollowers: null,
        engagementMetrics: {
          likes: tweet.public_metrics.like_count,
          retweets: tweet.public_metrics.retweet_count,
          replies: tweet.public_metrics.reply_count,
          impressions: tweet.public_metrics.impression_count,
        },
        timestamp: new Date(tweet.created_at).getTime(),
        rawPayload: tweet,
      }));
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Twitter poll error');
      return [];
    }
  }

  async pollDiscord(): Promise<RawSocialData[]> {
    // Discord REST API for channel messages
    const botToken = process.env['DISCORD_BOT_TOKEN'];
    if (!botToken || this.config.discordChannels.length === 0) return [];

    const results: RawSocialData[] = [];

    for (const channelId of this.config.discordChannels.slice(0, 3)) {
      try {
        const response = await fetch(
          `https://discord.com/api/v10/channels/${channelId}/messages?limit=10`,
          { headers: { Authorization: `Bot ${botToken}` } },
        );

        if (!response.ok) continue;

        const messages = (await response.json()) as Array<{
          id: string;
          content: string;
          author: { username: string; id: string };
          timestamp: string;
          reactions?: Array<{ count: number }>;
        }>;

        for (const msg of messages) {
          // Only process messages that mention tokens
          if (!this.extractTokenMention(msg.content)) continue;

          const totalReactions = (msg.reactions ?? []).reduce((s, r) => s + r.count, 0);

          results.push({
            source: 'discord',
            text: msg.content,
            author: msg.author.username,
            authorFollowers: null,
            engagementMetrics: {
              likes: totalReactions,
              retweets: 0,
              replies: 0,
              impressions: null,
            },
            timestamp: new Date(msg.timestamp).getTime(),
            rawPayload: msg,
          });
        }
      } catch (err) {
        this.logger.debug({ channelId, error: (err as Error).message }, 'Discord channel poll error');
      }
    }

    return results;
  }

  async pollTelegram(): Promise<RawSocialData[]> {
    // Telegram Bot API for channel messages
    const botToken = process.env['TELEGRAM_BOT_TOKEN'];
    if (!botToken || this.config.telegramChannels.length === 0) return [];

    const results: RawSocialData[] = [];

    for (const channel of this.config.telegramChannels.slice(0, 3)) {
      try {
        // Use getUpdates or channel history
        const response = await fetch(
          `https://api.telegram.org/bot${botToken}/getUpdates?offset=-10&limit=10&allowed_updates=["channel_post"]`,
        );

        if (!response.ok) continue;

        const data = (await response.json()) as {
          ok: boolean;
          result: Array<{
            channel_post?: {
              text?: string;
              chat: { title: string; username?: string };
              date: number;
              forward_from_chat?: { title: string };
            };
          }>;
        };

        if (!data.ok) continue;

        for (const update of data.result) {
          const post = update.channel_post;
          if (!post?.text) continue;

          // Filter for relevant channel
          if (post.chat.username !== channel && post.chat.title !== channel) continue;

          results.push({
            source: 'telegram',
            text: post.text,
            author: post.chat.title,
            authorFollowers: null,
            engagementMetrics: null,
            timestamp: post.date * 1000,
            rawPayload: post,
          });
        }
      } catch (err) {
        this.logger.debug({ channel, error: (err as Error).message }, 'Telegram channel poll error');
      }
    }

    return results;
  }

  async pollGovernance(): Promise<RawSocialData[]> {
    // Snapshot GraphQL API for governance proposals
    if (this.config.governanceProtocols.length === 0) return [];

    const results: RawSocialData[] = [];

    try {
      const spaces = this.config.governanceProtocols.slice(0, 5).map((p) => `"${p}.eth"`).join(', ');
      const query = `{
        proposals(
          first: 10,
          skip: 0,
          where: { space_in: [${spaces}], state: "active" },
          orderBy: "created",
          orderDirection: desc
        ) {
          id
          title
          body
          space { id name }
          author
          created
          scores_total
          votes
          state
        }
      }`;

      const response = await fetch('https://hub.snapshot.org/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) return [];

      const data = (await response.json()) as {
        data: {
          proposals: Array<{
            id: string;
            title: string;
            body: string;
            space: { id: string; name: string };
            author: string;
            created: number;
            scores_total: number;
            votes: number;
            state: string;
          }>;
        };
      };

      for (const proposal of data.data?.proposals ?? []) {
        const text = `[Governance] ${proposal.space.name}: ${proposal.title}\n${proposal.body.slice(0, 500)}`;

        results.push({
          source: 'governance',
          text,
          author: proposal.space.name,
          authorFollowers: null,
          engagementMetrics: {
            likes: proposal.votes,
            retweets: 0,
            replies: 0,
            impressions: null,
          },
          timestamp: proposal.created * 1000,
          rawPayload: proposal,
        });
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Governance poll error');
    }

    return results;
  }

  // --- Sentiment analysis ---

  async analyzeSentiment(raw: RawSocialData): Promise<SocialSignal> {
    const token = this.extractTokenMention(raw.text);

    // Use Claude API for real sentiment analysis if available
    if (this.anthropic) {
      // Rate limit: check calls per minute
      const now = Date.now();
      if (now - this.sentimentCallResetTime > 60_000) {
        this.sentimentCallCount = 0;
        this.sentimentCallResetTime = now;
      }

      if (this.sentimentCallCount < this.config.claudeRateLimitPerMin) {
        this.sentimentCallCount++;

        try {
          const response = await this.anthropic.messages.create({
            model: this.config.claudeModel,
            max_tokens: 256,
            system: `You are a crypto market sentiment analyzer. Analyze the following social media post and respond with ONLY a JSON object containing:
- "sentiment": number between -1.0 (very bearish) and 1.0 (very bullish)
- "urgency": one of "low", "medium", "high", "critical"
- "token": the primary token/coin mentioned (symbol only, e.g. "ETH"), or null
- "reasoning": a one-sentence explanation

Example: {"sentiment": 0.7, "urgency": "medium", "token": "ETH", "reasoning": "Bullish outlook on Ethereum merge benefits"}`,
            messages: [{
              role: 'user',
              content: `Source: ${raw.source}\nAuthor: ${raw.author}\nText: ${raw.text.slice(0, 500)}`,
            }],
          });

          const text = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');

          // Parse JSON response
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]) as {
              sentiment: number;
              urgency: string;
              token: string | null;
              reasoning: string;
            };

            const sentimentScore = Math.max(-1, Math.min(1, parsed.sentiment));
            const validUrgencies = ['low', 'medium', 'high', 'critical'];
            const urgency = (validUrgencies.includes(parsed.urgency) ? parsed.urgency : 'low') as SocialUrgency;

            return {
              id: this.nextSignalId(),
              source: raw.source,
              token: parsed.token ?? token,
              tokenAddress: null,
              chainId: null,
              sentimentScore,
              urgency,
              context: {
                text: raw.text,
                author: raw.author,
                authorFollowers: raw.authorFollowers,
                engagementMetrics: raw.engagementMetrics,
                proposalId: null,
                channelName: null,
              },
              timestamp: raw.timestamp,
              consolidated: false,
              constituentIds: [],
            };
          }
        } catch (err) {
          this.logger.debug({ error: (err as Error).message }, 'Claude sentiment analysis failed, using fallback');
        }
      }
    }

    // Fallback: basic keyword-based sentiment
    this.sentimentFallbackCount++;
    const text = raw.text.toLowerCase();
    const bullishWords = ['bullish', 'moon', 'pump', 'buy', 'long', 'breakout', 'ath', 'rally', 'surge'];
    const bearishWords = ['bearish', 'dump', 'sell', 'short', 'crash', 'rug', 'scam', 'drop', 'plunge'];

    let sentimentScore = 0;
    for (const word of bullishWords) {
      if (text.includes(word)) sentimentScore += 0.15;
    }
    for (const word of bearishWords) {
      if (text.includes(word)) sentimentScore -= 0.15;
    }
    sentimentScore = Math.max(-1, Math.min(1, sentimentScore));

    // Urgency from engagement
    let urgency: SocialUrgency = 'low';
    if (raw.engagementMetrics) {
      const total = raw.engagementMetrics.likes + raw.engagementMetrics.retweets + raw.engagementMetrics.replies;
      if (total >= this.config.viralEngagementThreshold) urgency = 'high';
      else if (total >= this.config.viralEngagementThreshold / 3) urgency = 'medium';
    }

    return {
      id: this.nextSignalId(),
      source: raw.source,
      token,
      tokenAddress: null,
      chainId: null,
      sentimentScore,
      urgency,
      context: {
        text: raw.text,
        author: raw.author,
        authorFollowers: raw.authorFollowers,
        engagementMetrics: raw.engagementMetrics,
        proposalId: null,
        channelName: null,
      },
      timestamp: raw.timestamp,
      consolidated: false,
      constituentIds: [],
    };
  }

  // --- Internal methods ---

  private addSignal(signal: SocialSignal): void {
    this.signals.set(signal.id, signal);

    if (signal.token) {
      const tokenLower = signal.token.toLowerCase();
      const existing = this.tokenIndex.get(tokenLower) ?? [];
      existing.push(signal);
      this.tokenIndex.set(tokenLower, existing);

      // Track mention counts for volume spike detection
      const counts = this.mentionCounts.get(tokenLower) ?? [];
      counts.push(signal.timestamp);
      this.mentionCounts.set(tokenLower, counts);
    }
  }

  private consolidateSignals(): void {
    const now = Date.now();
    const windowStart = now - this.config.consolidationWindowMs;

    // Group by token within consolidation window
    const tokenGroups = new Map<string, SocialSignal[]>();
    for (const signal of this.signals.values()) {
      if (!signal.token || signal.consolidated || signal.timestamp < windowStart) continue;
      const tokenLower = signal.token.toLowerCase();
      const group = tokenGroups.get(tokenLower) ?? [];
      group.push(signal);
      tokenGroups.set(tokenLower, group);
    }

    for (const [token, group] of tokenGroups) {
      if (group.length < 2) continue;

      // Deduplicate: same author + same token within 5 min
      const deduped = this.deduplicateGroup(group);
      if (deduped.length < 2) continue;

      // Weighted sentiment average (higher source credibility = more weight)
      let totalWeight = 0;
      let weightedSentiment = 0;
      for (const s of deduped) {
        const weight = this.sourceWeight(s.source);
        weightedSentiment += s.sentimentScore * weight;
        totalWeight += weight;
      }
      const combinedSentiment = totalWeight > 0 ? weightedSentiment / totalWeight : 0;

      // Elevate urgency based on source count
      const uniqueSources = new Set(deduped.map(s => s.source));
      let urgency: SocialUrgency = 'low';
      if (uniqueSources.size >= 4) {
        urgency = 'critical';
      } else if (uniqueSources.size >= 3 && Math.abs(combinedSentiment) > 0.5) {
        urgency = 'high';
      } else if (uniqueSources.size >= 2) {
        urgency = 'medium';
      }

      const consolidated: SocialSignal = {
        id: this.nextSignalId(),
        source: deduped[0]!.source,
        token: deduped[0]!.token,
        tokenAddress: deduped[0]!.tokenAddress,
        chainId: deduped[0]!.chainId,
        sentimentScore: Math.max(-1, Math.min(1, combinedSentiment)),
        urgency,
        context: deduped[0]!.context,
        timestamp: now,
        consolidated: true,
        constituentIds: deduped.map(s => s.id),
      };

      // Replace constituents with consolidated signal
      for (const s of deduped) {
        this.signals.delete(s.id);
        // Clean up token index for deleted constituent
        if (s.token) {
          const tl = s.token.toLowerCase();
          const indexed = this.tokenIndex.get(tl);
          if (indexed) {
            const filtered = indexed.filter(x => x.id !== s.id);
            if (filtered.length === 0) {
              this.tokenIndex.delete(tl);
            } else {
              this.tokenIndex.set(tl, filtered);
            }
          }
        }
      }
      this.addSignal(consolidated);
      this.events.emit('social_signal_consolidated', consolidated);
    }
  }

  private deduplicateGroup(group: SocialSignal[]): SocialSignal[] {
    const seen = new Map<string, SocialSignal>(); // key: author-token
    const fiveMinMs = 5 * 60_000;

    // Sort by timestamp so we process earliest first
    const sorted = [...group].sort((a, b) => a.timestamp - b.timestamp);

    for (const signal of sorted) {
      const dedupKey = `${signal.context.author.toLowerCase()}-${signal.token?.toLowerCase()}`;
      const existing = seen.get(dedupKey);

      if (existing && Math.abs(signal.timestamp - existing.timestamp) < fiveMinMs) {
        // Keep the one with higher engagement
        const existingEngagement = this.totalEngagement(existing);
        const currentEngagement = this.totalEngagement(signal);
        if (currentEngagement > existingEngagement) {
          seen.set(dedupKey, signal);
        }
      } else {
        seen.set(dedupKey, signal);
      }
    }

    return [...seen.values()];
  }

  private totalEngagement(signal: SocialSignal): number {
    const m = signal.context.engagementMetrics;
    if (!m) return 0;
    return m.likes + m.retweets + m.replies;
  }

  private sourceWeight(source: SocialSignalSource): number {
    switch (source) {
      case 'twitter': return 3;
      case 'governance': return 4;
      case 'discord': return 2;
      case 'telegram': return 1;
    }
  }

  private createFallbackSignal(raw: RawSocialData): SocialSignal {
    return {
      id: this.nextSignalId(),
      source: raw.source,
      token: this.extractTokenMention(raw.text),
      tokenAddress: null,
      chainId: null,
      sentimentScore: 0,
      urgency: 'low',
      context: {
        text: raw.text,
        author: raw.author,
        authorFollowers: raw.authorFollowers,
        engagementMetrics: raw.engagementMetrics,
        proposalId: null,
        channelName: null,
      },
      timestamp: raw.timestamp,
      consolidated: false,
      constituentIds: [],
    };
  }

  extractTokenMention(text: string): string | null {
    // Extract $TOKEN or known token symbols from text
    const dollarMatch = text.match(/\$([A-Z]{2,10})\b/);
    if (dollarMatch) return dollarMatch[1]!;

    // Check for contract addresses
    const addressMatch = text.match(/0x[a-fA-F0-9]{40}/);
    if (addressMatch) return addressMatch[0]!;

    return null;
  }

  isViralPost(engagement: { likes: number; retweets: number; replies: number }): boolean {
    const total = engagement.likes + engagement.retweets + engagement.replies;
    return total >= this.config.viralEngagementThreshold;
  }

  isMentionSpike(token: string): boolean {
    const tokenLower = token.toLowerCase();
    const counts = this.mentionCounts.get(tokenLower);
    if (!counts) return false;

    const now = Date.now();
    const oneHourAgo = now - 3600_000;
    const recentCount = counts.filter(ts => ts >= oneHourAgo).length;

    // Compare with average over all tracked time
    const totalHours = Math.max(1, (now - Math.min(...counts)) / 3600_000);
    const avgPerHour = counts.length / totalHours;

    return avgPerHour > 0 && recentCount >= avgPerHour * this.config.mentionVolumeThreshold;
  }

  private pruneExpiredSignals(): void {
    const cutoff = Date.now() - this.config.signalExpiryMs;
    for (const [id, signal] of this.signals) {
      if (signal.timestamp < cutoff) {
        this.signals.delete(id);
        // Clean up token index
        if (signal.token) {
          const tokenLower = signal.token.toLowerCase();
          const indexed = this.tokenIndex.get(tokenLower);
          if (indexed) {
            const filtered = indexed.filter(s => s.id !== id);
            if (filtered.length === 0) {
              this.tokenIndex.delete(tokenLower);
            } else {
              this.tokenIndex.set(tokenLower, filtered);
            }
          }
        }
      }
    }
  }

  private isExpired(signal: SocialSignal): boolean {
    return signal.timestamp < Date.now() - this.config.signalExpiryMs;
  }
}
