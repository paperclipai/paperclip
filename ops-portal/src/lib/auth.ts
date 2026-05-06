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

// Env vars are validated at request time (not module load) so Next.js static
// analysis during build doesn't throw when the vars aren't set yet.
const authConfig: NextAuthConfig = {
  providers: [
    Zitadel({
      issuer: process.env['AUTH_ZITADEL_ISSUER'] ?? '',
      clientId: process.env['AUTH_ZITADEL_ID'] ?? '',
      clientSecret: process.env['AUTH_ZITADEL_SECRET'] ?? '',
      authorization: {
        params: {
          scope:
            'openid profile email urn:zitadel:iam:org:project:roles',
        },
      },
    }),
  ],

  callbacks: {
    async jwt({ token, account, profile }) {
      if (account != null && profile != null) {
        const p = profile as Record<string, unknown>;
        token['sub'] = (p['sub'] as string | undefined) ?? token['sub'];
        token['email'] = (p['email'] as string | undefined) ?? token['email'];
        token['roles'] = extractZitadelRoles(p);
      }
      return token;
    },

    async session({ session, token }: { session: Session; token: JWT }) {
      const s = session as Session & { roles: string[] };
      s.roles = (token['roles'] as string[] | undefined) ?? [];
      if (typeof token['email'] === 'string' && s.user != null) {
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
  if (!process.env['AUTH_ZITADEL_ISSUER'] || !process.env['AUTH_ZITADEL_ID'] || !process.env['AUTH_ZITADEL_SECRET']) {
    throw new OIDCConfigurationError('AUTH_ZITADEL_ISSUER / AUTH_ZITADEL_ID / AUTH_ZITADEL_SECRET are not set');
  }
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
