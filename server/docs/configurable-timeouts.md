# Configurable timeout & interval values

All values live in `server/src/timeout-constants.ts` and honour an environment
variable override.  Values are in **milliseconds** unless the name or comment
explicitly says `_SECONDS`.

## Helper

- **`parsePositiveIntFromEnv(envName, default)`** — reads a positive integer
  from the named env var; returns `default` when unset, empty, non-finite, or
  <= 0.

---

## Network / HTTP server

| Constant | Env var | Default | Description |
|---|---|---|---|
| `KEEP_ALIVE_TIMEOUT_MS` | `PAPERCLIP_KEEP_ALIVE_TIMEOUT_MS` | 185000 | HTTP keep-alive timeout |
| `HEADERS_TIMEOUT_MS` | *(derived)* | KEEP_ALIVE_TIMEOUT_MS + 1000 | HTTP headers timeout (≥ keepAlive, enforced) |
| `TAILSCALE_DETECT_TIMEOUT_MS` | `PAPERCLIP_TAILSCALE_DETECT_TIMEOUT_MS` | 3000 | `tailscale ip -4` exec timeout |

## Board / CLI auth

| Constant | Env var | Default | Description |
|---|---|---|---|
| `BOARD_API_KEY_TTL_MS` | `PAPERCLIP_BOARD_API_KEY_TTL_MS` | 30 d | Board API key TTL |
| `CLI_AUTH_CHALLENGE_TTL_MS` | `PAPERCLIP_CLI_AUTH_CHALLENGE_TTL_MS` | 10 min | CLI auth challenge TTL |
| `BOARD_CLAIM_TTL_MS` | `PAPERCLIP_BOARD_CLAIM_TTL_MS` | 24 h | Board claim challenge TTL |

## Invites

| Constant | Env var | Default | Description |
|---|---|---|---|
| `COMPANY_INVITE_TTL_MS` | `PAPERCLIP_COMPANY_INVITE_TTL_MS` | 72 h | Company invite token TTL |
| `INVITE_RESOLUTION_DNS_TIMEOUT_MS` | `PAPERCLIP_INVITE_RESOLUTION_DNS_TIMEOUT_MS` | 3000 | DNS lookup timeout for invite URLs |
| `INVITE_RESOLUTION_PROBE_DEFAULT_TIMEOUT_MS` | `PAPERCLIP_INVITE_RESOLUTION_PROBE_DEFAULT_TIMEOUT_MS` | 5000 | Default HTTP probe timeout for invite resolution (overridable per-request via `?timeoutMs=`) |

## Notifications (SMTP, web push)

| Constant | Env var | Default | Description |
|---|---|---|---|
| `SMTP_CONVERSATION_TIMEOUT_MS` | `PAPERCLIP_SMTP_TIMEOUT_MS` | 30000 | SMTP conversation timeout |
| `WEB_PUSH_TTL_SECONDS` | `PAPERCLIP_WEB_PUSH_TTL_SECONDS` | 86400 | Web push TTL (seconds) |
| `DEFAULT_SMTP_PORT` | `PAPERCLIP_SMTP_DEFAULT_PORT` | 587 | Default SMTP port |

## Heartbeat / recovery

| Constant | Env var | Default | Description |
|---|---|---|---|
| `ORPHANED_RUN_STALE_THRESHOLD_MS` | `PAPERCLIP_ORPHANED_RUN_STALE_THRESHOLD_MS` | 5 min | Staleness threshold for orphaned run reaping |
| `ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS` | `PAPERCLIP_ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS` | 1 h | Suspicion threshold (no output) |
| `ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS` | `PAPERCLIP_ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS` | 4 h | Critical threshold (no output) |
| `ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS` | `PAPERCLIP_ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS` | 30 min | Re-arm interval after suspicion alert |

## Database health watchdog

These values are defined directly in `server/src/services/db-health-watchdog.ts` (not in `timeout-constants.ts`).

| Constant | Env var | Default | Description |
|---|---|---|---|
| *(inline)* | `PAPERCLIP_DB_WATCHDOG_INTERVAL_MS` | 30000 | DB health probe interval (ms). How often the watchdog checks database connectivity. |
| *(inline)* | `PAPERCLIP_DB_WATCHDOG_MAX_FAILURES` | 3 | Consecutive probe failures before watchdog action (embedded PG restart or process exit). |

## Board chat

| Constant | Env var | Default | Description |
|---|---|---|---|
| `BOARD_CHAT_TIMEOUT_MS` | `PAPERCLIP_BOARD_CHAT_TIMEOUT_MS` | 120000 | Board conversation subprocess timeout |

## Pipeline leases

| Constant | Env var | Default | Description |
|---|---|---|---|
| `PIPELINE_DEFAULT_LEASE_MS` | `PAPERCLIP_PIPELINE_DEFAULT_LEASE_MS` | 15 min | Default pipeline case lease |
| `PIPELINE_MAX_LEASE_MS` | `PAPERCLIP_PIPELINE_MAX_LEASE_MS` | 24 h | Maximum pipeline case lease |

## External object / provider caches

| Constant | Env var | Default | Description |
|---|---|---|---|
| `EXTERNAL_OBJECT_REFRESH_TTL_SECONDS` | `PAPERCLIP_EXTERNAL_OBJECT_REFRESH_TTL_SECONDS` | 300 s | External object snapshot refresh TTL |
| `GITHUB_OBJECT_TTL_SECONDS` | `PAPERCLIP_GITHUB_OBJECT_TTL_SECONDS` | 300 s | GitHub-provided object TTL |

## Environment custom images

| Constant | Env var | Default | Description |
|---|---|---|---|
| `SETUP_SESSION_TTL_SECONDS` | `PAPERCLIP_SETUP_SESSION_TTL_SECONDS` | 1 h | Custom-image setup session TTL |

## AWS Secrets Manager

| Constant | Env var | Default | Description |
|---|---|---|---|
| `AWS_SECRETS_REQUEST_TIMEOUT_MS` | `PAPERCLIP_AWS_SECRETS_REQUEST_TIMEOUT_MS` | 30000 | HTTP request timeout |
| `AWS_CREDENTIAL_CACHE_TTL_MS` | `PAPERCLIP_AWS_CREDENTIAL_CACHE_TTL_MS` | 5 min | Credential cache TTL |

## Embeddings

| Constant | Env var | Default | Description |
|---|---|---|---|
| `EMBEDDING_TIMEOUT_MS` | `PAPERCLIP_EMBEDDING_TIMEOUT_MS` | 10000 | Embedding API request timeout |
| `EMBEDDING_CACHE_TTL_MS` | `PAPERCLIP_EMBEDDING_CACHE_TTL_MS` | 24 h | Embedding result cache TTL |

## Model list caches

| Constant | Env var | Default | Description |
|---|---|---|---|
| `OPENAI_MODELS_TIMEOUT_MS` | `PAPERCLIP_OPENAI_MODELS_TIMEOUT_MS` | 5000 | OpenAI/Codex model list fetch timeout |
| `OPENAI_MODELS_CACHE_TTL_MS` | `PAPERCLIP_OPENAI_MODELS_CACHE_TTL_MS` | 60000 | Model list cache TTL |
| `CURSOR_MODELS_TIMEOUT_MS` | `PAPERCLIP_CURSOR_MODELS_TIMEOUT_MS` | 5000 | Cursor model list subprocess timeout |
| `CURSOR_MODELS_CACHE_TTL_MS` | `PAPERCLIP_CURSOR_MODELS_CACHE_TTL_MS` | 60000 | Cursor model list cache TTL |

## Feedback export

| Constant | Env var | Default | Description |
|---|---|---|---|
| `FEEDBACK_EXPORT_FLUSH_INTERVAL_MS` | `PAPERCLIP_FEEDBACK_EXPORT_FLUSH_INTERVAL_MS` | 5000 | Feedback/telemetry export flush interval |

## Server info

| Constant | Env var | Default | Description |
|---|---|---|---|
| `GIT_INFO_CACHE_TTL_MS` | `PAPERCLIP_GIT_INFO_CACHE_TTL_MS` | 3000 | Git info cache TTL |
| `GIT_COMMAND_TIMEOUT_MS` | `PAPERCLIP_GIT_COMMAND_TIMEOUT_MS` | 1500 | Git command exec timeout |

## Knowledge document cache

| Constant | Env var | Default | Description |
|---|---|---|---|
| `KNOWLEDGE_SEARCH_CACHE_TTL_MS` | `PAPERCLIP_KNOWLEDGE_SEARCH_CACHE_TTL_MS` | 5 min | Knowledge document search cache TTL |

## Adapter config schema cache

| Constant | Env var | Default | Description |
|---|---|---|---|
| `CONFIG_SCHEMA_CACHE_TTL_MS` | `PAPERCLIP_CONFIG_SCHEMA_CACHE_TTL_MS` | 30000 | Adapter config-schema cache TTL |

## Plugin UI static fetch

| Constant | Env var | Default | Description |
|---|---|---|---|
| `PLUGIN_UI_STATIC_FETCH_TIMEOUT_MS` | `PAPERCLIP_PLUGIN_UI_STATIC_FETCH_TIMEOUT_MS` | 10000 | Plugin UI static file fetch timeout |

## Heartbeat run runtime status

| Constant | Env var | Default | Description |
|---|---|---|---|
| `HEARTBEAT_RUN_RUNTIME_STATUS_TTL_MS` | `PAPERCLIP_HEARTBEAT_RUN_RUNTIME_STATUS_TTL_MS` | 90000 | Heartbeat run runtime status TTL |

## Issue tree control

| Constant | Env var | Default | Description |
|---|---|---|---|
| `TREE_RUN_CANCELLATION_RESPONSE_WAIT_MS` | `PAPERCLIP_TREE_RUN_CANCELLATION_RESPONSE_WAIT_MS` | 1000 | Wait for run-cancellation tasks before responding |

## Plugin system — worker lifecycle

| Constant | Env var | Default | Description |
|---|---|---|---|
| `PLUGIN_WORKER_RPC_TIMEOUT_MS` | `PAPERCLIP_PLUGIN_WORKER_RPC_TIMEOUT_MS` | 30000 | JSON-RPC call timeout to plugin workers |
| `PLUGIN_WORKER_INIT_TIMEOUT_MS` | `PAPERCLIP_PLUGIN_WORKER_INIT_TIMEOUT_MS` | 15000 | Init RPC timeout on worker startup |
| `PLUGIN_WORKER_SHUTDOWN_DRAIN_MS` | `PAPERCLIP_PLUGIN_WORKER_SHUTDOWN_DRAIN_MS` | 10000 | Drain wait before SIGTERM |
| `PLUGIN_WORKER_SIGTERM_GRACE_MS` | `PAPERCLIP_PLUGIN_WORKER_SIGTERM_GRACE_MS` | 5000 | Grace period after SIGTERM before SIGKILL |
| `PLUGIN_WORKER_SHUTDOWN_SETTLE_MS` | `PAPERCLIP_PLUGIN_WORKER_SHUTDOWN_SETTLE_MS` | 500 | Settle time after shutdown RPC |
| `PLUGIN_WORKER_SIGKILL_GRACE_MS` | `PAPERCLIP_PLUGIN_WORKER_SIGKILL_GRACE_MS` | 2000 | Wait after SIGKILL before declaring unkillable |

## Plugin system — HTTP/network

| Constant | Env var | Default | Description |
|---|---|---|---|
| `PLUGIN_FETCH_TIMEOUT_MS` | `PAPERCLIP_PLUGIN_FETCH_TIMEOUT_MS` | 30000 | Plugin-originated HTTP fetch timeout |
| `DNS_LOOKUP_TIMEOUT_MS` | `PAPERCLIP_DNS_LOOKUP_TIMEOUT_MS` | 5000 | DNS resolution timeout for plugin fetches |
| `LOG_BUFFER_FLUSH_INTERVAL_MS` | `PAPERCLIP_LOG_BUFFER_FLUSH_INTERVAL_MS` | 5000 | Plugin log buffer flush interval |
| `SESSION_EVENT_SUBSCRIPTION_TIMEOUT_MS` | `PAPERCLIP_SESSION_EVENT_SUBSCRIPTION_TIMEOUT_MS` | 30 min | Session event subscription expiry |

## Plugin system — job scheduler

| Constant | Env var | Default | Description |
|---|---|---|---|
| `PLUGIN_JOB_SCHEDULER_TICK_INTERVAL_MS` | `PAPERCLIP_PLUGIN_JOB_SCHEDULER_TICK_INTERVAL_MS` | 30000 | Job scheduler tick interval |
| `PLUGIN_JOB_RPC_TIMEOUT_MS` | `PAPERCLIP_PLUGIN_JOB_RPC_TIMEOUT_MS` | 5 min | runJob RPC timeout |

## Plugin system — npm operations

| Constant | Env var | Default | Description |
|---|---|---|---|
| `PLUGIN_NPM_INSTALL_TIMEOUT_MS` | `PAPERCLIP_PLUGIN_NPM_INSTALL_TIMEOUT_MS` | 120000 | npm install/uninstall timeout |

## Plugin environment driver

| Constant | Env var | Default | Description |
|---|---|---|---|
| `PLUGIN_ENV_DRIVER_PROBE_TIMEOUT_MS` | `PAPERCLIP_PLUGIN_ENV_DRIVER_PROBE_TIMEOUT_MS` | 120000 | Environment driver probe timeout |
| `PLUGIN_ENV_DRIVER_RPC_OVERHEAD_MS` | `PAPERCLIP_PLUGIN_ENV_DRIVER_RPC_OVERHEAD_MS` | 30000 | RPC communication latency overhead |

## Cloud upstream transfer

| Constant | Env var | Default | Description |
|---|---|---|---|
| `CLOUD_UPSTREAM_DISCOVERY_TIMEOUT_MS` | `PAPERCLIP_CLOUD_UPSTREAM_DISCOVERY_TIMEOUT_MS` | 30000 | Upstream discovery fetch timeout |
| `CLOUD_UPSTREAM_REMOTE_FETCH_TIMEOUT_MS` | `PAPERCLIP_CLOUD_UPSTREAM_REMOTE_FETCH_TIMEOUT_MS` | 120000 | Remote upstream entity fetch timeout |

## Agent start lock

| Constant | Env var | Default | Description |
|---|---|---|---|
| `AGENT_START_LOCK_STALE_MS` | `PAPERCLIP_AGENT_START_LOCK_STALE_MS` | 30000 | Agent start lock staleness threshold |

## Quota provider

| Constant | Env var | Default | Description |
|---|---|---|---|
| `QUOTA_PROVIDER_TIMEOUT_MS` | `PAPERCLIP_QUOTA_PROVIDER_TIMEOUT_MS` | 20000 | Quota provider polling timeout |

## Process / sandbox

| Constant | Env var | Default | Description |
|---|---|---|---|
| `PROCESS_START_TIME_TOLERANCE_MS` | `PAPERCLIP_PROCESS_START_TIME_TOLERANCE_MS` | 10000 | PID start-time drift tolerance |
| `SANDBOX_WORKER_READY_TIMEOUT_MS` | `PAPERCLIP_SANDBOX_WORKER_READY_TIMEOUT_MS` | 5000 | Environment sandbox worker ready timeout |

## Memory context injection

| Constant | Env var | Default | Description |
|---|---|---|---|
| `MEMORY_CONTEXT_INJECTION_TIMEOUT_MS` | `PAPERCLIP_MEMORY_CONTEXT_INJECTION_TIMEOUT_MS` | 3000 | Memory context injection warm-up timeout |

## Issue comment log derivation

| Constant | Env var | Default | Description |
|---|---|---|---|
| `ISSUE_COMMENT_LOG_DERIVATION_SLACK_MS` | `PAPERCLIP_ISSUE_COMMENT_LOG_DERIVATION_SLACK_MS` | 60000 | Slack time for log derivation deadlines |

## Company search rate limit

| Constant | Env var | Default | Description |
|---|---|---|---|
| `COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS` | `PAPERCLIP_COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS` | 60000 | Company search rate-limit window |

## Productivity review

| Constant | Env var | Default | Description |
|---|---|---|---|
| `PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS` | `PAPERCLIP_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS` | 1 h | Productivity review evaluation refresh |

## Recovery / continuation

| Constant | Env var | Default | Description |
|---|---|---|---|
| `CONTINUATION_RECOVERY_BASE_BACKOFF_MS` | `PAPERCLIP_CONTINUATION_RECOVERY_BASE_BACKOFF_MS` | 60000 | Base back-off for continuation recovery |

## Heartbeat — managed workspace / JWT

| Constant | Env var | Default | Description |
|---|---|---|---|
| `MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS` | `PAPERCLIP_MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS` | 10 min | Git clone timeout for managed workspaces |
| `AGENT_JWT_TIMEOUT_MARGIN_SECONDS` | `PAPERCLIP_AGENT_JWT_TIMEOUT_MARGIN_SECONDS` | 300 s | Agent JWT timeout margin beyond run TTL |

## Environment provision

| Constant | Env var | Default | Description |
|---|---|---|---|
| `ENVIRONMENT_PROVISION_TIMEOUT_MS` | `PAPERCLIP_ENVIRONMENT_PROVISION_TIMEOUT_MS` | 5 min | Environment provision timeout |

## PostHog telemetry

| Constant | Env var | Default | Description |
|---|---|---|---|
| `POSTHOG_FLUSH_INTERVAL_MS` | `PAPERCLIP_POSTHOG_FLUSH_INTERVAL_MS` | 10000 | PostHog telemetry flush interval |

## WebSocket live events

| Constant | Env var | Default | Description |
|---|---|---|---|
| `WS_PING_INTERVAL_MS` | `PAPERCLIP_WS_PING_INTERVAL_MS` | 30000 | WebSocket ping frame interval |

## Instrumentation (OTel shutdown)

| Constant | Env var | Default | Description |
|---|---|---|---|
| `OTEL_SHUTDOWN_TIMEOUT_MS` | `PAPERCLIP_OTEL_SHUTDOWN_TIMEOUT_MS` | 5000 | OTel SDK shutdown timeout during process exit |

## Workspace runtime health

| Constant | Env var | Default | Description |
|---|---|---|---|
| `RUNTIME_SERVICE_HEALTH_TIMEOUT_MS` | `PAPERCLIP_RUNTIME_SERVICE_HEALTH_TIMEOUT_MS` | 2000 | Runtime service health-check fetch timeout |