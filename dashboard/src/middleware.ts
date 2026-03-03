import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/auth', '/api/auth'];
const STATIC_EXTENSIONS = ['.ico', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff', '.woff2'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (
    pathname.startsWith('/_next') ||
    STATIC_EXTENSIONS.some((ext) => pathname.endsWith(ext))
  ) {
    return NextResponse.next();
  }

  // Check session cookie exists (full verification happens in API routes)
  const token = request.cookies.get('cyrus-session')?.value;
  if (!token) {
    return NextResponse.redirect(new URL('/auth', request.url));
  }

  // Basic expiry check without crypto (parse the base64 payload)
  try {
    const [encoded] = token.split('.');
    if (!encoded) {
      return NextResponse.redirect(new URL('/auth', request.url));
    }
    const payload = JSON.parse(atob(encoded));
    if (Date.now() > payload.expiresAt) {
      const response = NextResponse.redirect(new URL('/auth', request.url));
      response.cookies.delete('cyrus-session');
      return response;
    }
  } catch {
    const response = NextResponse.redirect(new URL('/auth', request.url));
    response.cookies.delete('cyrus-session');
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
