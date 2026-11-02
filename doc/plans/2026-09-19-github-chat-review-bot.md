# GitHub chat connector with agent-powered PR reviews

Date: 2026-09-19
Status: Design approved on 2026-09-19. Functional implementation and private-repository local/staging browser qualification authorized.

## Source and milestone

Freshly fetched origin/master worktrees:

- Paperclip: `codex/github-chat-review-bot`, base `04546c82d`.
- Cloud: `codex/github-chat-review-ingress`, base `6072ef7`; ingress implementation `c74f786`.
- Docs: `codex/github-low-trust-docs`, base `480c133`; trust guide update `0eedb32`.

The first deliverable is an interactive, simulated Storybook journey. It does not
implement a connector, store credentials, call GitHub, or prove agent execution.
After the user approves the stories, implement the contracts below, qualify the
local workflow, then deploy the exact tested application revision and matching
migrator with Cloud ingress changes to a dedicated staging tenant. Production
rollout and merging are outside scope.

## Product invariants

A GitHub bot represents one permanently assigned Paperclip agent. Mentions,
comments, and configured PR events create or continue ordinary Paperclip tasks.
Existing execution, identity, permissions, budgets, activity, and tools apply.
There is no second review scheduler or execution engine.

Reuse conversation/task bindings: automatic PR events enter the root PR
conversation; inline replies return to the task owning that thread. Retain task
ownership across follow-ups, but resolve each initiating actor's current authority
through existing run-identity rules. Record external sender and causal event.
Linked human requests use responsible-user resolution. Automatic events use the
explicitly configured responsible member, initially the configuring member. Store
PR author and webhook sender separately; neither grants Paperclip authority.

Unlinked-person access is off by default. Enabling it requires a sponsor and the
existing restricted guest permission profile. Guests remain nonmembers and never
inherit sponsor membership or personal credentials. Recheck revoked sponsors.
Existing GitHub chat connections retain their current behavior; migrating them
must not enable reviews or broaden permissions.

## Setup and management

Use the shared design system, setup sidebar, visible field help, step-owned
footer, and saved/resumable progress. Steps:

1. Choose the permanent agent assignment. Warn immediately if the selected agent is not configured for `low_trust_review`; link the maintained Paperclip Docs trust guide. Do not silently change permissions. Verify boundary and sandbox prerequisites separately.
2. Connect GitHub App, preferring manifest registration; support existing App
   credentials and reconnect. Explain public HTTPS before registration. Keep raw
   manifests, URLs, and recovery diagnostics behind supporting links.
3. Install the bot App on GitHub in a separate step. Verify the installation
   server-side before proceeding; a browser return alone is not proof.
4. Select allowed repositories from the bot App installation's fetched inventory.
   Follow the regular GitHub connection UI: Refresh access, Configure access on
   GitHub, explicit empty/error states, and repository rows. Show where the list
   comes from. Use the installation's validated management URL, not the personal
   connection's App installation. Refresh does not enable newly accessible repos.
5. Verify App identity, signed delivery, repository access, and the assigned
   agent's effective GitHub tools/runtime independently, with specific repairs.
6. Choose the current member's existing personal GitHub connection and confirm
   the verified account. If missing/expired, reuse normal personal GitHub sign-in
   or reconnect and return to this step. No at-mention identity challenge.
7. Configure responsible user, guest access, events, prompts, and publication.
8. Copy a mention, observe its Paperclip task/response, or finish without testing.

### Reusing personal GitHub identity

The regular connector already fetches `/user` and stores the stable GitHub
`userId` and display `login` in `providerTenant.github` of a connection grant.
Use an active, company-scoped, current-user-owned personal grant with verified
provider metadata. Do not accept a shared organization's credential, an agent
credential, a username typed by the user, or another member's grant as proof.
Revalidate server-side, match by GitHub numeric account ID rather than handle,
and bind the explicit confirmation to the authenticated member and connection.
Reject conflicting existing links and handle revoked/expired grants explicitly.
The identity link never authorizes copying personal credentials into bot runs.
The bot's governed capability bridge still uses only its own App credentials.

The existing full GitHub metadata refresh also requires installation/repository
access. Identity validation must reuse `/user` verification without requiring
personal repository access to this bot's installation. Cached, unverified or
stale metadata alone is insufficient. Reuse the normal connection flow, but do
not force a second bot App installation just to identify a person.

Existing members link their own personal connections from Access. Access offers
all linked company members or a selected member list. Adding a specific member
switches to the selected list, preserving existing entries; explain this before
confirmation. Only existing members are selected here: company invitations and
membership approval remain outside bot setup.

An operator can explicitly allow an external GitHub account without granting
Paperclip membership. Look up and confirm the provider account, store its stable
GitHub ID (not just its mutable handle), and require a currently authorized
responsible sponsor. Signed webhook actor identity must match the allowed ID;
this authorizes a restricted guest execution and never links the external person
to the sponsor's identity or personal credentials. Record both requester and
sponsor in task/run context. Restrict lookup/updates to authorized company actors,
audit mutations, reject duplicates, and recheck sponsor authority at execution
and publication. Removing access prevents further authorized work/publication.

Adding a person enables requests through mentions. Automatic reviews of that
person's PRs are a separate explicit option, off for newly added people. Per-person
settings override connection audience defaults, while enabled events, filters,
repository scope, and publication policies still apply. When scheduled automation
and actor authorization disagree, the more restrictive policy wins. Never treat
PR author identity as the human who sent a mention or as an authorization token.

The initial Access UI supports explicit external-user lists. An open-anyone mode
is deferred; it must be a separate deliberate option with a sponsor and restricted
guest policy, and must define removal/denial precedence before implementation.

Implementation references:
- `ui/src/pages/apps/app-detail/IdentitiesSection.tsx`: GitHub summary, refresh,
  management link, inventory and empty state.
- `server/src/services/chat-provider-inventory.ts`: bot installation inventory.
- `server/src/services/tool-access.ts`: verified personal GitHub account metadata.
- GitHub [authenticated user API](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)
  and [installation repositories API](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation).

Management sections remain Settings, Access, Reviews, Conversations, and Activity,
as confirmed during design review. Reviews is a projection of structured outputs
attached to ordinary tasks/runs, with reviewed-head and publication receipts; it
is not a separately assigned or scheduled work object.
Keep agent, responsible-user policy, bot GitHub tool connection, and task links
visible. Reviews are activity attached to tasks, not a separate execution surface.

Stories cover setup, existing Apps, reconnect, back/resume, mobile, missing tools,
missing installation permission, expired registration, webhook failure, identity
confirmation, guest access, prompts, overrides, formal reviews, summaries, inline
findings, successive reviews, and queued/running/passing/failing/incomplete or
manual-review-required checks. Prototype source is
`ui/storybook/prototypes/github-chat`; stories are
`ui/storybook/stories/github-chat.stories.tsx`.

## Governed GitHub capability bridge

The existing channel connection does not automatically supply agent tools. Bind
the assigned agent to tools backed by that same bot App identity and vaulted
credentials, reusing connection governance, discovery, policy evaluation, audit,
and publication infrastructure. Do not require a duplicate App or silently use
personal GitHub credentials.

Add missing operations through the normal tool interface: read PR metadata,
diffs, files, comments, and prior reviews; post/reply to comments; submit structured
findings, summary, score, coverage, and reviewed commit. Formal APPROVE and
REQUEST_CHANGES are separate governed tools/actions and both default off.

Every invocation derives company, agent, task, run, connection, and permitted
repository from server-side context. Recheck authority, repository access,
installation status, and connection status before publication. Credentials stay
inside the connection service, especially for guest runs. Setup probes effective
access for the chosen agent/repositories, including unsupported runtime handling.

## Events, prompts, and configuration

Editable templates cover new PRs, updated commits, reopened/ready PRs, mentions,
and follow-up comments. Typed event context includes repository, PR number,
base/head SHA, prior reviewed head, sender, action, and changes since last review.
Save immutable prompt revisions with execution context. Templates supplement
agent instructions; provider text is untrusted and cannot change authority,
connection selection, or the rating policy.

Connection defaults have per-repository overrides in Paperclip UI:

| Setting | Default / controls |
| --- | --- |
| Invocation | Linked-member PRs plus authorized mentions; optional mentions-only or sponsored all-author |
| Events | Opened, reopened, ready-for-review, new commits; individually configurable |
| Drafts and bot authors | Both off, independently configurable |
| Filters | Include/exclude authors, target branches, labels; ignored file patterns |
| Guidance | Event prompts, review instructions, categories, published severity |
| Publication | Summary and inline findings on; formal reviews off |
| Rating gate | Minimum 5/5; selectable 1–5 or report-only |

Manual requests bypass scheduling filters, retaining repository restrictions,
file exclusions, and requester authority. Comment visibility filters never remove
findings from the assessment. Ordinary discussion does not change a rating.

### Assessment rubric and publication

The agent submits a structured assessment; server validation and a deterministic
comparison with the saved threshold determine the check. The agent cannot submit
an arbitrary passing conclusion. Validate score, coverage, head SHA, findings,
line locations, rationale, and execution identity. Incomplete analysis has no
passing score regardless of threshold. The implementation uses this rubric:

| Score | Meaning |
| --- | --- |
| 0 | Incomplete analysis or no reliable assessment; cannot pass |
| 1 | Critical defects prevent safe use |
| 2 | Major correctness/security defects remain |
| 3 | Material actionable defects remain |
| 4 | Only minor actionable defects remain |
| 5 | No actionable defects found within explicitly reported coverage |

The score is an assessment, not proof of correctness. Coverage explicitly lists
inspected and excluded areas and unavailable context. Deterministic evaluations
must test known defects, clean changes, incomplete analysis, and malicious PR
instructions against this rubric before staging.

Maintain one current summary and review history; fingerprint findings to avoid
duplicate inline comments. Store publication receipts for retry safety. Formal
approval is never an automatic consequence of a 5/5 score.

## Backend contracts and delivery

Synchronize db/shared/API/UI contracts for configuration, prompt revisions,
registration sessions, capability bindings, review results, and publication
receipts. Review records reference ordinary task/run IDs. Use the existing durable
webhook delivery, task wakeup, and publication mechanisms. Deduplicate deliveries,
combine rapid pushes, and reject stale results from updating the latest summary
or check. Handle retries and restarts without duplicated comments.

The stable `Paperclip Review` check is tied to the exact PR head. Execution
controls queued/running/error states; validated results determine score success
or failure. New commits require a new assessment. If automatic work is disallowed,
show that an authorized manual review is required. Document how to require this
check from the correct GitHub App; never change repository rules automatically.
Report-only mode must remain distinct from a score gate and incomplete coverage.

New review installations request Contents read, Pull requests write, and Checks
write alongside existing chat permissions. Existing installations receive an
explicit permission upgrade path.

Manifest registration uses expiring, single-use state bound to user, company,
endpoint, and trusted origin. Exchange the returned code server-side and vault
credentials. Verify installation through GitHub, not return query parameters.
Recover registration-time webhook races using verified signed delivery. Limit
callback state lifetime and reject replay, wrong tenant/origin/user, and unsafe
redirects. Never expose private keys through browser state or logs.

## Cloud gateway route plan

| Surface | Gateway treatment |
| --- | --- |
| `POST /api/chat-webhooks/:publicId/github` | Exact public route; preserve raw body and GitHub event, delivery, and signature headers; instance verifies signature |
| `GET /api/chat-github/manifest/callback` | Narrow callback exception; instance verifies registration state |
| Installation return | Authenticated setup-resume page |
| Configuration and identity confirmation | Existing authenticated company-scoped routes |

Use the trusted current vanity hostname when generating URLs; honor explicit
webhook-ingress overrides. Cover warm-pool handoff and HTTPS proxy termination.
Do not add a broad webhook or management-route exemption. Test wrong paths,
methods, bad signatures, state replay, and company mismatches, not just accepted
requests. Configuration remains authenticated even though delivery must not
require browser login.

## Verification after approval

1. Implement approved components and backend contracts; run focused checks first.
2. Use an isolated local instance, publicly reachable HTTPS, disposable App and
   repository. A mention and an automatic event must each create a real task/run
   on the assigned agent with correct responsible-user attribution.
3. Prove agent discovery and invocation of bot-authorized tools. Record resulting
   comments, findings, scores, checks, tasks, and runs. Manual publication is not
   evidence of the agent workflow.
4. Exercise linked users, guests, revoked sponsors, denied tools, wrong repos,
   upgrades, template changes, drafts, rapid pushes, duplicate deliveries, stale
   results, publication retries, failed-to-passed after fixes, disabled/enabled
   formal reviews, task continuation, and unchanged existing chat behavior.
5. Run review evaluations, token gates, Storybook build, workspace typechecks,
   tests, and application build. Provide a local walkthrough; incorporate feedback.
6. Deploy the exact tested application revision and matching migrator plus Cloud
   gateway revision to a dedicated staging tenant. Repeat real workflows through
   Cloud with vanity URLs, delivery without login, restart recovery, and required
   checks in the disposable repository. Fix and retest affected scenarios.
7. Record revisions and direct evidence links. No production rollout or merge.

Initial scope is GitHub.com, UI-managed configuration, and the selected agent's
repository context. Cross-repository indexing, learned feedback, repository config
files, and auto-fix are deferred.


## Implementation qualification log (2026-09-19)

The approved setup and management UI, database migration, task admission, bot
capability bridge, structured assessment/publication outbox, and narrow Cloud
routes are implemented in the worktrees named above. The UI warns for standard
agents and links the existing Paperclip Docs low-trust guide; a separate Docs
worktree adds GitHub-specific guidance to that guide.

Verified so far:

- Workspace typecheck and application build; subsequent focused server/UI
  typechecks; token gates; Storybook build.
- Focused integration cases use an isolated real database and mocked GitHub
  responses: signed PR event admission into ordinary tasks, delivery deduplication,
  member/guest access and sponsor revocation, registration state expiry/replay,
  current repository access checks, task-scoped tools, exact-head scoring,
  disabled/enabled formal review, immutable assessments, idempotent retries,
  previous assessment/delta context, failing-to-passing checks, one current
  summary, and incomplete checks. These do not establish live agent behavior.
- Cloud: 1,617 tests passed, 33 skipped, no failures on Node 22; smoke:qa and
  server/web builds passed. Docs: static build passed (258 pages).
- Browser: Storybook agent warning; real isolated authenticated setup with the
  warning, documentation link, existing-App form, Back navigation and saved
  stage after restart. A disposable private GitHub repository was created.
- GitHub rejected a manifest callback URL containing the registration state.
  Fixed the implementation to send state in the registration URL and leave the
  callback URL plain, following GitHub's manifest protocol. The corrected form
  still needs a successful live registration.

The latest GitHub-focused selection passed 173 tests; policy validation passed
11 tests. A separate guest test confirms no GitHub credential export. The full
connector suite passed 1,012 of 1,013 tests; the existing rapid Slack callback
ordering case failed once under load and passed its focused rerun. Do not report
this as a completely green full-suite run.

Follow-up revision `72bb47c1b` pins automatic tool requests to the commit admitted
by their causal event, preserves the event's policy/prompt revision, and fixes
published links to include the company prefix and the underlying run. Both the
signed-event/head-fence and governed-publication integration cases passed after
this change; server typecheck passed.

The UI suite passed all 6,478 tests in 620 files. The broad workspace run exposed
pre-existing timing-sensitive tests and embedded PostgreSQL startup failures on
this host. Its shared-memory segment inventory was close to the macOS 32-segment
limit, so a skipped database suite is not counted as validation. The affected
suites are being rerun with bounded concurrency and isolated configuration. The
CLI import timeout passed its rerun; three database-heavy worktree cases still
need a clean run. The serialized server suite's initial import timeout passed
when rerun after the high-concurrency jobs finished.

Private live fixture: https://github.com/cryppadotta/paperclip-github-review-qa-20260919
at baseline `d4f8bd2` (three deterministic invoice tests pass). A local evaluation
branch `codex/qa-discount-regression` at `76028b7` deliberately breaks percentage
conversion and fails the expected test; it has not been pushed or opened as a PR.
This fixture does not count as an agent evaluation result.

Qualification is incomplete. The remaining broad Paperclip tests are running.
Chrome reports that an extension popup blocks automation on the GitHub setup
page; the user has been asked to dismiss it. No GitHub App installation, real
agent PR-review run, live tool invocation, live review/check, or staging deployment
has been claimed as successful. The local AWS staging profile is unavailable;
the existing pre-merge staging deployment workflow is the next deployment path
to qualify after the local GitHub workflow succeeds. No production rollout or
merge has occurred.


### Embedded-browser continuation (2026-09-20)

The embedded browser is signed in to GitHub and can read the private fixture.
The manifest form originally targeted a new window, which did not open in the
embedded browser. Revision `ac5f1f502` submits in the same tab, retaining the
saved setup and returning through the normal callback. The real UI now reaches
GitHub's **Confirm access** screen. User verification is pending there; no App
registration or agent review is yet counted as complete.

The overnight general server run reported 12,720 passing tests, eight failed
tests, and 92 skipped tests (664 passing files, four failed files, three skipped
files). Follow-up fixes document all 11 GitHub management API operations with
board-only security and update native runtime test mocks for task-bound bot
connections. The focused contract/policy/runtime run passed 27 tests. The added
native task-binding case also passed. The earlier inline-patch failure did not reproduce in the current policy
suite; the original test process overlapped the addition of that function.

The bounded remaining workspace group passed 2,617 tests (20 skipped), and all
63 CLI worktree tests passed on the isolated rerun. The environment custom-image
suite still fails starting an additional embedded PostgreSQL database near the
host's shared-memory segment limit; do not count its skipped cases as passes.
All 27 serialized suites after the OpenAPI suite passed. Together with the
120 passing suites before it and the corrected OpenAPI suite, all 148 serialized
suites have passing results across the original and resumed runs. The updated
application build, Storybook build, server/UI typechecks, and token gates passed.

### Live App registration and installation (2026-09-20)

After the user completed GitHub's access confirmation, a fresh manifest submitted
through the embedded browser successfully registered
[Paperclip Review QA260920](https://github.com/apps/paperclip-review-qa260920).
The App was installed as installation `163220189`, selecting only the disposable
private repository `cryppadotta/paperclip-github-review-qa-20260919` (ID
`1377781534`). No other repositories were selected. The manifest callback vaulted
the App credentials and resumed the saved Paperclip bot.

Live signed delivery was observed at `2026-09-20T11:28:48.689Z`. Setup retrieved
the installation repository list, saved the enabled repository, and verified
App identity, repository permissions, runtime support, and effective agent tools.
The bot's tools were assigned to the QA agent through the normal UI. These are
live provider/setup results, not yet agent execution results.

The personal-account linking step exposed a regression: the GitHub catalog entry
skipped the established chat/tool purpose choice and always opened bot setup.
The fix restores the shared choice, preserves direct/resumed bot routes, and links
account setup directly to the regular personal GitHub connection flow. All 43
focused UI tests pass, including five new routing cases; UI typecheck, build,
and token gates pass. Verification copy now describes the observed App identity
and avoids referring to an assignment button as being below the checks.

The corrected choice and regular GitHub connection form render in the embedded
browser. Browser control subsequently stopped changing page controls, including
ordinary connection radios; keyboard actions had the same symptom. The public
HTTPS endpoint and QA server remain healthy. A fresh embedded tab recovered
navigation but not form interactions; a user refresh was requested. Personal
identity linking, real task/run reviews, live publication, and staging remain
unverified. No outcome has been seeded in the database or manually published as
an agent result.

The disposable fixture branch `codex/qa-discount-regression` at `76028b7` is now
pushed to the private repository, ready for PR creation after identity linking.
No PR, agent run, review, or check has been created yet. Storybook remains
available on port 6017 with 49 GitHub review stories.
