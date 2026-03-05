---
title: Vibe Coding Security Baseline
summary: Paperclip implementation notes for the 30-rule security checklist
---

This baseline maps the 30-rule checklist to Paperclip's current CLI-first deployment model.

## Implemented in runtime

1. Session/JWT TTL:
   - Agent JWTs are short-lived (`PAPERCLIP_AGENT_JWT_TTL_SECONDS`, default 48h).
   - Human session refresh rotation is delegated to Better Auth when authenticated mode is used.
2. Secrets handling:
   - Runtime reads secrets from env/config files, not inline prompt text.
3. Input and auth hardening:
   - Company-scoped authz checks are enforced server-side.
   - API routes now include configurable global and auth-specific rate limits.
4. Storage and uploads:
   - Upload size limits are enforced.
   - Image uploads validate file signature, not only extension/MIME declaration.
5. Cost and operational controls:
   - Budget limits pause agents after overspend.
   - Backup automation includes workflow docs and starter configs.
6. Key rotation:
   - Agent API keys older than `PAPERCLIP_AGENT_API_KEY_MAX_AGE_DAYS` are rejected/revoked.
7. Auditability:
   - Critical actions are activity-logged (including agent key creation/revocation).
8. CORS:
   - Cross-origin access is denied unless same-origin/allowed-host or explicitly allow-listed.

## Guardrails by policy (outside runtime code)

1. Use managed auth providers (Clerk/Supabase/Auth0) when human auth is required.
2. Keep `.gitignore` present from project bootstrap.
3. Rotate external secrets every 90 days.
4. Verify package existence/reputation before install.
5. Prefer targeted dependency upgrades over blind `audit fix`.
6. Keep test and production environments isolated.
7. Keep test webhooks and payment callbacks fully separated from production.

## Notes for CLI-only operators

If your workflow is fully CLI/agent-driven and you do not expose browser login flows, the highest-value controls are:
- strict authz per company
- API key expiry/rotation
- rate limits
- upload validation
- backups + tested restore drills
