import { describe, it, expect, beforeEach } from 'vitest';
import { AgentPearParser } from '../agent-pear-parser.js';
import { Store } from '../../core/store.js';

describe('AgentPearParser', () => {
  let parser: AgentPearParser;

  beforeEach(() => {
    Store.getInstance().reset();
    parser = new AgentPearParser();
  });

  // --- parseOpen: well-formatted ---

  it('extracts all fields from a well-formatted open signal (AC1)', () => {
    const text =
      'ETC/NEAR Z-score: -2.745 Correlation: 0.853 Half-life: 1.5d Leverage: 18';
    const result = parser.parseOpen(text);
    expect(result).not.toBeNull();
    expect(result!.pair).toBe('ETC/NEAR');
    expect(result!.direction).toBe('long_pair');
    expect(result!.zScore).toBeCloseTo(-2.745);
    expect(result!.correlation).toBeCloseTo(0.853);
    expect(result!.halfLife).toBe('1.5d');
    expect(result!.leverage).toBe(18);
    expect(result!.raw).toBe(text);
  });

  // --- parseOpen: multi-line format ---

  it('extracts all fields from a multi-line open signal (AC4)', () => {
    const text = [
      'Signal: BTC/ETH',
      'Z-score: +2.1',
      'Correlation: 0.91',
      'Half-life: 18h',
      'Leverage: x9',
    ].join('\n');
    const result = parser.parseOpen(text);
    expect(result).not.toBeNull();
    expect(result!.pair).toBe('BTC/ETH');
    expect(result!.direction).toBe('short_pair');
    expect(result!.zScore).toBeCloseTo(2.1);
    expect(result!.correlation).toBeCloseTo(0.91);
    expect(result!.halfLife).toBe('18h');
    expect(result!.leverage).toBe(9);
  });

  // --- parseOpen: extra whitespace and varying capitalization ---

  it('handles extra whitespace and mixed capitalization (AC4)', () => {
    const text =
      '  etc / near   z_score:  -1.8   CORRELATION:  0.85   HALF_LIFE: 2.3d   leverage: 5  ';
    const result = parser.parseOpen(text);
    expect(result).not.toBeNull();
    expect(result!.pair).toBe('ETC/NEAR');
    expect(result!.zScore).toBeCloseTo(-1.8);
    expect(result!.correlation).toBeCloseTo(0.85);
    expect(result!.halfLife).toBe('2.3d');
    expect(result!.leverage).toBe(5);
  });

  // --- parseOpen: leverage formats ---

  it('parses "x18" leverage format', () => {
    const text = 'SOL/AVAX Z-score: -2.0 Correlation: 0.88 Half-life: 1d x18';
    const result = parser.parseOpen(text);
    expect(result).not.toBeNull();
    expect(result!.leverage).toBe(18);
  });

  it('parses "18x" leverage format', () => {
    const text = 'SOL/AVAX Z-score: -2.0 Correlation: 0.88 Half-life: 1d 18x';
    const result = parser.parseOpen(text);
    expect(result).not.toBeNull();
    expect(result!.leverage).toBe(18);
  });

  it('parses "Leverage: 18" format', () => {
    const text = 'SOL/AVAX Z-score: -2.0 Corr: 0.88 HL: 1d Leverage: 18';
    const result = parser.parseOpen(text);
    expect(result).not.toBeNull();
    expect(result!.leverage).toBe(18);
  });

  // --- parseOpen: direction from Z-score ---

  it('negative Z-score produces long_pair direction (AC6)', () => {
    const text = 'DOT/LINK Z-score: -1.9 Correlation: 0.82 Half-life: 2d Leverage: 5';
    const result = parser.parseOpen(text);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('long_pair');
  });

  it('positive Z-score produces short_pair direction (AC6)', () => {
    const text = 'DOT/LINK Z-score: 1.9 Correlation: 0.82 Half-life: 2d Leverage: 5';
    const result = parser.parseOpen(text);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('short_pair');
  });

  // --- parseClose ---

  it('parses standard "Closing due to mean reversion" message (AC2)', () => {
    const text = 'Closing due to mean reversion ETC/NEAR Z-score: 0.42';
    const result = parser.parseClose(text);
    expect(result).not.toBeNull();
    expect(result!.pair).toBe('ETC/NEAR');
    expect(result!.reason).toBe('mean_reversion');
    expect(result!.exitZScore).toBeCloseTo(0.42);
    expect(result!.raw).toBe(text);
  });

  it('extracts exit Z-score correctly (AC2)', () => {
    const text = 'Position closed BTC/ETH exit z-score: -0.15';
    const result = parser.parseClose(text);
    expect(result).not.toBeNull();
    expect(result!.exitZScore).toBeCloseTo(-0.15);
  });

  it('classifies "stopped out" as stop_loss reason', () => {
    const text = 'Closing - stopped out SOL/AVAX Z: 1.8';
    const result = parser.parseClose(text);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('stop_loss');
  });

  it('classifies "time expired" as time_stop reason', () => {
    const text = 'Closing - time expired DOT/LINK exit: 0.3';
    const result = parser.parseClose(text);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('time_stop');
  });

  // --- parse() dispatcher ---

  it('returns { type: "open", signal } for open messages (AC1)', () => {
    const text = 'ETC/NEAR Z-score: -2.745 Correlation: 0.853 Half-life: 1.5d Leverage: 18';
    const result = parser.parse(text);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('open');
    expect(result!.signal).toHaveProperty('direction');
  });

  it('returns { type: "close", signal } for close messages (AC2)', () => {
    const text = 'Closing due to mean reversion ETC/NEAR Z-score: 0.42';
    const result = parser.parse(text);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('close');
    expect(result!.signal).toHaveProperty('reason');
  });

  it('returns null for general commentary text (AC3)', () => {
    const result = parser.parse('Market looks volatile today, be careful out there!');
    expect(result).toBeNull();
  });

  it('returns null for empty string (AC3)', () => {
    expect(parser.parse('')).toBeNull();
  });

  it('returns null for emoji-only messages (AC3)', () => {
    expect(parser.parse('🚀🌙💎🙌')).toBeNull();
  });

  it('never throws on malformed input (AC3)', () => {
    expect(parser.parse(null as unknown as string)).toBeNull();
    expect(parser.parse(undefined as unknown as string)).toBeNull();
    expect(parser.parse(123 as unknown as string)).toBeNull();
    expect(parser.parse('\x00\xFF\xFE binary stuff')).toBeNull();
    expect(parser.parse('$%^&*(!@#$%^&*')).toBeNull();
  });

  // --- Numeric validation ---

  it('returns null when Z-score is not a valid number (AC5)', () => {
    const text = 'ETC/NEAR Z-score: NaN Correlation: 0.85 Half-life: 1d Leverage: 18';
    expect(parser.parseOpen(text)).toBeNull();
  });

  it('returns null when correlation > 1.0 (AC5)', () => {
    const text = 'ETC/NEAR Z-score: -2.0 Correlation: 1.5 Half-life: 1d Leverage: 18';
    expect(parser.parseOpen(text)).toBeNull();
  });

  it('returns null when leverage is negative (AC5)', () => {
    const text = 'ETC/NEAR Z-score: -2.0 Correlation: 0.85 Half-life: 1d Leverage: -5';
    expect(parser.parseOpen(text)).toBeNull();
  });

  it('returns null when leverage exceeds 50 (AC5)', () => {
    const text = 'ETC/NEAR Z-score: -2.0 Correlation: 0.85 Half-life: 1d Leverage: 100';
    expect(parser.parseOpen(text)).toBeNull();
  });

  // --- Real Agent Pear format snapshot ---

  it('parses representative Agent Pear open signal format', () => {
    const text = [
      '📊 New Pair Trade Signal',
      '',
      'Pair: MATIC/AVAX',
      'Z-score: -2.31',
      'Correlation: 0.867',
      'Half-life: 1.2d',
      'Leverage: x23',
      '',
      '⚡ Opening long_pair position',
    ].join('\n');
    const result = parser.parse(text);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('open');
    if (result!.type === 'open') {
      expect(result!.signal.pair).toBe('MATIC/AVAX');
      expect(result!.signal.direction).toBe('long_pair');
      expect(result!.signal.zScore).toBeCloseTo(-2.31);
      expect(result!.signal.correlation).toBeCloseTo(0.867);
      expect(result!.signal.halfLife).toBe('1.2d');
      expect(result!.signal.leverage).toBe(23);
    }
  });

  it('parses representative Agent Pear close signal format', () => {
    const text = [
      '✅ Position Closed',
      '',
      'Closing due to mean reversion',
      'Pair: MATIC/AVAX',
      'Exit Z-score: 0.38',
    ].join('\n');
    const result = parser.parse(text);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('close');
    if (result!.type === 'close') {
      expect(result!.signal.pair).toBe('MATIC/AVAX');
      expect(result!.signal.reason).toBe('mean_reversion');
      expect(result!.signal.exitZScore).toBeCloseTo(0.38);
    }
  });

  // --- Edge cases: optional colon, varying delimiters ---

  it('handles signals without colons after labels (AC4)', () => {
    const text = 'ARB/OP Z-score -1.6 Correlation 0.84 Half-life 2d Leverage 9';
    const result = parser.parseOpen(text);
    expect(result).not.toBeNull();
    expect(result!.pair).toBe('ARB/OP');
    expect(result!.zScore).toBeCloseTo(-1.6);
  });

  it('handles "Corr" abbreviation for correlation', () => {
    const text = 'UNI/SUSHI Z-score: -2.5 Corr: 0.89 HL: 12h Lev: 18';
    const result = parser.parseOpen(text);
    expect(result).not.toBeNull();
    expect(result!.correlation).toBeCloseTo(0.89);
    expect(result!.halfLife).toBe('12h');
  });
});
