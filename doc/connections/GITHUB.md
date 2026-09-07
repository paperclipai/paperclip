# GitHub managed connection

GitHub is a Paperclip Cloud-managed GitHub App connection with an advanced PAT
compatibility method. Cloud owns the fixed public OAuth callback and signed
webhook inbox; provider tokens are sealed to the enrolled instance and stored
only in its existing encrypted secret system.

## Self-hosted setup

The Access step uses **Continue** to open the local setup screen.
**Continue to GitHub** on that screen starts the provider handoff. The first
button does not imply that the browser is leaving Paperclip yet.

A self-hosted instance needs one Paperclip Cloud approval before its first
managed connection. After approval, setup returns to step 2 and continues to
GitHub without another instance approval or a service restart.

If an unapproved enrollment link expires, return to setup and select
**Continue**. Paperclip asks the server for a valid link. The server reuses a
live pending enrollment or replaces an expired one; this does not revoke or
repeat an existing instance approval.

## Identity resolution

Every MCP call, `gh` invocation, native Git operation, checkout, health check,
and webhook binding uses the same order:

1. An active dedicated GitHub grant for the current agent.
2. The active personal GitHub grant owned by the run's `responsibleUserId`.
3. For automated work without a responsible user, a personal grant only when
   an existing standing delegation names the agent.
4. Legacy `GH_TOKEN`/`GITHUB_TOKEN` only when no managed GitHub connection is
   configured for the company.

An unavailable or ambiguous managed identity fails visibly. It never falls
through to another person, an organization credential, or a legacy token.
Agent grants are company-scoped, have exactly one `subjectAgentId`, cannot be
organization defaults, and are installed only for that agent.

The connection installation is the credential owner's consent boundary. A
personal setup may target every agent or a selected set, and runtime resolution
considers only an enabled, active connection installed for the current agent.
Within that boundary, Paperclip treats the run's server-resolved
`responsibleUserId` as its credential principal, including for automated work;
agents cannot choose or spoof this field. The owner must still be an active
non-viewer company member at each use. A standing delegation is needed only
when a run genuinely has no responsible user.

## Credential lifecycle

The production, staging, and development GitHub Apps deliberately disable
user-to-server token expiration. The resulting long-lived access token is
checked with GitHub's `/user` endpoint every 30 days, together with installation
and repository summary refresh. Routine continuity requires no browser visit.

If GitHub returns an expiring access token and rotating refresh token instead,
Paperclip stores both encrypted and:

- refreshes at least one hour before access expiry;
- forces a rotation at least every 30 days while the instance is active;
- serializes refresh through the existing database refresh lease and compare-
  and-swap update;
- atomically advances both secret values before clearing the lease;
- retries one forced refresh after a provider `401`.

Only an unrecoverable provider invalidation marks a grant
`needs_reauthorization`. Installation removal or suspension is reported as an
installation-health failure, not as token expiry.

## Repository access

OAuth completion verifies `/user`, `/user/installations`, and each
installation's accessible repository count. Setup remains incomplete until at
least one installation and repository are available. Paperclip stores user and
installation summaries, not a repository-name cache. GitHub stays authoritative:
removed repository access fails immediately even if a displayed count is stale.

The Apps UI links to GitHub's installation management page and offers
**Refresh access**. Selected repositories are recommended. Choosing all
repositories requires an explicit warning in setup.

## Webhooks

Paperclip Cloud verifies `X-Hub-Signature-256` against the exact bounded request
body before parsing, deduplicates by `X-GitHub-Delivery`, and persists a minimal
normalized event before returning `202`. Raw webhook payloads are discarded.
When registering an active binding, Paperclip sends the current user token only
inside the signed, payload-bound broker request so Cloud can verify access to
that exact installation; Cloud neither logs nor persists that proof token.
Deliveries fan out independently to every enrolled instance bound to the GitHub
installation and are sealed to each instance's public key.

The instance polls with backoff, stores a company-scoped idempotency receipt,
and acknowledges only successful applications. A merged pull request updates
its matching external-object snapshot and immediately runs the existing merge-
confirmation resolver. It wakes the assignee only when that interaction's
continuation policy requests it; unrelated Paperclip issues are not closed.
The periodic GitHub merge sweep remains the reconciliation fallback.

Installation lifecycle events refresh or invalidate installation summaries and
remove obsolete Cloud bindings. Activity records contain event identifiers and
outcomes but no webhook content. GitHub webhook content is never first-party
telemetry.

## Run projection

The resolved token is leased at run start as an audited class-3 secret and is
projected only into the child process:

- `GH_TOKEN`, `GITHUB_TOKEN`, and an internal credential-helper environment key;
- `GIT_TERMINAL_PROMPT=0`;
- process-scoped `GIT_CONFIG_COUNT/KEY_n/VALUE_n` entries that clear ambient
  helpers, install a `github.com`-only helper, and rewrite GitHub SSH remotes to
  HTTPS;
- author and committer identity using
  `<numeric-id>+<login>@users.noreply.github.com`.

Tokens never appear in arguments, URLs, files, logs, events, or model context,
and the projection never replaces `HOME`.

Cloud deployment and exact GitHub App registration settings live in
`paperclip-cloud/docs/github-connector-deploy-bootstrap.md`.
