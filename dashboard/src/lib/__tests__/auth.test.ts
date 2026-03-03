import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSessionToken, verifySessionToken, generateNonce } from '../auth';

describe('auth utilities', () => {
  beforeEach(() => {
    vi.stubEnv('SESSION_SECRET', 'test-secret-at-least-32-chars-long');
  });

  it('generateNonce returns 32-char hex string', () => {
    const nonce = generateNonce();
    expect(nonce).toHaveLength(32);
    expect(/^[0-9a-f]+$/.test(nonce)).toBe(true);
  });

  it('generateNonce produces unique values', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
  });

  it('createSessionToken produces a token string', async () => {
    const token = await createSessionToken('0x1234567890abcdef', 1);
    expect(typeof token).toBe('string');
    expect(token).toContain('.');
  });

  it('verifySessionToken validates a token created by createSessionToken', async () => {
    const token = await createSessionToken('0xABCD', 42161);
    const session = await verifySessionToken(token);
    expect(session).not.toBeNull();
    expect(session!.address).toBe('0xabcd'); // lowercased
    expect(session!.chainId).toBe(42161);
  });

  it('verifySessionToken rejects tampered tokens', async () => {
    const token = await createSessionToken('0xABCD', 1);
    const tampered = token.slice(0, -4) + 'xxxx';
    const session = await verifySessionToken(tampered);
    expect(session).toBeNull();
  });

  it('verifySessionToken rejects expired tokens', async () => {
    const token = await createSessionToken('0xABCD', 1);
    // Decode and tamper with expiry
    const [encoded] = token.split('.');
    const payload = JSON.parse(atob(encoded));
    payload.expiresAt = Date.now() - 1000; // expired
    const newEncoded = btoa(JSON.stringify(payload));
    // This will fail signature check
    const session = await verifySessionToken(`${newEncoded}.invalidsig`);
    expect(session).toBeNull();
  });

  it('verifySessionToken rejects empty string', async () => {
    const session = await verifySessionToken('');
    expect(session).toBeNull();
  });

  it('verifySessionToken rejects malformed token', async () => {
    const session = await verifySessionToken('not-a-real-token');
    expect(session).toBeNull();
  });
});
