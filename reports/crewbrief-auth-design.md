# CRE-629: Auth Design Recommendation — CrewBrief v1

**Author:** Hunter — CTO
**Date:** 2026-05-17
**Status:** Design recommendation (pending implementation)

---

## Executive Summary

CrewBrief v1 currently has **zero authentication** — all API calls are unauthenticated, feedback submissions use `userId: "anonymous"`, and no user/resource isolation exists. For a beta targeting 10–20 aviation operators (each with multiple crew members), this is untenable:

- No way to associate feedback/ratings with real crew identities
- No protection against unauthorized briefing access
- No audit trail for quality/feedback data
- No path to per-operator billing or role-based access

This document recommends a **JWT-based auth system** using email+password authentication, with a simple crew membership model mapping users to operators.

---

## Recommendation: JWT Bearer Auth with Crew Membership

### Architecture

```
[iOS App] → Bearer JWT → [Express Middleware] → [req.actor] → [Route Handlers]
                                ↑
                    [auth_users] + [crew_members] tables
```

### Why JWT (not session, OAuth, or API-key-only)

| Criterion | JWT | Cookie Session | OAuth2/OIDC | API Key Only |
|-----------|-----|---------------|-------------|--------------|
| Mobile-friendly | ✅ Stateless, no cookie store needed | ⚠️ Requires cookie sharing with API | ✅ Industry standard | ✅ Simple header |
| Offline-capable | ✅ Token cached in secure-store | ❌ Session dies on expiry | ❌ Needs refresh flow | ✅ Static key |
| Revokable at user level | ✅ Short expiry + refresh token | ✅ Server-side session delete | ✅ IdP controls | ❌ Key rotation pain |
| Implementation effort | ~2-3 days | ~1-2 days | ~1 week+ IdP setup | ~1 day |
| Upgrade path to OAuth2/OIDC | ✅ Trivial (swap library) | ⚠️ Different paradigm | N/A | ⚠️ Major refactor |
| Aviation audit readiness | ✅ Standard for mobile APIs | ✅ Acceptable | ✅ Gold standard | ❌ Hard to audit per-user |

**Verdict:** JWT is the best fit — simple enough for v1, standard enough for aviation compliance, upgrade path to OAuth2/OIDC when operators demand SSO.

---

## Database Schema

### auth_users

Note: If merging into the existing Paperclip monorepo, consider reusing the existing `authUsers` table from `packages/db/src/schema/`. For the standalone CrewBrief API, a minimal user table:

```ts
// packages/db/src/schema/crew_auth_users.ts
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const crewAuthUsers = pgTable("crew_auth_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "operator", "crew"] }).notNull().default("crew"),
  operatorId: uuid("operator_id"), // nullable — crew belong to an operator
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"), // soft delete
});
```

### crew_members (if operators need to manage crews separately from auth)

```ts
// packages/db/src/schema/crew_members.ts
export const crewMembers = pgTable("crew_members", {
  id: uuid("id").defaultRandom().primaryKey(),
  operatorId: uuid("operator_id").notNull(), // FK → auth_users for operator/org
  userId: uuid("user_id").notNull(),         // FK → crew_auth_users
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**Key decision:** For v1 beta with 10–20 operators, keep it flat — a single `crew_auth_users` table with `role` and `operatorId`. Introduce `crew_members` only if operators need hierarchical crew management before v1 launch.

---

## API Endpoints

### POST /api/auth/register

Register a new user (invite-only for beta, gated by an invite code).

```ts
Request:  { email, password, name, inviteCode? }
Response: { user: { id, email, name, role }, token, refreshToken }
Status:   201
```

- `inviteCode` is optional for beta; can be validated against a static `BETA_INVITE_CODE` env var or a DB-backed invite table.
- Password is hashed with bcrypt (cost 12).
- Returns `201` with JWT + refresh token on success.

### POST /api/auth/login

Login with email + password.

```ts
Request:  { email, password }
Response: { user: { id, email, name, role }, token, refreshToken }
Status:   200
```

- JWT payload: `{ sub: userId, email, role, operatorId?, iat, exp }`
- Token expiry: **15 minutes** (access token)
- Refresh token: **7 days** (opaque, stored hashed in DB)

### POST /api/auth/refresh

Exchange a refresh token for a new access token.

```ts
Request:  { refreshToken }
Response: { token, refreshToken } // new access token + rotated refresh token
Status:   200
```

- Refresh token rotation: old token is invalidated, new one issued.
- If a refresh token is reused after rotation (compromised), both old and new are revoked.

### GET /api/auth/me

Get current user profile. Requires `Authorization: Bearer <token>`.

```ts
Response: { id, email, name, role, operatorId, createdAt }
Status:   200
```

### PATCH /api/auth/password

Change password. Requires `Authorization: Bearer <token>`.

```ts
Request:  { currentPassword, newPassword }
Response: { ok: true }
Status:   200
```

---

## Middleware

### requireAuth middleware

```ts
// server/src/middleware/crew-auth.ts
import jwt from "jsonwebtoken";
import type { RequestHandler } from "express";

declare global {
  namespace Express {
    interface Request {
      crewUser?: {
        id: string;
        email: string;
        role: "admin" | "operator" | "crew";
        operatorId?: string;
      };
    }
  }
}

export function requireAuth(...allowedRoles: string[]): RequestHandler {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing authorization header" });
    }

    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
      if (allowedRoles.length > 0 && !allowedRoles.includes(payload.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      req.crewUser = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        operatorId: payload.operatorId,
      };
      next();
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}
```

### Route protection matrix

| Endpoint | Method | Auth Required | Role Check |
|----------|--------|---------------|------------|
| `/api/auth/register` | POST | No (invite code) | — |
| `/api/auth/login` | POST | No | — |
| `/api/auth/refresh` | POST | No (refresh token) | — |
| `/api/auth/me` | GET | Yes | — |
| `/api/auth/password` | PATCH | Yes | — |
| `/api/briefings/:tripId/:dutyDayId` | GET | Yes | crew, operator, admin |
| `/api/feedback/briefing` | POST | Yes | crew, operator, admin |
| `/api/feedback/briefing` | GET | Yes | operator, admin |
| `/api/feedback/briefing/trends` | GET | Yes | operator, admin |
| `/api/quality/classify` | POST | Yes | admin, operator |
| `/api/quality/:briefingId` | GET | Yes | crew, operator, admin |
| `/api/quality/summary/all` | GET | Yes | operator, admin |

---

## iOS App Integration

### Token Storage

Use `expo-secure-store` for token persistence:

```ts
import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "crewbrief-auth-token";
const REFRESH_KEY = "crewbrief-refresh-token";

async function saveTokens(token: string, refreshToken: string) {
  await Promise.all([
    SecureStore.setItemAsync(TOKEN_KEY, token),
    SecureStore.setItemAsync(REFRESH_KEY, refreshToken),
  ]);
}

async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}
```

### Auth Flow in the App

1. **On launch**: Check for stored token in SecureStore
2. **Token valid**: Navigate to HomeScreen (pre-filled with user context)
3. **Token expired**: Attempt silent refresh via `/api/auth/refresh`
4. **Refresh fails**: Navigate to LoginScreen
5. **On login/register success**: Store tokens, navigate to Home
6. **On logout**: Clear tokens, navigate to Login

### Auth HTTP Client

Wrap `fetch` to automatically attach the Authorization header and handle 401 → refresh → retry:

```ts
async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  const headers = { ...options.headers, Authorization: `Bearer ${token}` };
  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      const newToken = await getToken();
      return fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${newToken}` } });
    }
    // Navigate to login
    throw new AuthError("Session expired");
  }
  return res;
}
```

### Proposed New / Modified Screens

1. **LoginScreen** (NEW) — Email + password form, "Register" link
2. **RegisterScreen** (NEW) — Email + password + name + invite code (optional)
3. **HomeScreen** (MODIFY) — Remove API URL input (derive from env/config); auto-populate user context
4. **SettingsScreen** (NEW) — Change password, logout, app version

---

## Package Dependencies

### server/

```json
{
  "dependencies": {
    "bcrypt": "^5.1.0",
    "jsonwebtoken": "^9.0.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@types/bcrypt": "^5.0.0",
    "@types/jsonwebtoken": "^9.0.0",
    "@types/uuid": "^9.0.0"
  }
}
```

### packages/crewbrief-app/

```json
{
  "dependencies": {
    "expo-secure-store": "~13.0.0"
  }
}
```

---

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `JWT_SECRET` | HMAC secret for signing JWTs | (required, no default) |
| `JWT_EXPIRY` | Access token lifetime | `15m` |
| `REFRESH_TOKEN_EXPIRY` | Refresh token lifetime | `7d` |
| `BETA_INVITE_CODE` | Optional invite code for signup | (empty = open registration) |
| `BCRYPT_ROUNDS` | bcrypt cost factor | `12` |

---

## Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Token theft from device | expo-secure-store uses iOS Keychain (hardware-backed encryption) |
| Token replay | 15-min expiry; refresh token rotation invalidates stolen refresh tokens |
| Brute-force login | Rate-limit `/api/auth/login` (e.g., 5 attempts/15min per IP/email) |
| Weak passwords | Enforce minimum length (8+ chars); consider zxcvbn for v1.1 |
| Aviation data sensitivity | All API calls over HTTPS only; HSTS headers on API responses |
| Audit trail | Log all auth events (login, register, password change, token refresh) |
| Operator data isolation | All queries scoped by `operatorId` to prevent cross-operator data leaks |

---

## Migration Plan (from unauthenticated v0.1)

1. **Phase 1 — Auth backend** (2-3 days)
   - Add `crew_auth_users` table + migration
   - Implement auth routes (register, login, refresh, me, password)
   - Implement `requireAuth` middleware
   - Add role-based route protection to all existing CrewBrief endpoints

2. **Phase 2 — Mobile app** (2-3 days)
   - Add `expo-secure-store` dependency
   - Create LoginScreen + RegisterScreen
   - Modify navigation flow (login gate before HomeScreen)
   - Add `authenticatedFetch` wrapper
   - Update all existing API calls to use authenticated client
   - Remove `apiUrl` from HomeScreen (derive from env/config constant)

3. **Phase 3 — Admin/invite flow** (1-2 days)
   - Invite code creation (CLI or admin endpoint)
   - Operator dashboard stub (list crew members)
   - Password reset flow (POST /api/auth/forgot-password + email)

**Total v1 auth implementation: ~5-8 days**

---

## Future Considerations (Post-v1)

- **OAuth2/OIDC integration** — Replace local JWT with an external IdP (Okta, Azure AD) for enterprise operators
- **Push notification auth** — APNs token tied to user session for targeted brief alerts
- **API key for server-to-server** — The Telegram delivery scripts on `master` (`send-briefing.sh`, `send-briefing-telegram.sh`) will need a long-lived server API key (not user-bound) to continue delivering briefings via Telegram without user login
- **Row-level security** — Postgres RLS policies on all briefing/feedback tables for defense-in-depth
- **Offline auth** — Cached token + biometric unlock (Face ID) for offline briefing access
