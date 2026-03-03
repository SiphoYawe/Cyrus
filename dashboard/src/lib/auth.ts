import { cookies } from 'next/headers';

const SESSION_COOKIE = 'cyrus-session';
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h

export interface Session {
  address: string;
  chainId: number;
  createdAt: number;
  expiresAt: number;
}

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET environment variable is required');
  }
  return secret;
}

async function hmacSign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function createSessionToken(address: string, chainId: number): Promise<string> {
  const secret = getSecret();
  const now = Date.now();
  const session: Session = {
    address: address.toLowerCase(),
    chainId,
    createdAt: now,
    expiresAt: now + SESSION_EXPIRY_MS,
  };
  const payload = JSON.stringify(session);
  const encoded = btoa(payload);
  const signature = await hmacSign(encoded, secret);
  return `${encoded}.${signature}`;
}

export async function verifySessionToken(token: string): Promise<Session | null> {
  try {
    const secret = getSecret();
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) return null;

    const expectedSig = await hmacSign(encoded, secret);
    if (signature !== expectedSig) return null;

    const payload = atob(encoded);
    const session: Session = JSON.parse(payload);

    if (Date.now() > session.expiresAt) return null;

    return session;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export function getSessionCookieOptions() {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(SESSION_EXPIRY_MS / 1000),
  };
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
