import { auth } from '@/lib/auth';
import type { AppSession } from '@/lib/auth';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Paths that require an active Auth.js session with the operator role.
const PROTECTED = ['/launch', '/api/session'];

export default auth(function middleware(
  req: NextRequest & { auth: AppSession | null }
) {
  const { pathname } = req.nextUrl;
  const isProtected = PROTECTED.some((p) => pathname.startsWith(p));

  if (!isProtected) return NextResponse.next();

  const session = req.auth;
  if (session == null) {
    const loginUrl = new URL('/login', req.url);
    return NextResponse.redirect(loginUrl);
  }

  const hasRole = session.roles?.includes('paperclip-ops:operator') ?? false;
  if (!hasRole) {
    return NextResponse.json(
      { error: 'Insufficient role — paperclip-ops:operator required.' },
      { status: 403 }
    );
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/launch', '/api/session'],
};
