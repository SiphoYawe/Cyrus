// Social signal types for Story 7.3 — Social Sentinel Alpha Extraction

import type { ChainId, TokenAddress } from '../core/types.js';

// String literal unions — no enums
export type SocialSignalSource = 'twitter' | 'discord' | 'telegram' | 'governance';
export type SocialUrgency = 'low' | 'medium' | 'high' | 'critical';

export const URGENCY_ORDINAL: Readonly<Record<SocialUrgency, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
} as const;

export interface EngagementMetrics {
  readonly likes: number;
  readonly retweets: number;
  readonly replies: number;
  readonly impressions: number | null;
}

export interface SocialSignalContext {
  readonly text: string;
  readonly author: string;
  readonly authorFollowers: number | null;
  readonly engagementMetrics: EngagementMetrics | null;
  readonly proposalId: string | null;
  readonly channelName: string | null;
}

export interface SocialSignal {
  readonly id: string;
  readonly source: SocialSignalSource;
  readonly token: string | null;
  readonly tokenAddress: TokenAddress | null;
  readonly chainId: ChainId | null;
  readonly sentimentScore: number; // -1 to +1
  readonly urgency: SocialUrgency;
  readonly context: SocialSignalContext;
  readonly timestamp: number;
  readonly consolidated: boolean;
  readonly constituentIds: readonly string[];
}

export interface SocialFeedQuery {
  readonly source?: SocialSignalSource;
  readonly token?: string;
  readonly sentimentPolarity?: 'positive' | 'negative' | 'all';
  readonly minUrgency?: SocialUrgency;
  readonly fromTimestamp?: number;
  readonly toTimestamp?: number;
  readonly limit?: number;
}

export interface SocialSentinelConfig {
  readonly twitterInfluencers: readonly string[];
  readonly mentionVolumeThreshold: number; // multiplier, e.g. 3 = 3x average
  readonly viralEngagementThreshold: number;
  readonly discordChannels: readonly string[];
  readonly telegramChannels: readonly string[];
  readonly governanceProtocols: readonly string[];
  readonly consolidationWindowMs: number;
  readonly signalExpiryMs: number;
  readonly claudeModel: string;
  readonly claudeRateLimitPerMin: number;
}

export interface RawSocialData {
  readonly source: SocialSignalSource;
  readonly text: string;
  readonly author: string;
  readonly authorFollowers: number | null;
  readonly engagementMetrics: EngagementMetrics | null;
  readonly timestamp: number;
  readonly rawPayload: unknown;
}

export interface GovernanceEvent {
  readonly protocol: string;
  readonly proposalId: string;
  readonly title: string;
  readonly summary: string;
  readonly status: 'created' | 'active' | 'quorum' | 'passed' | 'defeated';
  readonly yieldImpact: boolean;
  readonly priceImpact: boolean;
  readonly timestamp: number;
}

export const DEFAULT_SOCIAL_SENTINEL_CONFIG: SocialSentinelConfig = {
  twitterInfluencers: [],
  mentionVolumeThreshold: 3,
  viralEngagementThreshold: 1000,
  discordChannels: [],
  telegramChannels: [],
  governanceProtocols: ['aave', 'morpho', 'euler', 'pendle', 'lido', 'etherfi', 'ethena'],
  consolidationWindowMs: 30 * 60_000, // 30 min
  signalExpiryMs: 4 * 3600_000, // 4 hours
  claudeModel: 'claude-sonnet-4-20250514',
  claudeRateLimitPerMin: 5,
} as const;
