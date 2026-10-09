# Slack tools for Slack-origin agent tasks

Implement the approved Slack contribution through the existing connector runtime.
The authority is the verified originating connection and accepted linked sender;
retrieved messages are data, never instructions or authorization.

## Work and verification

- [x] Typed tool/method/scope matrix and bundled skill; no arbitrary Web API execution.
- [x] Task/run/endpoint/accepted-user binding, live membership, revocation and session compatibility.
- [x] Paginated reads, files, bounded history search, source links and honest coverage.
- [x] Durable governed writes, approval, retries, delivery reconciliation and duplicate prevention.
- [x] Private-source publication restrictions, including automatic replies and attachments.
- [x] Optional endpoint-bound personal search OAuth, credentials, refresh and disconnect.
- [ ] Native search only with qualified transient runtime delivery; no stored search responses.
- [x] Native and authenticated CLI operations, preserving AgentMail restrictions.
- [x] Settings capabilities, Access search authorization, scope upgrades and Storybook states.
- [ ] Focused security/provider tests, full checks and live Leaf staging proof.

Allowed Channels governs replies and writes. Reads require current bot membership
and requester access. Other users' bot DMs remain inaccessible. Ordinary writes
use existing action policy; destructive actions, channel creation and invitations
require approval. The agent cannot join existing channels or enable destinations.

Provider references: Slack Web API method documentation and
https://docs.slack.dev/apis/web-api/real-time-search-api/ . Native search requires
an event action token for bot calls, optional personal OAuth for private search,
and explicit runtime retention qualification. Unsupported runtime/provider states
must be reported accurately and retain bounded history search.

## Current verification

- Full workspace typecheck and build passed on the initial implementation.
- 39 focused access, provider, native authority and guidance tests passed.
- PostgreSQL integration passes admitted-event binding, cross-company/task/agent
  rejection, CLI route validation, ordinary writes, rate-limit retries, uncertain
  send reconciliation, approval after run completion, recovery, OAuth refresh,
  disconnect race and removed-profile/identity revocation.
- Storybook capability and upgrade screens inspected visually. OAuth fields,
  disabled save, secret clearing and connected/disconnect state inspected.
- Full checks after staging fixes: `pnpm -r typecheck` and `pnpm build` pass.
- General server suite: 679 files / 12,958 tests passed. UI retry: 626 files /
  6,555 tests passed. CLI passed in two groups after using canonical macOS TMPDIR.
  Shared: 770 tests; skills catalog: 20 tests; remaining source-only workspace
  packages: 184 files / 2,652 tests passed (19 skipped).
- Serialized server checks passed after a process-start timeout retry. The
  remaining route-test timeout passed on rerun; new Slack routes now have exact
  OpenAPI coverage. These are composite results, not one uninterrupted green run.
- Staging-fix checks: 89 transport/API/route tests and the PostgreSQL authority
  integration test pass. The latter now holds the endpoint lock concurrently
  and verifies resolution waits, then retains identity/revocation enforcement.
- Live staging on `4e00210da`: a linked Slack request read the channel decision,
  cited its source, created exactly two assigned backlog tasks through normal
  Paperclip tools, and added an eyes reaction. The quoted malicious task request
  was ignored. This fixture was posted by the linked tester; a live unlinked
  participant is not yet qualified (automated coverage uses unlinked sources).
- Bounded search scanned 35 top-level messages, returned four matches with source
  links, and reported its incomplete coverage. Thread reading completed with
  `hasMore: false`. Initial invalid search arguments were rejected before retrieval;
  the exact typed contract succeeded. The skill now includes a concrete example.
- Live canvas creation, append and read-back passed. The canvas was opened in Slack
  and contained the expected text. List creation, record insertion, update and
  read-back passed; the bot correctly reported that channel sharing needs approval.
- Initial staging defects (JSON transport, missing native source-channel guidance,
  endpoint lock race) are fixed and retested. Channel discovery subsequently found
  a listed channel returning `channel_not_found`; `d23bb857a` omits only definite
  access denials. Its unit/PG regressions, full typecheck and build pass. Deployment
  and live discovery retest passed on `653c9ad2b`: two pages exhausted, both
  accessible channels returned, and the natural-language search succeeded.
- Live disabled-response boundary passed: from the requester's bot DM, channel
  reading succeeded while a write was denied. The channel's original enabled
  setting was restored afterward.
- Explicit posting and editing passed without a duplicate send. Governed channel
  creation executed only after approval; the new channel remained disabled for
  responses and no invitations were sent. Leaf's independent signing secret was
  configured through its managed environment with explicit operator permission.
- Approval continuation exposed a missing return path: its result appeared in
  Paperclip but not Slack. The fix verifies the durable tool-review wake and every
  referenced action's source before authorizing publication, and separates wakes
  from different source runs. Authority/dedup integration and 81 gateway/response
  tests pass. Live retest on `bef1a0fad` passed: an approved deletion executed
  once, read-back found the disposable message absent, and the continuation's
  final answer appeared in the original Slack thread.
- Explicit upload with valid arguments delivered the registered text attachment;
  the agent read back its exact content from Slack. Initial malformed arguments
  were rejected before execution. Write schemas and the skill now emphasize UUID
  idempotency keys because ordinary artifact tools also accept descriptive keys.
- A separate completion-validator gap appeared when the agent tried to cite an
  earlier run's registered artifact during finalization: it requested registration
  again. The file was already delivered and no duplicate upload was made. This
  is an underlying artifact-reuse workflow gap, not a Slack transport failure.
- Optional OAuth, private multi-user boundaries, and CLI execution
  currently have automated coverage, not complete live qualification.

## Explicit runtime/provider limitations

Native RTS provider transport and OAuth are implemented but not connected to the
ordinary tool gateway: no current native/CLI runtime qualifies for Slack's
transient search-result retention requirement. Current tasks use bounded history
and filename/title search. Do not claim native public/private search passed live.

Inline file reading is limited to supported text/canvas downloads up to 256 KiB;
other files return metadata and an explicit limitation. Canvas/list writes depend
on Slack plan/scopes and cannot carry private research into an unverifiable shared
document audience. Uncertain effects other than posts/uploads need operator
inspection rather than an automatic resend. New approvals are needed to retry
failed approval-required operations. Ordinary rate-limit retries are limited to
the same still-authorized run.
