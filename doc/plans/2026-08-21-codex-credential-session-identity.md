# Codex credential-aware ACP session identity

## Goal

Prevent Paperclip from resuming a Codex ACP session after the effective ChatGPT subscription account changes. Preserve normal session continuity when the same account merely refreshes or rotates its OAuth tokens.

## Design

During Codex managed-home preparation, read the effective `auth.json` and derive a non-secret credential identity. For subscription authentication, the stable input is `tokens.account_id`; Paperclip hashes it with a domain-separated SHA-256 digest before it enters any reusable runtime state. Raw account identifiers and token material must never enter session parameters, logs, fingerprints, or telemetry.

The derived hash is included only in the Codex runtime identity already consumed by the ACP session fingerprint. The shared compatibility check therefore behaves as it does for other fingerprint changes: the same credential identity resumes normally, while a changed identity misses the previous session and starts fresh. A token refresh for the same account does not change the hash.

Fresh Codex ACP sessions continue through Paperclip's existing prompt path, which supplies current task context, wake context, workspace state, and continuation summary. This change does not attempt cross-account provider-session resume.

## Non-goals

- No automatic account selection or rotation.
- No `codex-auth` dependency or private quota API calls.
- No database, scheduler, recovery-policy, UI, or adapter-configuration changes.
- No behavior change for API-key auth or non-Codex adapters.
- No raw credential identity persistence or logging.

## Verification

Tests must prove that identical subscription accounts with different refreshed token bytes produce the same identity and resumable session, different accounts produce different fingerprints and fresh sessions, malformed/API-key credentials add no subscription identity, and emitted session metadata contains neither raw account IDs nor token bytes.
