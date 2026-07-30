# Claude Usage Governor

Paperclip treats Claude subscription/session exhaustion as a provider quota
event, not as an ordinary transient upstream failure.

## Defaults

- Claude local session-limit output such as `You've hit your session limit -
  resets 1pm (America/Los_Angeles)` is classified as `errorCode:
  provider_quota` and `errorFamily: provider_quota`.
- When the adapter can parse a reset time, the run persists `retryNotBefore`,
  `transientRetryNotBefore`, and `providerQuotaRetryNotBefore` metadata.
- Provider quota failures use the existing bounded retry scheduler. They do not
  mark the agent `error`; the agent returns to `idle`.
- A durable provider-wide circuit is inferred from scheduled retry rows with
  future `providerQuotaRetryNotBefore` metadata. For `claude_local`, the circuit
  key is `anthropic`.
- While the circuit is open, fresh same-provider queued runs remain queued and
  scheduled retries are not promoted before the provider reset time. Same-provider
  model-profile fallback therefore cannot bypass an active circuit.
- Non-quota transient failures keep the existing bounded retry behavior and are
  not blocked by provider quota circuits for other providers.

## Configuration Surfaces

- Per-agent concurrency remains configured at
  `agent.runtimeConfig.heartbeat.maxConcurrentRuns` with the existing default
  from `AGENT_DEFAULT_MAX_CONCURRENT_RUNS`.
- Per-agent daily run and cost caps remain configured at
  `agent.runtimeConfig.heartbeat.maxDailyRuns` and
  `agent.runtimeConfig.heartbeat.maxDailyCostCents`.
- Cheap/status-only model lanes use the existing `runtimeConfig.modelProfiles`
  and `assigneeAdapterOverrides.modelProfile` controls.

No schema migration is required for the quota circuit; it is derived from
existing `heartbeat_runs` and `agent_wakeup_requests` state.
