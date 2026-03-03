import { NextRequest, NextResponse } from 'next/server';
import { SiweMessage } from 'siwe';
import { createSessionToken, getSessionCookieOptions } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const { message, signature } = await request.json();

    if (!message || !signature) {
      return NextResponse.json(
        { error: 'Missing message or signature' },
        { status: 400 }
      );
    }

    const siweMessage = new SiweMessage(message);
    const result = await siweMessage.verify({ signature });

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 }
      );
    }

    const token = await createSessionToken(
      result.data.address,
      result.data.chainId ?? 1
    );

    const cookieOptions = getSessionCookieOptions();
    const response = NextResponse.json({ ok: true, address: result.data.address });
    response.cookies.set(cookieOptions.name, token, {
      httpOnly: cookieOptions.httpOnly,
      secure: cookieOptions.secure,
      sameSite: cookieOptions.sameSite,
      path: cookieOptions.path,
      maxAge: cookieOptions.maxAge,
    });

    return response;
  } catch {
    return NextResponse.json(
      { error: 'Verification failed' },
      { status: 500 }
    );
  }
}
