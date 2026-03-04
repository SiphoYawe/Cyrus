// Agent Pear Message Parser — regex-based, stateless, never throws

import { createLogger } from '../utils/logger.js';
import type {
  AgentPearOpenSignal,
  AgentPearCloseSignal,
  AgentPearParseResult,
  PairDirection,
  CloseReason,
} from './types.js';

const logger = createLogger('agent-pear-parser');

// --- Regex patterns ---

// Pair: two uppercase token symbols separated by /
const PAIR_PATTERN = /([A-Za-z]{2,10})\s*\/\s*([A-Za-z]{2,10})/;

// Z-score: optional label, then signed decimal
const Z_SCORE_PATTERN = /(?:z[_\-\s]*score\s*[:=]?\s*)([-+]?\d+(?:\.\d+)?)/i;
const Z_SCORE_FALLBACK = /(?:^|\s|[,;|])\s*([-+]\d+(?:\.\d+)?)(?:\s|$|[,;|])/;

// Correlation: label + decimal number (validated for 0-1 range)
const CORRELATION_PATTERN = /(?:corr(?:elation)?)\s*[:=]?\s*(\d+(?:\.\d+)?)/i;

// Half-life: label + duration
const HALF_LIFE_PATTERN = /(?:half[_\-\s]*life|hl)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*([dh])/i;

// Leverage: various formats
const LEVERAGE_PATTERN = /(?:lev(?:erage)?)\s*[:=]?\s*x?(\d+)/i;
const LEVERAGE_X_PATTERN = /x(\d+)/i;
const LEVERAGE_SUFFIX_PATTERN = /(\d+)x\b/i;

// Close indicators
const CLOSE_PATTERN = /(?:clos(?:ing|ed?)|exit|position\s+closed)/i;
const MEAN_REVERSION_PATTERN = /mean\s*reversion/i;
const STOP_LOSS_PATTERN = /stop(?:ped)?\s*(?:loss|out)/i;
const TIME_STOP_PATTERN = /(?:time|expir)/i;

// Exit Z-score in close context
const EXIT_Z_PATTERN = /(?:z[_\-\s]*(?:score)?|exit)\s*[:=]?\s*([-+]?\d+(?:\.\d+)?)/i;
const EXIT_Z_FALLBACK = /([-+]?\d+\.\d+)/;

// --- Utility functions ---

function normalizeText(text: string): string {
  // Remove zero-width characters and normalize whitespace
  return text
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractNumber(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (!match?.[1]) return null;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num)) return null;
  return num;
}

function extractPair(text: string): string | null {
  const match = text.match(PAIR_PATTERN);
  if (!match) return null;
  return `${match[1].toUpperCase()}/${match[2].toUpperCase()}`;
}

function extractZScore(text: string): number | null {
  // Try labeled pattern first
  let score = extractNumber(text, Z_SCORE_PATTERN);
  if (score !== null) return score;
  // Fallback to any signed number
  score = extractNumber(text, Z_SCORE_FALLBACK);
  return score;
}

function extractCorrelation(text: string): number | null {
  const value = extractNumber(text, CORRELATION_PATTERN);
  if (value === null) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

function extractHalfLife(text: string): string | null {
  const match = text.match(HALF_LIFE_PATTERN);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2].toLowerCase();
  return `${value}${unit}`;
}

function extractLeverage(text: string): number | null {
  // Try labeled pattern first
  let match = text.match(LEVERAGE_PATTERN);
  if (!match) match = text.match(LEVERAGE_X_PATTERN);
  if (!match) match = text.match(LEVERAGE_SUFFIX_PATTERN);
  if (!match?.[1]) return null;

  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0 || value > 50) return null;
  return value;
}

function determineDirection(zScore: number): PairDirection {
  // Negative Z -> spread below mean -> long pair (long A, short B)
  // Positive Z -> spread above mean -> short pair (short A, long B)
  return zScore < 0 ? 'long_pair' : 'short_pair';
}

function classifyCloseReason(text: string): CloseReason {
  if (MEAN_REVERSION_PATTERN.test(text)) return 'mean_reversion';
  if (STOP_LOSS_PATTERN.test(text)) return 'stop_loss';
  if (TIME_STOP_PATTERN.test(text)) return 'time_stop';
  return 'manual';
}

// --- Parser class ---

export class AgentPearParser {
  parseOpen(text: string): AgentPearOpenSignal | null {
    if (!text) return null;

    const normalized = normalizeText(text);

    const pair = extractPair(normalized);
    if (!pair) return null;

    const zScore = extractZScore(normalized);
    if (zScore === null) return null;

    const correlation = extractCorrelation(normalized);
    if (correlation === null) return null;

    const halfLife = extractHalfLife(normalized);
    if (halfLife === null) return null;

    const leverage = extractLeverage(normalized);
    if (leverage === null) return null;

    const direction = determineDirection(zScore);

    return {
      pair,
      direction,
      zScore,
      correlation,
      halfLife,
      leverage,
      raw: text,
    };
  }

  parseClose(text: string): AgentPearCloseSignal | null {
    if (!text) return null;

    const normalized = normalizeText(text);

    // Must contain a close indicator
    if (!CLOSE_PATTERN.test(normalized)) return null;

    const pair = extractPair(normalized);
    if (!pair) return null;

    // Extract exit Z-score
    let exitZScore = extractNumber(normalized, EXIT_Z_PATTERN);
    if (exitZScore === null) {
      exitZScore = extractNumber(normalized, EXIT_Z_FALLBACK);
    }
    if (exitZScore === null) return null;

    const reason = classifyCloseReason(normalized);

    return {
      pair,
      reason,
      exitZScore,
      raw: text,
    };
  }

  parse(text: string): AgentPearParseResult {
    try {
      if (!text || typeof text !== 'string') return null;

      // Try open signal first
      const openSignal = this.parseOpen(text);
      if (openSignal) {
        return { type: 'open', signal: openSignal };
      }

      // Try close signal
      const closeSignal = this.parseClose(text);
      if (closeSignal) {
        return { type: 'close', signal: closeSignal };
      }

      return null;
    } catch (error) {
      logger.warn({ error }, 'Unexpected error during parse — returning null');
      return null;
    }
  }
}
