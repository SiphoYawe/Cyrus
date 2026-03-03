import { NextResponse } from 'next/server';
import { generateNonce } from '@/lib/auth';

export async function GET() {
  const nonce = generateNonce();
  return NextResponse.json({ nonce });
}
