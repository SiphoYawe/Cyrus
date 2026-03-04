// Social Sentinel — alpha extraction from social/governance feeds (Story 7.3)

import { EventEmitter } from 'node:events';
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

export class SocialSentinel extends RunnableBase {
  readonly events = new EventEmitter();
  private readonly config: SocialSentinelConfig;
  private readonly signals = new Map<string, SocialSignal>();
  private readonly tokenIndex = new Map<string, SocialSignal[]>();
  private readonly mentionCounts = new Map<string, number[]>(); // token -> timestamps
  private signalCounter = 0;

  constructor(config: Partial<SocialSentinelConfig> = {}) {
    super(60_000, 'social-sentinel');
    this.config = { ...DEFAULT_SOCIAL_SENTINEL_CONFIG, ...config };
  }

  private nextSignalId(): string {
    return `social-${++this.signalCounter}`;
  }

  async controlTask(): Promise<void> {
    const results = await Promise.allSettled([
      this.pollTwitter(),
      this.pollDiscord(),
      this.pollTelegram(),
      this.pollGovernance(),
    ]);

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
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Sentiment analysis failed, using fallback');
        const fallback = this.createFallbackSignal(raw);
        this.addSignal(fallback);
        this.events.emit('social_signal', fallback);
      }
    }

    // Consolidate and prune
    this.consolidateSignals();
    this.pruneExpiredSignals();
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

  // --- Data source stubs (mockable in tests) ---

  async pollTwitter(): Promise<RawSocialData[]> {
    // Stub: in production, fetches from Twitter API for configured influencers
    return [];
  }

  async pollDiscord(): Promise<RawSocialData[]> {
    // Stub: in production, fetches from Discord channels
    return [];
  }

  async pollTelegram(): Promise<RawSocialData[]> {
    // Stub: in production, fetches from Telegram channels
    return [];
  }

  async pollGovernance(): Promise<RawSocialData[]> {
    // Stub: in production, fetches from governance forums
    return [];
  }

  // --- Sentiment analysis ---

  async analyzeSentiment(raw: RawSocialData): Promise<SocialSignal> {
    // Stub: in production, calls Claude API for NLP analysis
    // Extracts token, classifies sentiment, assesses urgency
    const token = this.extractTokenMention(raw.text);

    return {
      id: this.nextSignalId(),
      source: raw.source,
      token,
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
