# Codex quota watcher handoff

## Goal

Allow an opted-in Codex ACP run that fails on ChatGPT subscription quota to continue once an external credential watcher, such as `codex-auth`, switches the effective subscription account. Paperclip observes the credential change and retries the same task once; it does not select or rotate accounts itself.

## Chosen boundary

Account inventory, quota thresholds, candidate scoring, and credential mutation remain owned by the external watcher. Paperclip owns only the run-level handoff:

1. Read the effective Codex subscription credential identity before the ACP attempt.
2. Run the existing Codex ACP executor and apply the existing failure classification.
3. On a confirmed `provider_quota` result, wait for a configured, bounded interval while polling the effective `auth.json` identity.
4. Retry only when a different, valid subscription identity appears.
5. Retry at most once, using the original Paperclip execution context.

The credential-aware session fingerprint already guarantees that a different account starts a fresh provider session while the existing Paperclip prompt path carries task, wake, workspace, and continuation context forward.

## Configuration

Add one Codex ACP adapter setting: `quotaRotationWaitSec`.

- `0` or absent: disabled, preserving existing behavior.
- Positive values: wait for an externally managed account switch after a provider-quota failure.
- Clamp the effective value to a small implementation maximum so configuration cannot create an unbounded adapter wait.

The create/edit UI exposes this only with the ACP engine fields. Paperclip does not enable or configure `codex-auth`, and the setting does not apply to the CLI engine, API-key billing, or other adapters.

## Data flow and privacy

The retry wrapper resolves the same effective host Codex home used by the ACP preparation path and reads its `auth.json` through the existing hash-only subscription identity helper. It keeps only digests in memory. Raw account IDs and token bytes do not enter logs, result metadata, session parameters, or telemetry.

The first identity is captured before the initial attempt so a watcher switch that occurs during the failed request is still detected. A missing, malformed, API-key, or unreadable credential disables the handoff for that run. A transient disappearance of `auth.json` never counts as a successful switch; the new identity must be non-null and different.

## Error handling and observability

- Non-quota failures return immediately.
- Disabled configuration returns the existing classified result unchanged.
- No baseline subscription identity returns the existing result unchanged.
- A wait timeout returns the original quota result unchanged, including its reset metadata.
- A detected identity change emits a non-secret log line and retries once.
- The retry result is terminal even if it also reports provider quota; there is no loop.
- The retried result carries a small non-secret marker that the credential handoff occurred.

Paperclip never invokes a shell rotation command, reads the external watcher's registry, calls private quota APIs, or assumes a specific watcher implementation.

## Verification

Red/green tests must prove:

- the default and zero value do not wait or retry;
- non-quota and API-key failures do not wait or retry;
- a same-account token refresh does not retry;
- a changed account retries once with the original context;
- a change that occurs during the first attempt is detected immediately;
- a timeout returns the original quota result unchanged;
- a second quota failure does not cause another wait or retry;
- raw account and token markers do not appear in logs or result/session metadata;
- existing credential-aware session tests still start fresh on account change and retain task context.

## Non-goals

- Native Paperclip multi-account storage or selection.
- A dependency on `codex-auth` or its registry schema.
- Automatic installation or configuration of an external watcher.
- Cross-account provider-session resume.
- CLI-engine retry, API-key failover, or changes to global recovery policy.
