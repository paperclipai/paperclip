---
title: Support Case Assessment — Google OAuth Sign-In
summary: Google OAuth social sign-in alongside email/password authentication (better-auth)
version: voy-1420-posthog-p2-fixes (96faa13434)
status: ready — code committed and reviewed, awaiting env vars from founder (VOY-406)
---

# Support Case Assessment: Google OAuth Sign-In

**Author:** Support Engineer (88b72065)
**Date:** 2026-08-19
**Last updated:** 2026-08-19 (96faa13434 — auth hooks structural hardening)
**Branch:** `voy-1420-posthog-p2-fixes`
**Status:** Ready — code committed and reviewed by Staff Engineer + CTO, awaiting env vars from founder (VOY-406)

---

## Feature Overview

The Voyonder authentication system (built on `better-auth`) now supports **Google OAuth sign-in** as a second authentication method alongside email/password. Users can sign in or sign up with their Google account via a "Sign in with Google" button on the Auth page.

### How It Works

1. **UI:** The Auth page (`/api/auth/sign-in` or `/sign-up`) shows a "Sign in with Google" button above the email/password form, separated by a visual divider ("or continue with email").

2. **API flow:** Clicking the button calls `POST /api/auth/sign-in/social` with `{ provider: "google", callbackURL }`. The server responds with a redirect URL (Google's OAuth consent page). The browser navigates to Google, and on success Google redirects back to the configured callback URL.

3. **Server-side:** `better-auth` handles the OAuth handshake. On successful authentication, better-auth creates or links a user account and establishes a session. The auth instance is configured with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` environment variables — if these are not set, the Google option is disabled (gracefully omitted from the auth config).

4. **PostHog events:** Two new business events are captured:
   - `auth.signup_completed` — Fired when a user account is created (regardless of login method)
   - `auth.session_started` — Fired when a new session is created (login)
   Both events include a `login_method` property (`"google"`, `"email"`, or `"unknown"`) identifying the auth method used.

   **Telemetry resilience:** PostHog calls in auth hooks are fire-and-forget — the `captureMetric()` function is synchronous and is never awaited (the enclosing hook is kept `async` only for better-auth type contract compliance). If PostHog is unreachable, slow, or misconfigured, the auth response (sign-in/sign-up) is never delayed or blocked. Errors are silently caught in a `try/catch` block within the hook.

### What It Does NOT Do

- Does not replace email/password authentication — both methods remain available
- Does not require email verification for Google accounts (email verification is disabled in the current config)
- Does not support other social providers (Facebook, GitHub, etc.) — only Google is configured
- Does not affect existing user accounts — users who signed up via email continue to sign in via email

## Configuration

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | No (optional) | Google OAuth app client ID. If not set, the Google sign-in button is hidden. |
| `GOOGLE_CLIENT_SECRET` | No (optional) | Google OAuth app client secret. Must be set alongside `GOOGLE_CLIENT_ID`. |

### Google Cloud Setup

To enable Google OAuth:
1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/)
2. Configure the OAuth consent screen (External user type for production)
3. Create OAuth 2.0 credentials (Web application type)
4. Add the redirect URI to match the app's auth callback path: `{authBaseURL}/callback/google` (e.g., `https://voyonder.com/api/auth/callback/google`)
5. Copy the Client ID and Client Secret to the server environment

### Runtime Detection

The Google OAuth provider is only activated at server startup if both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set and non-empty. If either is missing or blank, the server starts without Google OAuth and the Auth page renders the email/password form only (no Google button).

## PostHog Business Events

### New Auth Events

| Event Name | Source | Trigger | distinctId | Properties |
|---|---|---|---|---|
| `auth.signup_completed` | better-auth database hook (`user.create.after`) | A new user account is created (sign-up via email or Google OAuth) | `userId` | `login_method` ("google", "email", or "unknown") |
| `auth.session_started` | better-auth database hook (`session.create.after`) | A new session is created (sign-in via email or Google OAuth) | `userId` (sic — currently `session.userId`, the user who logged in) | `login_method` ("google", "email", or "unknown") |

### distinctId Note

Auth events use the **user's ID** as the PostHog distinct ID (not the company's ID, unlike approval/digest business events). This is because auth events fire before a company context exists (during login/signup).

### Querying Auth Events

```bash
# Query sign-up events
curl -s "https://us.posthog.com/api/projects/{project_id}/events/?event=auth.signup_completed" \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY"

# Query session start events
curl -s "https://us.posthog.com/api/projects/{project_id}/events/?event=auth.session_started" \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY"
```

## Known Limitations

| Limitation | Description | Workaround |
|---|---|---|
| Google-only social provider | Only Google OAuth is implemented; no GitHub, Facebook, or other providers | Extend `authConfig.socialProviders` in `better-auth.ts` |
| Env-var gated | Google OAuth is disabled entirely if env vars are missing | Set both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` |
| No email verification | `requireEmailVerification` is `false` — Google-created accounts skip email verification | Configuration change in better-auth if needed |
| No account linking | If an email already exists as an email/password account, logging in with Google creates a separate account | Not yet implemented — may cause user confusion if the same email has two accounts |
| Auth events use `userId` distinctId | Auth business events use user ID (not company ID) as the distinct ID | Per-company analytics for auth events are not directly available; query by user-to-company mapping |
| Login method detection graceful fallback | If `ctx.request.url` is missing or malformed (e.g., behind a proxy with an unexpected URL format), `resolveLoginMethod()` returns `"unknown"` — the auth flow succeeds but the `login_method` property is ambiguous | Check the server's reverse proxy configuration if `login_method` is consistently `"unknown"` for valid sign-ins |

## Troubleshooting

### Problem: Google sign-in button does not appear

1. Check that both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` environment variables are set and non-empty
2. Restart the server — Google OAuth is only configured at startup, not hot-reloaded
3. Verify the server logs don't show an error related to better-auth configuration

### Problem: "Sign in with Google" shows "Connecting…" but redirects nowhere

1. Check browser console for network errors on `POST /api/auth/sign-in/social`
2. Verify the server returns a valid `{ url: string, redirect: boolean }` response
3. Check that Google Cloud Console OAuth credentials have the correct redirect URI: `{authBaseURL}/callback/google`

### Problem: Google redirects to an error page

1. Check that the redirect URI in Google Cloud Console matches exactly (trailing slashes matter)
2. Verify the `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` values match the Google Cloud Console app
3. Check that the Google OAuth consent screen status is "In production" (not "Testing" with unapproved test users)

### Problem: User cannot sign in with Google after signing up via email (or vice versa)

1. This is expected — account linking is not implemented
2. The user's email address is likely registered twice: once via email/password and once via Google
3. Recommended resolution: Delete or merge accounts (requires database access, escalate to CTO)

## Support Escalation Path

| Issue | First Response | Escalation |
|---|---|---|
| Google button not appearing | Check `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` env vars | Engineering: verify better-auth config at startup |
| OAuth redirect errors | Verify Google Cloud Console redirect URI matches | Engineering: check OAuth callback handler |
| PostHog auth events missing | Query PostHog for `auth.signup_completed` / `auth.session_started` events | Engineering: verify database hooks are registered |
| Account linking issues | Explain current limitation (no account linking) | Engineering: implement account merging or linking |

## Related Documentation

- [PostHog Monitoring Triage SOP](../posthog-error-monitoring-triage-sop.md) — includes auth business events
- [Self-Service Onboarding Assessment](support-case-v0.5.0-onboarding.md) — covers the sign-up/sign-in flow
- Auth page UI: `ui/src/pages/Auth.tsx`
- Auth API client: `ui/src/api/auth.ts`
- Server auth config: `server/src/auth/better-auth.ts`