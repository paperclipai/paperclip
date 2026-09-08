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

Scripts that previously read a persistent `GH_TOKEN` must use managed `git`, `gh`, or GitHub gateway tools. Managed execution skips legacy GitHub token bindings in agent, environment, project, and routine configuration before secret preflight. Configure personal or dedicated access through the GitHub connection instead. Directly invoking an unmanaged executable or retaining a token obtained during an earlier invocation is outside the managed invocation contract.

## Dedicated accounts and diagnostics

An explicit dedicated-agent grant overrides personal selection. Revoked, disabled, unavailable, or ambiguous dedicated grants do not fall back to a person's account. Removing the dedicated configuration restores personal selection.

Connection setup and permissions display: “This agent uses this GitHub account for everyone's work, instead of the person giving instructions.”

Multiple eligible connections for the same GitHub account are treated as one
identity, using GitHub's stable account ID rather than its login. The resolver
selects an available grant, preferring the newest authorization with a stable
ID tie-breaker. Duplicate eligibility includes an active credential record with
the correct owner, the OAuth access-token reference, and repository access
metadata. It keeps that grant's credential and connection policy together;
it does not combine repository access or bypass connection audiences. Distinct
accounts or unidentifiable duplicate grants remain ambiguous. Managed commands
print the redacted reason when GitHub access is unavailable, while unrelated
local operations can still proceed without credentials.

Run details show identity revisions and redacted GitHub results: responsible person, selected login when available, personal/dedicated source, and an unavailable reason. Tasks do not receive an additional identity indicator or takeover action.

## Deployment and verification

Deploy the schema, server broker, launcher staging, and runtime environment contract together. Already-running processes retain their original environment; only newly dispatched processes receive the broker contract. Run-scoped capabilities remain valid only while their bound run is active.

Focused coverage lives in `run-identity.test.ts`, `github-operation-credentials.test.ts`, and `github-launcher.test.ts`, alongside the native steering, gateway, routine, and callback-bridge suites. Live acceptance additionally requires two authenticated Paperclip users, two authorized GitHub accounts, and a designated disposable repository for push verification. Local commit metadata and mocked API results do not replace that live push test.

### Release procedure

1. Back up the instance database using the normal deployment procedure.
2. Build and deploy one revision containing migrations 0240–0245, the server broker, managed launchers, and the runner artifacts. Run the standard pending-migration check before admitting new runs. These additive migrations are safe to replay and do not infer authorship for historical runs.
3. Let pre-rollout executions finish with their original runtime contract. New executions must have an active identity context and the managed launcher capability before provider startup.
4. Check one ordinary run without a GitHub connection, then an authenticated GitHub operation. Inspect the run details for the responsible person and credential outcome. Verify a queued continuation on the same conversation.
5. If rollback is needed, finish or explicitly stop executions using the new broker before removing its endpoint. Keep the additive schema and identity history. Do not drop identity columns or tables to roll back application code.

Remote acceptance uses the existing paid runner workflow with a narrow selection. Run it against the same immutable revision as the release; a successful local test does not qualify a different remote runner artifact.

Identity history survives deletion of the originating agent or run, so surviving
subtasks and approvals retain their responsible person. The company foreign key and company-deletion service remove
these company-scoped records when their company is deleted. Completed runs remove their managed launcher files
before releasing a remote environment; same-run recovery retains them until the
terminal boundary. Cleanup failures are logged and do not change the run result.
