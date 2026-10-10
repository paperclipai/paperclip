# GitHub managed connection

GitHub is a Paperclip Cloud-managed GitHub App connection with an advanced PAT
compatibility method. Cloud owns the fixed public OAuth callback and signed
webhook inbox; provider tokens are sealed to the enrolled instance and stored
only in its existing encrypted secret system.

## Catalog entries

**GitHub** connects an account for repository tools, Git, and `gh`, and opens
Access → Connect directly. **GitHub Code Review Bot** connects one agent to a
GitHub App for pull-request reviews and mentions, and opens Choose agent directly.
The bot entry follows **Settings → Experimental → GitHub review bots**
(`enableGitHubReviewBots`), which defaults to off. It is independent of Chat
connectors: enabling one does not enable the other. Turning off the GitHub
setting hides setup and management; existing bots keep running.

Both entries reuse the existing GitHub integrations. Bot endpoints retain the
`github` provider identity and existing setup, reconnect, and management URLs;
saved bot connections and drafts appear under GitHub Code Review Bot. GitHub
repository and MCP URLs still resolve to the ordinary GitHub tool connection.

## Bot instructions and triggers

Bot Settings uses the shared Markdown editor for common and event-specific
instructions. Type `/` and select a company skill to insert a saved skill link.
Common instructions accompany every admitted GitHub task; event-specific
instructions accompany that event. Selected skills are materialized for the run
and explicitly invoked by the native Runner, subject to existing tool and
isolation restrictions. The admitted configuration snapshot determines skill
selection for each wake, including queued events. GitHub messages, repository
content and other companies' skills cannot assign skills to the run.

Authorized @mentions remain available when **Run automatically** is on or off.
The switch in Settings reveals the PR and issue event checkboxes. Access lists
company members and external contributors separately. Author include/exclude filters
in Settings control whose activity starts automatic work; there is no per-person
automatic-run switch. Automatic events still require an authorized author and an
enabled event. Legacy `people[].automaticReviews` values are accepted but ignored.
External contributors additionally need **Allow automatic runs for external contributors**.
Their restricted guest profile and sponsor requirements are unchanged.

The passing-score number field accepts a whole number from 1 to 5, defaulting to 5.
Paperclip publishes a successful **Paperclip Review** check only after a complete
assessment of the current commit meets the threshold; lower scores fail and
incomplete assessments require action. To block merging, separately require this
check from the dedicated App in GitHub branch protection or a ruleset. A new head
commit needs its own check. Report-only mode publishes a neutral conclusion, which
GitHub can accept for a required check; it does not enforce a score requirement.
A passing score does not formally approve a PR. **Approvals and change requests**
contains those optional agent permissions. Scheduling filters, ignored files,
and inline-comment options have separate disclosures. The header shows the App
identity, copyable mention, avatar download, and GitHub branding settings.

## Self-hosted setup

The setup screen states the default access in one line, with **Change** for
other choices. **Continue to GitHub** on that screen starts the provider
handoff.

A self-hosted instance needs one Paperclip Cloud approval before its first
managed connection. After approval, setup returns to the connect screen and continues to
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

OAuth completion verifies `/user`, every page of `/user/installations`, and every
page of each installation's accessible repositories. Setup remains incomplete
until at least one installation and repository are available. Paperclip stores
the authenticated username and a grant-scoped display snapshot containing only
repository IDs, full names, installation IDs, and private-repository flags. GitHub stays authoritative:
this snapshot never authorizes repository access.

The permissions page shows repositories across authorized accounts by default.
Use the account filter and search to narrow the list. The list scrolls after
about ten rows and marks known private repositories with a lock. Configure on
GitHub opens the app account chooser so users can add or update organization
access. Refresh access after changing the selection. Older snapshots omit the
private flag until refreshed. If a legacy grant lacks its app chooser URL,
**Load GitHub configuration** refreshes access and recovers the app slug from
GitHub installation metadata. The page does not substitute a single-installation
settings URL for the account chooser.

The permissions page shows the authenticated GitHub account and the complete
accessible repository list. **Refresh access** reloads it from GitHub. Older
grants and grants invalidated by newer installation lifecycle events prompt for a
refresh instead of presenting a stale list. The page links to GitHub's
installation management page. Selected repositories are recommended; all-
repository access retains its warning.

Fresh local test-drives use production Paperclip Cloud. Instance enrollment
and provider enablement are separate: enrollment alone does not enable GitHub
OAuth. Production must advertise the `github.code` profile (see Cloud's
`docs/github-connector-deploy-bootstrap.md`). If it is unavailable, setup
preserves the sign-in intent and offers a retry instead of silently switching
to a personal access token. A successful retry preserves the chosen audience.

## GitHub Actions tools

Managed and PAT connections request `X-MCP-Toolsets: default,actions` for MCP
discovery and invocation. GitHub's default catalog excludes Actions; granting
Actions permissions alone does not expose workflow tools. Existing connections
can use **Refresh actions** after upgrading to discover the added tools.
The normal catalog, access, approval, and quarantine rules still apply.

To dispatch an existing workflow, use `actions_run_trigger` with
`method: "run_workflow"`, the repository owner and name, `workflow_id`, `ref`,
and any workflow `inputs`. The workflow must declare `workflow_dispatch`.
The GitHub App installation or fine-grained PAT needs **Actions: Read and
write** for the repository. App owners set that permission on the GitHub App
registration; installation owners must approve an increase before it takes
effect. Paperclip's action controls do not grant GitHub permissions.

The tool also supports rerunning and cancelling runs and deleting run logs.
It retains GitHub's destructive classification. Read tools include
`actions_list`, `actions_get`, and `get_job_logs`.

Provider references: [MCP toolset configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)
and [workflow dispatch permissions](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

## Webhooks

For the shared GitHub account connector, Paperclip Cloud verifies
`X-Hub-Signature-256` against the exact bounded request
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

## Dedicated agent Apps

The bot wizard uses Cloud gateway protocol version 2. The stack builds the
private manifest for a personal account or organization. GitHub still asks the
user to confirm creation and repository installation. The stack exchanges the
returned manifest code directly with GitHub and stores every App secret in its
vault, including the private key, client secret, and webhook verifier.

Cloud stores only opaque, instance-bound callback routes and encrypted callback
claims. It does not exchange codes, track App or installation identity, store
GitHub secrets, or interpret bot events. It forwards original webhook bytes,
provider headers, and signature in an envelope sealed to the stack before
writing the inbox. The stack decrypts and authenticates those bytes through its
existing durable ingress. Only that local check can verify a connection or
admit work. Shared-App account connectors keep the behavior described above.

Unverified gateway traffic has request, byte, pending-queue, retention and wake
limits. Its transport deduplication includes the body and signature, so a forged
request cannot occupy a real delivery's identifier. A ping received before its
verifier reaches the vault remains queued for retry. Malformed and forged
traffic is discarded after local verification. Installation returns only request
a state refresh; the stack queries GitHub to establish installation authority.

OAuth state, PKCE, consent, repository discovery, recovery and lifecycle changes
also stay in the stack. Interrupted single-use manifest exchanges require
recovery of the existing App instead of a second creation. Direct webhook and
manual existing-App recovery remain available. Connecting does not prove that
an agent runtime can execute a review.

### One editable response per request

After accepting authorized GitHub work, Paperclip posts **Working on this…**
before starting the agent. Issue and PR discussion comments use the same GitHub
comment API; inline-review conversations receive an inline reply. Description
mentions and automatic tasks also receive a working comment. No new eyes
reaction is added; cleanup still handles receipts created by older versions.

The agent's `update_comment` tool edits the current request's working comment.
It takes a body and a stable idempotency key, with no caller-selected comment ID
or destination. Instructions encourage brief, factual progress updates during
longer work. Distinct updates use distinct keys; retries reuse the same key.
Progress does not complete an assessment or change a review check.

The `comment` tool replaces that same comment with the final answer.
`submit_review` replaces it with the allowed review summary; checks, inline
findings and explicitly permitted formal reviews remain separate. Corrected
assessments can update the summary again. Delayed progress cannot overwrite a
final answer. Native final text stays in Paperclip and creates no extra comment.
Legacy connections without a saved review configuration retain automatic run
progress and final replies until upgraded to this tool-owned response model.

Receipts are bound to the company, App, task, accepted request and original
runtime generation. The existing publication lease serializes edits, and
App-owned markers recover uncertain creation without posting duplicates.
Deleted or no-longer-owned comments are not recreated or edited. Coalesced runs
settle a deleted earlier working comment without blocking the current response,
review findings, or check publication. Failed runs
update the same comment when no final reply is confirmed or unresolved. A run
that ends without a final reply clears a remaining working state honestly.
Repository restrictions, person authorization and governed tool checks remain
in effect for edits. Existing disabled or quarantined tools stay disabled.
Existing native sessions refresh incompatible tool checkpoints so the agent
can see `update_comment`. The same Paperclip task and saved history remain.

### Explicit bot mentions and subscriptions

Issue and PR descriptions, discussion comments, inline comments, and review
summaries retain uploaded attachment references when they mention the bot.
Private images use the exact unchanged source's authenticated GitHub rendering;
repository/thread identity and body hashes remain bound across restarts. Signed
image URLs and credentials are never added to durable attachment descriptors.

A manual message naming another connected GitHub bot in the same company does
not wake this bot through its thread subscription. Paperclip filters that
delivery before creating task work or adding an acknowledgement. Explicitly
mentioning both bots allows both to receive the request, subject to their normal
authorization and repository checks.

Unaddressed follow-ups, human mentions and unknown handles retain the existing
subscription behavior. The routing rule does not change automatic issue or PR
event policies. Archived bots and identities from other companies or providers
are excluded from the routing lookup.

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
