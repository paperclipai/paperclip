# K8s Execution Target Changelog

## 2026-05-09 — Phase A complete

Workspace strategy + realization types now live in @paperclipai/workspace-strategy.
@paperclipai/shared re-exports them so existing callers were not modified.
Callers may opt to migrate imports in a follow-up; this PR keeps blast radius
to the smallest reasonable cross-section.

## 2026-05-09 — Phase C: server callback routes (M2 Tasks 13–16)

Three callback endpoints used by the in-cluster agent shim are now mounted in
the Paperclip server when `PAPERCLIP_RUN_JWT_SECRET` is configured:

- `POST /api/agent-auth/exchange` — bootstrap token → run JWT (HS256, 1h TTL).
- `POST /api/runs/:runId/events` — run JWT-authed structured event ingestion;
  events land in `heartbeat_run_events` keyed by `(runId, seq)`.
- `POST /api/workspace/git-credentials` — run JWT-authed short-TTL git creds.

Rate limits (in-memory sliding window per replica):
- `/agent-auth/exchange`: 10/min/IP (companyId is unknown until token validates).
- `/runs/:runId/events`: 1000/min keyed by URL `:runId`.
- `/workspace/git-credentials`: 30/min keyed by JWT runId claim, falling back
  to client IP if no valid JWT presented.

**Deferred to M3:**
- Live git-credentials issuance (GitHub App installation tokens, per-tenant
  deploy tokens). M2 ships the route and auth contract; the issuer currently
  always returns `503 not_configured`. Wiring is a single-function swap on the
  `issueGitCredentials` dependency.
- Distributed rate limiting. The in-memory limiter is per-replica; multi-replica
  deployments should lift this to Redis or a fronting proxy (Envoy/NGINX).
- `PAPERCLIP_RUN_JWT_SECRET` must be supplied as an external secret. The route
  factory fails fast at boot if it's unset, so deployments never silently
  generate per-restart keys (which would invalidate every in-flight JWT).
