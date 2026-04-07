# Rust Paperclip Design Spec
**Date:** 2026-04-07
**Repo target:** `stackarmor/paperclip`
**Status:** Approved

---

## Overview

A full-featured Rust port of Paperclip AI — a local AI agent orchestration platform. The Rust version preserves complete feature parity with the Node.js original while eliminating Node.js from the production runtime entirely, achieving FIPS-validated cryptography throughout, and delivering a single self-contained binary.

### Goals
- Full feature parity with Paperclip AI (agent orchestration, task tracking, scheduler, remote agent pairing, org hierarchy, board approval)
- FIPS 140-2/3 compliant cryptography via `aws-lc-rs` (fips feature, 64-bit targets)
- Zero Node.js at runtime — single binary ships everything including the React UI
- Minimal, audited crate allowlist (same philosophy as Peregrine) to minimize CVE surface
- Runs locally out of the box: `paperclip start`

### Non-Goals
- Rewriting the React/Vite/Tailwind UI (existing UI is embedded as-built)
- Supporting 32-bit targets for FIPS (aws-lc-rs FIPS module is 64-bit only; non-FIPS build still works on 32-bit)
- Microservices or distributed deployment in v1

### Build Strategy
Core-first, then iterate. Phase 1 delivers a running binary with agent management and task tracking. Later phases add scheduler, remote pairing, and full org governance.

---

## Crate Allowlist

Same philosophy as Peregrine. No crate added without justification.

| Crate | Version | Purpose |
|---|---|---|
| `tokio` | 1.x | Async runtime |
| `axum` | 0.8 | HTTP server, WebSocket |
| `reqwest` | 0.12 | HTTP client (adapter calls) |
| `serde` / `serde_json` | 1.x | Serialization |
| `rusqlite` | 0.39 (bundled) | SQLite — primary DB |
| `sqlx` | 0.8 (optional) | PostgreSQL — optional feature flag |
| `aws-lc-rs` | 1.x (fips on 64-bit) | All crypto: AES-256-GCM, HMAC-SHA256, SHA-256, ED25519 |
| `rustls` | 0.23 | TLS |
| `tokio-tungstenite` | 0.28 | WebSocket client (OpenClaw gateway) |
| `tokio-rustls` | 0.26 | Async TLS |
| `rust-embed` | 8.x | Embed React UI assets into binary |
| `clap` | 4.5 | CLI argument parsing |
| `anyhow` | 1.x | Error propagation |
| `thiserror` | 2.x | Typed error definitions |
| `uuid` | 1.x (v4) | UUID generation |
| `chrono` | 0.4 | Timestamps |
| `chrono-tz` | 0.10 | IANA timezone-aware cron scheduling |
| `cron` | 0.15 | Cron expression parsing |
| `tracing` / `tracing-subscriber` | 0.1/0.3 | Structured logging |
| `async-trait` | 0.1 | Async trait methods |
| `dashmap` | 6 | Concurrent agent state map |
| `parking_lot` | 0.12 | Poisoning-free mutexes |
| `rand` | 0.10 | CSPRNG (token generation) |
| `toml` | 1.x | Config file parsing |
| `base64` | 0.22 | JWT encoding, asset encoding |
| `futures-util` | 0.3 | Async stream utilities |
| `mime_guess` | 2.x | MIME types for embedded assets |
| `tempfile` | 3.x | Backup staging |

---

## Workspace Structure

```
paperclip/                        # git root — stackarmor/paperclip
├── Cargo.toml                    # workspace: members = ["crates/*"]
├── Cargo.lock
├── build.rs                      # npm ci && npm run build in ui/, feeds rust-embed
├── crates/
│   ├── paperclip-core/           # domain types, DB, migrations, secrets, crypto
│   ├── paperclip-adapters/       # AdapterModule trait + all 10 adapter impls
│   ├── paperclip-api/            # Axum router, REST routes, WebSocket, auth
│   ├── paperclip-scheduler/      # cron engine, routine execution, webhook triggers
│   └── paperclip-cli/            # binary entrypoint, clap subcommands, startup
└── ui/                           # existing React/Vite frontend (source, not modified)
    ├── package.json
    └── dist/                     # generated at build time, embedded by rust-embed
```

---

## Crate Details

### `paperclip-core`

**Responsibilities:** domain types, database access, migration runner, secrets/crypto.

**Domain types** (Rust structs with `serde` derives, matching Paperclip's TypeScript interfaces):
- `Agent`, `AgentDetail`, `AgentStatus`, `AgentRole`, `AgentAdapterType`
- `Issue`, `IssueStatus`, `IssuePriority`, `HeartbeatRun`
- `Routine`, `RoutineTrigger`, `RoutineRun`, `ConcurrencyPolicy`, `CatchUpPolicy`
- `Company`, `Project`, `Goal`, `Approval`, `ApprovalType`, `ApprovalStatus`
- `JoinRequest`, `Invite`, `CompanyMembership`, `PrincipalPermissionGrant`
- `CompanySecret`, `EnvBinding` (`Plain | SecretRef`)
- `AgentConfigRevision`, `AgentRuntimeState`, `AgentTaskSession`
- `ExecutionWorkspace`, `IssueComment`, `IssueApproval`, `ActivityLog`
- `CostEvent`, `BudgetPolicy`

**Database:**
- `rusqlite` with `bundled` feature (no system SQLite dependency)
- `Db` type: `Arc<Mutex<rusqlite::Connection>>` (SQLite serialized mode)
- Optional PostgreSQL: feature flag `postgres` enables `sqlx::PgPool` behind a `DbPool` enum
- Migrations: numbered `.sql` files embedded with `include_str!`, applied in order on startup
- 64 tables ported from Paperclip's Drizzle schemas to standard `CREATE TABLE` SQL

**Crypto (all via `aws-lc-rs` with `fips` feature on 64-bit):**
- `SecretsCrypto::encrypt(plaintext, master_key) -> CiphertextEnvelope`
  - AES-256-GCM, 12-byte random IV, 16-byte auth tag
  - Envelope: `iv || tag || ciphertext`, stored as hex
- `SecretsCrypto::decrypt(envelope, master_key) -> plaintext`
- `Sha256::hash(data) -> [u8; 32]` — token storage, integrity checks
- `Hmac256::sign(key, data) -> Vec<u8>` — webhook signing
- `Hmac256::verify_timing_safe(key, data, sig) -> bool` — constant-time comparison
- `Jwt::sign(claims, secret) -> String` — HS256 agent JWT
- `Jwt::verify(token, secret) -> Result<Claims>` — HS256 verification
- `Ed25519::generate_keypair()` — OpenClaw device key generation
- `Csprng::random_bytes(n)` — secure token generation

**Secrets providers** — `trait SecretProvider`:
- `LocalEncryptedProvider` — master key from `~/.paperclip/instances/default/secrets/master.key` or `PAPERCLIP_MASTER_KEY` env var
- `AwsSecretsManagerProvider`
- `GcpSecretManagerProvider`
- `VaultProvider`

---

### `paperclip-adapters`

**Responsibilities:** define the adapter contract, implement all 10 adapters, expose a registry.

**Core trait:**
```rust
#[async_trait]
pub trait AdapterModule: Send + Sync {
    fn adapter_type(&self) -> &'static str;
    async fn execute(&self, ctx: ExecutionContext) -> Result<ExecutionResult>;
    async fn test_environment(&self, ctx: EnvTestContext) -> Result<EnvTestResult>;
    async fn list_skills(&self, ctx: SkillContext) -> Option<Result<SkillSnapshot>> { None }
    async fn sync_skills(&self, ctx: SkillContext, desired: Vec<String>) -> Option<Result<SkillSnapshot>> { None }
    async fn on_hire_approved(&self, payload: HireApprovedPayload) -> Result<()> { Ok(()) }
    fn supports_local_agent_jwt(&self) -> bool { false }
    fn session_management(&self) -> SessionManagement { SessionManagement::Ephemeral }
    fn configuration_doc(&self) -> &'static str { "" }
}
```

**`ExecutionContext`:**
```rust
pub struct ExecutionContext {
    pub run_id: Uuid,
    pub agent: Agent,
    pub config: serde_json::Value,      // adapterConfig JSONB
    pub runtime: serde_json::Value,     // runtimeConfig JSONB
    pub context: serde_json::Value,     // execution context (workspace, etc.)
    pub auth_token: Option<String>,     // agent JWT if supported
    pub on_log: Arc<dyn Fn(LogStream, String) -> BoxFuture<'static, ()> + Send + Sync>,
    pub on_spawn: Option<Arc<dyn Fn(SpawnMeta) -> BoxFuture<'static, ()> + Send + Sync>>,
}
```

**10 adapter implementations:**

| Module | Execution mechanism | Notes |
|---|---|---|
| `process` | `tokio::process::Command` | command, args, cwd, env, timeoutSec, graceSec |
| `http` | `reqwest::Client::post` | url, method, headers, payloadTemplate, timeoutSec |
| `claude_local` | `reqwest` → Claude API | model, API key, session codec |
| `gemini_local` | `reqwest` → Gemini API | model, API key |
| `codex_local` | `reqwest` → Codex API | model, API key |
| `opencode_local` | `reqwest` → OpenCode API | model, API key |
| `hermes_local` | `reqwest` → Hermes API | hermes config |
| `pi_local` | `reqwest` → PI API | model config |
| `cursor` | `reqwest` → Cursor API | cursor instance config |
| `openclaw_gateway` | `tokio-tungstenite` WebSocket | gateway URL, device key, pairing flow |

**OpenClaw gateway specifics:**
- WebSocket connection with `x-openclaw-auth` / `x-openclaw-token` headers
- Protocol v3 frame types: `GatewayRequestFrame`, `GatewayResponseFrame`, `GatewayEventFrame`
- Auto-pair on first connect (`autoPairOnFirstConnect`): calls `device.pair.list` + `device.pair.approve`
- ED25519 device keypair generated via aws-lc-rs, SPKI-encoded in auth payload
- Session key strategies: `issue` → `paperclip:issue:{id}`, `run` → `paperclip:run:{id}`, `fixed` → configured key

**Adapter registry:**
```rust
pub struct AdapterRegistry(HashMap<&'static str, Box<dyn AdapterModule>>);

impl AdapterRegistry {
    pub fn default() -> Self {
        let mut r = Self::new();
        r.register(ProcessAdapter::new());
        r.register(HttpAdapter::new());
        r.register(ClaudeLocalAdapter::new());
        // ... all 10
        r
    }
}
```

**Execution concurrency:** each `execute()` call is `tokio::spawn`ed. Per-agent concurrency limited by `Arc<Semaphore>` stored in `AppState` (default: 1 concurrent run per agent, configurable 1–10). `tokio::time::timeout` enforces `timeoutSec`.

---

### `paperclip-api`

**Responsibilities:** HTTP server, REST routes, WebSocket, auth middleware, embedded UI.

**Axum router** — nested routers matching Paperclip's Express API surface exactly (same paths, same JSON response shapes so the React UI works without modification):

```
GET  /api/health
     /api/companies/*
     /api/agents/*              CRUD, wake, approve-hire, skills sync, reset-session, inbox
     /api/issues/*              CRUD, checkout, approve, comments, timeline
     /api/projects/*
     /api/goals/*
     /api/routines/*            CRUD, triggers, manual run, run history
     /api/approvals/*
     /api/secrets/*
     /api/costs/*
     /api/activity/*
     /api/dashboard/*
     /api/sidebar-badges
     /api/invites/*             create, accept, join-request flow, claim-api-key
     /api/instance/*
GET  /live                      WebSocket — real-time event stream
GET  /*                         rust-embed static assets (React SPA, index.html fallback)
```

**Auth middleware** — Axum extractor layer resolving an `Actor` enum:
- `Actor::Board` — `local_trusted` mode, no credentials required
- `Actor::User { user_id, session_id }` — session cookie, SHA-256 hash stored in DB
- `Actor::ApiKey { key_id, company_id }` — `pcp_` prefixed bearer token, SHA-256 hashed
- `Actor::AgentJwt { agent_id, run_id }` — HS256 JWT via aws-lc-rs, `x-paperclip-agent-jwt` header
- `Actor::RunScoped { run_id }` — `x-paperclip-run-id` header for execution context

**WebSocket `/live`:**
- `tokio::sync::broadcast::channel` as the event bus (capacity: 256)
- `LiveEvent` enum covers: `AgentStatusChanged`, `IssueUpdated`, `HeartbeatRunCompleted`, `CostAlert`, `RoutineRunCreated`, `ApprovalRequested`
- Each WS client receives a `broadcast::Receiver`, fans out events as JSON frames
- Ping/pong heartbeat every 30s to detect disconnects

**Embedded UI:**
- `rust-embed` macro points at `../../ui/dist`
- `build.rs` runs `npm ci && npm run build` in `ui/` before compilation
- Axum fallback handler: serve embedded asset by path, fall back to `index.html` for SPA routing
- Content-Type from `mime_guess`

**Shared state:**
```rust
#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub secrets: Arc<dyn SecretProvider>,
    pub adapters: Arc<AdapterRegistry>,
    pub events: broadcast::Sender<LiveEvent>,
    pub config: Arc<InstanceConfig>,
    pub agent_semaphores: Arc<DashMap<Uuid, Arc<Semaphore>>>,
}
```

---

### `paperclip-scheduler`

**Responsibilities:** cron-driven trigger loop, webhook trigger handler, heartbeat worker.

**Scheduler loop** — `tokio::spawn`ed background task:
1. Wake every 10 seconds
2. Query `routine_triggers WHERE kind = 'schedule' AND status = 'active' AND next_run_at <= now()`
3. For each due trigger: apply concurrency policy, create `RoutineRun` + `Issue`, publish `LiveEvent`
4. Update `last_fired_at`, compute and store new `next_run_at` via `cron` + `chrono-tz`
5. Apply catch-up policy on startup for missed ticks

**Cron math:**
- `cron::Schedule::from_str(expr)` — parse 5-field expression
- `schedule.after(&chrono_tz_datetime).next()` — next occurrence in target timezone
- Supports all IANA timezones via `chrono-tz`

**Concurrency policies:**
- `coalesce_if_active` — find open `RoutineRun`, set `coalesced_into_run_id`, status = `coalesced`
- `skip_if_active` — check for open run, record `status = skipped`, skip issue creation
- `always_enqueue` — always create new `RoutineRun` + `Issue`

**Catch-up policies (applied on startup):**
- `skip_missed` — set `next_run_at` to next future tick, no back-fill
- `enqueue_missed_with_cap` — enumerate missed ticks since `last_fired_at`, enqueue up to 25

**Webhook triggers:**
- `POST /api/routines/:id/triggers/:triggerId/fire` (handled in `paperclip-api`, dispatches to scheduler)
- HMAC-SHA256 signature verification via aws-lc-rs (timing-safe)
- Signing modes: `bearer` (Authorization header) or `hmac_sha256` (signature header)
- Replay protection: `idempotency_key` unique constraint in DB, `replay_window_sec` TTL check

**Heartbeat worker** — second `tokio::spawn`ed background task:
1. Poll for agents with `status = active` and queued issues (assigned, not checked out)
2. For each: acquire agent semaphore, `tokio::spawn` adapter execution
3. Create `HeartbeatRun`, call `adapter.execute()`, stream logs to DB via `on_log` callback
4. On completion: update `HeartbeatRun` status, release issue checkout, publish `LiveEvent`
5. On failure: set issue `status = error`, update agent `lastError`, release semaphore

---

### `paperclip-cli`

**Responsibilities:** binary entrypoint, clap subcommands, startup orchestration.

**Subcommands:**
```
paperclip start [--port 3100] [--config <path>]
paperclip migrate [--dry-run]
paperclip backup [--output <path>]
paperclip restore <path>
paperclip agent list
paperclip agent wake <id>
paperclip secret set <name> [--description <desc>]
paperclip secret list
```

**Startup sequence (`paperclip start`):**
1. Load `InstanceConfig` from `~/.paperclip/instances/default/config.toml` (overridable via env vars)
2. Initialize tracing subscriber (JSON or pretty, from config)
3. Open SQLite DB at configured path, run pending migrations
4. Initialize `SecretProvider` (local encrypted by default)
5. Build `AdapterRegistry` with all 10 adapters
6. Create broadcast event channel
7. Build `AppState`
8. Spawn scheduler tokio task
9. Spawn heartbeat worker tokio task
10. Bind Axum on `0.0.0.0:{port}`
11. Await SIGTERM/SIGINT → graceful shutdown (drain in-flight runs, close DB)

**`InstanceConfig` (config.toml):**
```toml
port = 3100
auth_mode = "local_trusted"          # "local_trusted" | "authenticated"
db_path = "~/.paperclip/instances/default/db.sqlite"
log_level = "info"
log_format = "pretty"                # "pretty" | "json"
agent_jwt_ttl_seconds = 172800       # 48 hours
max_concurrent_runs_per_agent = 1

[secrets]
provider = "local_encrypted"         # "local_encrypted" | "aws" | "gcp" | "vault"
master_key_path = "~/.paperclip/instances/default/secrets/master.key"

[storage]
backend = "local"                    # "local" | "s3"
local_path = "~/.paperclip/instances/default/data/storage"
```

---

## Data Model Summary

64 tables ported from Paperclip's Drizzle PostgreSQL schema to SQLite-compatible SQL. Key tables:

| Table | Purpose |
|---|---|
| `companies` | Multi-tenant root, budget config, board approval flag |
| `agents` | Agent identity, status, adapter config, budget, reporting |
| `agent_config_revisions` | Full audit trail of config changes |
| `agent_runtime_state` | Live session state, token counts, last error |
| `issues` | Tasks/subtasks, status, atomic checkout lock |
| `issue_comments` | Threaded discussion |
| `issue_approvals` | Per-issue governance gates |
| `heartbeat_runs` | Single execution instances, logs, token usage |
| `routines` | Scheduled job definitions |
| `routine_triggers` | schedule/webhook/api triggers with next_run_at |
| `routine_runs` | Execution history per trigger fire |
| `projects` | Project containers |
| `project_workspaces` | Execution environments per project |
| `goals` | Hierarchical goal alignment |
| `approvals` | Board approval workflow (hire_agent, strategy, budget) |
| `join_requests` | Remote agent onboarding requests |
| `invites` | Invite tokens for agent/user joining |
| `company_memberships` | Org membership (users and agents) |
| `principal_permission_grants` | Fine-grained permission grants |
| `company_secrets` | Secret metadata (value stored encrypted) |
| `company_secret_versions` | Secret version history |
| `board_api_keys` | API key credentials (SHA-256 hash stored) |
| `cost_events` | Per-run token cost tracking |
| `budget_policies` | Agent budget rules |
| `activity_log` | Full audit trail of actions |
| `execution_workspaces` | Workspace environments for execution |
| `assets` | File/image storage metadata |

---

## Security Model

- **FIPS crypto throughout** — every encrypt/decrypt/sign/verify call goes through aws-lc-rs with `fips` feature
- **No plaintext secrets at rest** — all secret values AES-256-GCM encrypted, only master key in env/file
- **Timing-safe comparisons** — all token/signature verification uses constant-time comparison
- **No Node.js at runtime** — entire npm CVE surface eliminated from production
- **Minimal crate surface** — each dependency justified; no transitive bloat from large frameworks
- **Auth modes** — `local_trusted` for dev/air-gapped, `authenticated` for production
- **Invite/claim flow** — remote agents use short-lived invite tokens (10 min TTL) + one-time claim secrets (7 day TTL) to obtain persistent API keys

---

## Build & Run

```bash
# Prerequisites (build time only)
node >= 20, npm

# Build
cargo build --release

# Run
./target/release/paperclip start
# → serves at http://localhost:3100

# With PostgreSQL (optional)
cargo build --release --features postgres
PAPERCLIP_DB_URL=postgres://... ./target/release/paperclip start
```

---

## Phase Plan

| Phase | Deliverables |
|---|---|
| 1 — Core | `paperclip-core`: domain types, DB, migrations, crypto |
| 2 — Adapters | `paperclip-adapters`: all 10 adapter impls |
| 3 — API | `paperclip-api`: Axum routes, WebSocket, auth, embedded UI |
| 4 — Scheduler | `paperclip-scheduler`: cron loop, heartbeat worker, webhook triggers |
| 5 — CLI + Integration | `paperclip-cli`: startup, config, graceful shutdown, end-to-end test |
