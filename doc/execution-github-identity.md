# GitHub identity during agent execution

Shared agents use the GitHub connection of the person whose accepted instructions they are executing. Task ownership remains unchanged. GitHub is optional: ordinary work can start without a connection; a private checkout, authenticated API call, or commit can fail when that operation needs credentials or author metadata.

## Accepted instructions and continuations

`run_identity_contexts` records ordered revisions, stored message authors, originating causes, parent contexts, acceptance state, and redacted GitHub outcomes. `heartbeat_runs.active_identity_context_id` selects the current revision. Existing historical runs are not backfilled with inferred authorship.

Human messages use their stored authenticated author. Queued messages retain their delivery order. Accepting steering reserves a pending revision before delivery, then activates it after the provider acknowledgement. Rejected delivery leaves the prior revision active. An uncertain acknowledgement holds new credential acquisition; a later acknowledgement or its authenticated native event receipt reconciles the reservation. Replays cannot reactivate an older revision. Activation locks the task before the run, matching task and queue mutations so concurrent status changes cannot deadlock identity initialization.

Delegated work and interactions persist their originating context. Retries retain the originating run's active context. Background continuations carry their source run; dependency wakes use the task's continuation context, independently of its owner. Scheduled and webhook routines use the routine's responsible person; manual invocations use the caller, and edits preserve the routine's responsible person.

## Managed GitHub operations

New executions receive token-free `git` and `gh` launchers and a run-scoped capability. Each launcher invocation requests the active context through the authenticated runtime transport and resolves one eligible credential at operation start. A `gh` command's child Git processes inherit that command's captured identity. Later steering does not change already-started operations. When a subsequent run resumes a settled native conversation, the controller starts a fresh provider process with that run’s capability and rebinds its token-free launcher paths. The durable conversation and protected provider settings remain unchanged. Local and remote durable runners complete their bounded suspension before the controller releases the session for the next run, so a queued continuation cannot race unfinished cleanup.

The broker endpoint rejects browser origins and session cookies, validates a distinct signed runtime scope, and rechecks the company, agent, and live run. Sandboxes relay the capability through the existing authenticated callback bridge. Tokens are returned only to the managed command process. They are not persisted in identity history or injected into the long-lived provider process.

Server-side Git operations and GitHub gateway calls follow the same selection rules. Approved gateway operations retain their signed originating identity. Connection audience and tool policies continue to apply to the selected person's connection. Native catalogs remain stable across identity changes, but each invocation resolves the selected grant again. Personal OAuth secret declarations survive connection pauses and metadata edits.

Managed commands disable ambient Git credential helpers, Git global/system configuration, host GitHub CLI configuration, and host SSH identity access. Per-operation GitHub CLI configuration is isolated in a writable configuration directory beneath the managed launcher directory. Missing credentials clear previous author and token values; no teammate, standing delegation, host token, or company-default user's account is substituted. Anonymous/local operations remain available where supported.

Scripts that previously read a persistent `GH_TOKEN` must use managed `git`, `gh`, or GitHub gateway tools. Directly invoking an unmanaged executable or retaining a token obtained during an earlier invocation is outside the managed invocation contract.

## Dedicated accounts and diagnostics

An explicit dedicated-agent grant overrides personal selection. Revoked, disabled, unavailable, or ambiguous dedicated grants do not fall back to a person's account. Removing the dedicated configuration restores personal selection.

Connection setup and permissions display: “This agent uses this GitHub account for everyone's work, instead of the person giving instructions.”

Run details show identity revisions and redacted GitHub results: responsible person, selected login when available, personal/dedicated source, and an unavailable reason. Tasks do not receive an additional identity indicator or takeover action.

## Deployment and verification

Deploy the schema, server broker, launcher staging, and runtime environment contract together. Already-running processes retain their original environment; only newly dispatched processes receive the broker contract. Run-scoped capabilities remain valid only while their bound run is active.

Focused coverage lives in `run-identity.test.ts`, `github-operation-credentials.test.ts`, and `github-launcher.test.ts`, alongside the native steering, gateway, routine, and callback-bridge suites. Live acceptance additionally requires two authenticated Paperclip users, two authorized GitHub accounts, and a designated disposable repository for push verification. Local commit metadata and mocked API results do not replace that live push test.
