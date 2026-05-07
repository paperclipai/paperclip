# Changelog

All notable changes to IronWorks are documented in this file.

## [Unreleased]

### Security
- **Email webhook provider signature verification** (`server/src/routes/messaging.ts`,
  `server/src/lib/webhook-signatures.ts`): inbound `/api/webhooks/email` now verifies
  Mailgun (`X-Mailgun-Signature-256`, HMAC-SHA256) and SendGrid
  (`X-Twilio-Email-Event-Webhook-Signature` / `-Timestamp`, Ed25519) when the
  matching env var is set (`MAILGUN_WEBHOOK_SIGNING_KEY`,
  `SENDGRID_WEBHOOK_PUBLIC_KEY`). A valid provider signature satisfies authentication
  without the legacy static `IRONWORKS_EMAIL_WEBHOOK_SECRET` token. Backward compatible:
  deployments with neither env var set behave as before. Boot-time warning logs once
  when signing keys are missing. Pure helpers + 16 unit tests + 4 route integration tests.
- **Routine trigger HMAC enforcement** (`POST /routine-triggers/public/:publicId/fire`):
  reaffirmed — the existing implementation in `server/src/services/routines.ts` already
  enforces HMAC-SHA256 signed-timestamp verification (`signingMode: "hmac_sha256"`) or
  bearer token (`signingMode: "bearer"`) using `crypto.timingSafeEqual` and
  `companySecrets`-backed encrypted secret storage. No schema change needed; the proposed
  inline `hmac_secret TEXT` column was rejected as a regression vs. the existing
  encrypted-secret reference design.

### Added - HTTP Adapter Family (2026-04-20)
- **Four production HTTP adapters**: `poe-api`, `anthropic-api`, `openai-api`,
  `openrouter-api`. Agents can now call external LLM APIs without a local CLI installed.
- **Shared HTTP substrate** in `packages/adapter-utils/src/http/` (16 modules, 314 tests)
  covering retry with exponential backoff, per-provider rate limiting, SSE/chunked-JSON
  streaming, bidirectional tool-call normalization (AJV), full-transcript session replay,
  and schema-aware secret redaction.
- **Workspace provider secrets**: `workspace_provider_secrets` table (migration 0085),
  AES-256-GCM envelope encryption (`secrets-vault`), workspace-scoped REST API
  (`/providers`), and Settings - Providers UI. Keys are never echoed; last-4 displayed only.
- **Per-adapter test suites**: Poe 46, Anthropic 64, OpenAI 56, OpenRouter 43 tests.
  Workspace total: 1,599+ tests across 209 files.
- **Security mitigations**: R3 tool-call format divergence (AJV normalization), R16
  duplicate tool execution on retry (structural flag guard), R17 stateless HTTP sessions
  (full-transcript replay), R20 regex redaction misses JSON (schema-aware path redactor).
- **Integration smoke harness** (`scripts/test-integration-http-adapters.ts`) for live
  end-to-end validation against real provider APIs.
- **Documentation**: `docs/HTTP-ADAPTER-FAMILY.md` (architecture), `docs/LICENSES.md`
  (dependency analysis), `docs/DEFERRED-MIGRATIONS.md` (roadmap),
  `docs/adapters/provider-settings.md` (user key guide),
  `docs/porting-to-upstream.md` (portability manifest), per-adapter READMEs.
- **New environment variables**: `IRONWORKS_SECRETS_KEK_B64` (required),
  `{PROVIDER}_API_KEY` (optional fallback), `{PROVIDER}_RATE_LIMIT_PER_MIN` (optional),
  `ADAPTER_DISABLE_{PROVIDER}` (kill-switch).

### Added
- Dashboard improvements: Mission Control alignment (StatusBar, QuickActionsGrid, TwoPaneLayout, PageTabBar actions)
- Component-first architecture: 7 oversized files decomposed, barrel exports, shared types directory
- React.memo on 7 list/card components, loading state fix on 14 pages
- Biome linter configuration
- Vitest coverage configuration with v8 provider
- E2E tests triggered on pull requests
- OG metadata and meta description

### Changed
- Tabs default to line variant with primary-colored accent border
- Card component gains accentColor and fadeOverflow props
- Dashboard section titles now link to their full pages
- LICENSE copyright updated to Steel Motion LLC

### Security
- Path traversal prevention on file-serving routes
- SSRF protection extended with IPv6 private ranges
- Timing-safe token comparison in board-claim
- Prompt injection patterns expanded from 5 to 16
- Dependency overrides for rollup, kysely, vite, lodash-es CVEs

### Fixed
- 9 icon-only buttons missing aria-labels
- docs.json GitHub links pointed to wrong org

## [0.3.1] - 2026-04-08

### Added
- @mention agent-to-agent waking + board user icon
- Agent chat architecture with Response Router
- Channel message posting from heartbeat runs
- AI-native governance seed docs (30 templates)
- Nolan integration (12 requirements)
- Deliverables workflow, threads, session handling, decision log

### Changed
- Heartbeat interval configurable, default 30s
- Diversified model assignments with automatic fallback
- Agents conversational when no issues assigned

### Security
- 107 tests for security-critical code paths
- WCAG 2.1 AA compliance (16 violations fixed)
- Rate limit increased to 600/min, heartbeat paths exempt

### Fixed
- Channel extraction and response formatting
- Docker build ordering (db+shared before server)
- Sidebar scroll, panel clipping
- Billing subscription 404 console noise
