import { NextResponse } from 'next/server';
import { requireOperatorSession } from '@/lib/auth';
import { mintCaddyJwt } from '@/lib/caddy-jwt';
import { AuthProxyError, OIDCConfigurationError, SessionInvalidError } from '@/lib/errors';

// This endpoint is called by the /launch page after Auth.js establishes the
// Zitadel session.  It:
//   1. Validates the Auth.js session and checks the operator role.
//   2. Mints a short-lived JWT for Caddy using the shared secret.
//   3. Sets the JWT as an HttpOnly cookie on .binelek.io.
//   4. Redirects the browser to app.ops.binelek.io.

const APP_URL =
  process.env['APP_URL'] ?? 'https://app.ops.binelek.io';

// Cookie domain follows wherever the auth portal lives so the
// jaban_session cookie is readable by the matching `app.ops.*` host.
// Defaults to `.binelek.io` for the legacy host; flip
// SESSION_COOKIE_DOMAIN=.torinagi.com once the cutover happens.
const SESSION_COOKIE_DOMAIN =
  process.env['SESSION_COOKIE_DOMAIN'] ?? '.binelek.io';

export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireOperatorSession();

    const user = session.user ?? {};
    const email = ('email' in user ? (user as { email?: string | null }).email : null) ?? '';
    const sub = ('id' in user ? (user as { id?: string }).id : undefined) ?? email;

    const jwt = await mintCaddyJwt({
      email,
      roles: session.roles,
      sub,
    });

    const response = NextResponse.redirect(APP_URL, { status: 302 });

    response.cookies.set('jaban_session', jwt, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      domain: SESSION_COOKIE_DOMAIN,
      path: '/',
      // 8 hours — matches JWT expiry
      maxAge: 8 * 60 * 60,
    });

    return response;
  } catch (err) {
    if (err instanceof SessionInvalidError) {
      return NextResponse.redirect(
        new URL('/login', process.env['NEXTAUTH_URL'] ?? 'https://ops.binelek.io'),
        { status: 302 }
      );
    }
    if (err instanceof AuthProxyError && err.statusCode === 403) {
      return NextResponse.json(
        { error: 'Your account does not have operator access.' },
        { status: 403 }
      );
    }
    if (err instanceof OIDCConfigurationError) {
      console.error('[session] OIDC misconfiguration', { message: (err as Error).message });
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }
    console.error('[session] unexpected error', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
