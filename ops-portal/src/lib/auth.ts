import NextAuth from 'next-auth';
import type { NextAuthConfig, Session, User } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import Zitadel from 'next-auth/providers/zitadel';
import { OIDCConfigurationError } from './errors';

// Zitadel returns project roles as a nested map:
// "urn:zitadel:iam:org:project:roles": { "roleName": { "orgId": "orgName" } }
function extractZitadelRoles(profile: Record<string, unknown>): string[] {
  const raw = profile['urn:zitadel:iam:org:project:roles'];
  if (raw == null || typeof raw !== 'object') return [];
  return Object.keys(raw as Record<string, unknown>);
}

if (!process.env['AUTH_ZITADEL_ISSUER']) {
  throw new OIDCConfigurationError('AUTH_ZITADEL_ISSUER is not set');
}
if (!process.env['AUTH_ZITADEL_ID']) {
  throw new OIDCConfigurationError('AUTH_ZITADEL_ID is not set');
}
if (!process.env['AUTH_ZITADEL_SECRET']) {
  throw new OIDCConfigurationError('AUTH_ZITADEL_SECRET is not set');
}

const authConfig: NextAuthConfig = {
  providers: [
    Zitadel({
      issuer: process.env['AUTH_ZITADEL_ISSUER'],
      clientId: process.env['AUTH_ZITADEL_ID'],
      clientSecret: process.env['AUTH_ZITADEL_SECRET'],
      authorization: {
        params: {
          scope:
            'openid profile email urn:zitadel:iam:org:project:roles',
        },
      },
    }),
  ],

  callbacks: {
    async jwt({
      token,
      account,
      profile,
    }: {
      token: JWT;
      account: unknown;
      profile?: Record<string, unknown>;
    }) {
      if (account != null && profile != null) {
        token['sub'] = (profile['sub'] as string | undefined) ?? token['sub'];
        token['email'] = (profile['email'] as string | undefined) ?? token['email'];
        token['roles'] = extractZitadelRoles(profile);
      }
      return token;
    },

    async session({ session, token }: { session: Session; token: JWT }) {
      const s = session as Session & { roles: string[] };
      s.roles = (token['roles'] as string[] | undefined) ?? [];
      if (typeof token['email'] === 'string') {
        s.user.email = token['email'];
      }
      return s;
    },

    authorized({
      auth,
      request,
    }: {
      auth: (Session & { roles?: string[] }) | null;
      request: { nextUrl: URL };
    }) {
      const { nextUrl } = request;
      const isLoggedIn = auth?.user != null;
      const hasRole = (auth?.roles ?? []).includes('paperclip-ops:operator');
      const protectedPaths = ['/launch'];
      const isProtected = protectedPaths.some((p) =>
        nextUrl.pathname.startsWith(p)
      );
      if (isProtected) return isLoggedIn && hasRole;
      return true;
    },
  },

  session: {
    strategy: 'jwt',
    maxAge: 8 * 60 * 60, // 8 hours
  },

  pages: {
    signIn: '/login',
    error: '/login',
  },

  trustHost: true,
};

export type AppSession = Session & { roles: string[] };

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

// Type-safe session accessor used in server components and route handlers.
export async function requireSession(): Promise<AppSession> {
  const session = (await auth()) as AppSession | null;
  if (session == null) {
    const { SessionInvalidError } = await import('./errors');
    throw new SessionInvalidError('No active session');
  }
  return session;
}

export async function requireOperatorSession(): Promise<AppSession> {
  const session = await requireSession();
  if (!session.roles.includes('paperclip-ops:operator')) {
    const { AuthProxyError } = await import('./errors');
    throw new AuthProxyError('Missing paperclip-ops:operator role', 403);
  }
  return session;
}
