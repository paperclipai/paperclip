import { auth, OPERATOR_ROLE } from '@/lib/auth';
import type { Session } from 'next-auth';
import { NextResponse } from 'next/server';

// Paths that require an active Auth.js session with the operator role.
const PROTECTED = ['/launch', '/api/session'];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isProtected = PROTECTED.some((p) => pathname.startsWith(p));

  if (!isProtected) return NextResponse.next();

  const session = req.auth as (Session & { roles?: string[] }) | null;
  if (session == null) {
    const loginUrl = new URL('/login', req.url);
    return NextResponse.redirect(loginUrl);
  }

  const hasRole = session.roles?.includes(OPERATOR_ROLE) ?? false;
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
