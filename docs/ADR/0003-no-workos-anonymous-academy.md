# ADR 0003 — Strip WorkOS for the Academy; anonymous + opt-in OTP

**Date**: 2026-04-29
**Status**: Accepted

## Context

`learnovaBeast` ships with WorkOS AuthKit deeply integrated (cross-portal SSO, role-based access control, M2M token flows). WorkOS is correct for the existing B2B Learnova portals but wrong for Koenig AI Academy:

- Academy is **free, B2C** — login walls hurt conversion and SEO crawlability
- WorkOS pricing is meaningful at scale; a free product shouldn't carry that
- Most learners just want to read; only a minority want progress tracking + certificates

## Decision

For the Academy:

1. **Anonymous browsing for everything**. No login required to read courses, take quizzes, complete lessons.
2. **Optional Convex email-OTP** (Resend free tier) only for users who want progress tracking + certificates. Opt-in, never gated.
3. **Strip WorkOS via `AUTH_MODE=anonymous` feature flag** in the Academy Vercel project. The middleware no-ops when the flag is set.
4. **Other Learnova portals (TC / Sales / Admin) keep WorkOS** — flag is per-deployment, not per-repo.

## Consequences

✅ Pros:
- SEO crawlable everywhere
- Zero conversion friction
- No paid auth bill for the Academy
- "Anonymous + opt-in OTP" matches B2C free-product norms

❌ Cons:
- Anonymous-session ID via cookie + localStorage fallback adds a small surface for backend code
- Cross-device progress requires the OTP path (acceptable)
- Certificate flow waits for the OTP path

## Implementation

- Add `AUTH_MODE` env var (default `anonymous` for Academy, default `workos` everywhere else)
- Wrap `authkitMiddleware` in `learnova-student/src/middleware.ts` with a guard
- Replace `user.id` reads with `getSessionId()` that returns either OTP-user-id or anonymous-session-id
- Add Convex `users.anonymousMerge` mutation: when an anonymous learner signs in via OTP, merge their progress into the OTP account
- Add Resend integration for OTP send
