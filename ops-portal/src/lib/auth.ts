import NextAuth from 'next-auth';
import type { NextAuthConfig, Session, User } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import Zitadel from 'next-auth/providers/zitadel';
import { OIDCConfigurationError } from './errors';

// The Zitadel role key that grants operator access.  Override via
// OPERATOR_ROLE env var to match whatever key you created in Zitadel.
// Zitadel role keys appear as-is in the token (no project-name prefix).
export const OPERATOR_ROLE: string =
  process.env['OPERATOR_ROLE'] ?? 'paperclip-ops:operator';

// Zitadel returns project roles as a nested map:
// "urn:zitadel:iam:org:project:roles": { "roleName": { "orgId": "orgName" } }
function extractZitadelRoles(claims: Record<string, unknown>): string[] {
  const raw = claims['urn:zitadel:iam:org:project:roles'];
  if (raw == null || typeof raw !== 'object') return [];
  return Object.keys(raw as Record<string, unknown>);
}

// Decode a JWT payload without verifying (we trust account.id_token because
// it was just delivered to us over TLS by next-auth's OIDC code-exchange).
function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  const rawPayload = parts[1];
  if (parts.length !== 3 || rawPayload == null) return {};
  try {
    // base64url → base64 → buffer
    const payload = rawPayload.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(payload + padding, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

// Roles can land in different places depending on which OIDC assertion
// flags Zitadel has set:
//   - idTokenRoleAssertion: true   → in the ID token claims
//   - userinfo via /userinfo       → in the `profile` arg next-auth passes
// NextAuth v5's Zitadel provider may not surface the custom
// `urn:zitadel:iam:org:project:roles` claim through `profile`, so fall
// back to decoding the id_token directly.
function pickRoles(
  profile: Record<string, unknown> | undefined,
  idToken: string | undefined,
): string[] {
  if (profile) {
    const fromProfile = extractZitadelRoles(profile);
    if (fromProfile.length > 0) return fromProfile;
  }
  if (idToken) {
    return extractZitadelRoles(decodeJwtClaims(idToken));
  }
  return [];
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
      if (account != null) {
        const p = (profile ?? {}) as Record<string, unknown>;
        token['sub'] = (p['sub'] as string | undefined) ?? token['sub'];
        token['email'] = (p['email'] as string | undefined) ?? token['email'];
        token['roles'] = pickRoles(
          profile as Record<string, unknown> | undefined,
          account.id_token as string | undefined,
        );
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
      const hasRole = (auth?.roles ?? []).includes(OPERATOR_ROLE);
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
  if (!session.roles.includes(OPERATOR_ROLE)) {
    const { AuthProxyError } = await import('./errors');
    throw new AuthProxyError('Missing paperclip-ops:operator role', 403);
  }
  return session;
}
