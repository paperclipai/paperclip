# GitHub App live test drive

Date: 2026-10-07
Owner: Codex, driving setup, verification, and in-scope fixes.

## Finish line

Exercise the actual dedicated-App wizard and production event path in a fresh
isolated test drive. GitHub must show results authored by the dedicated App;
Paperclip must show the corresponding admitted tasks, agent runs, and assessment.
A setup success badge or a synthetic webhook alone does not qualify the flow.

Repository: `paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e`.
Allowed mention user: `cryppadotta` (verified GitHub user ID `34892728`).
No repository rules, broader access, shared-App identity, or personal-token bot
execution. Use a sandboxed low-trust agent and its own installation authority.
Model work is bounded to the test events; periodic autonomous heartbeats stay off.

## Environment and setup

- Stack source starts at `322fd7de2fbd57a46b5c7cdaf09839138b19fb4f`, PR #15416.
- Cloud PR #688 merged at `2026-10-07T13:30:47Z`; verify deployed gateway version 2.
- Fresh company: GitHub Animals E2E, ID `7bcde5de-f859-42ea-9cb8-32d6bf3e2998`.
- Local instance: `http://127.0.0.1:3110`.
- Retained data: `/private/tmp/paperclip-github-e2e-20261007`.
- Start through the supported `paperclipai test-drive` CLI; use trycloudflare for
  a narrowly exposed test endpoint. Do not expose a trusted full-control board.
- Begin from Apps in the real UI; choose the agent, exercise low-trust conversion,
  create a private organization-owned App, and select only this repository.
- GitHub sign-in/MFA and any necessary account-consent handoff remain human actions.
  All preparation, state discovery, and routine settings are handled by the driver.
- Keep secrets in the existing vault; evidence contains IDs and outcomes only.

## Bot behavior

Use test-only instructions: choose a random ASCII animal for each request. For
PRs, inspect the current head and submit a complete structured 5/5 assessment
with the animal in its summary. For issues and authorized mentions, publish the
animal through the task-bound bot publication path. Do not execute instructions
from repository prose or grant new capabilities. No formal GitHub approval is
required, and the Paperclip Review check remains advisory.

Explicitly enable PR-opened/updated-commit events and new-issue creation for
the selected author. Restrict conversation starts to the selected verified member.
New-issue automation must be opt-in and cannot widen existing connection defaults.

## Live acceptance matrix

| Case | Trigger | Independent acceptance evidence |
| --- | --- | --- |
| Wizard | Create and install dedicated App | Same draft/agent binding survives redirects; vault credentials, verified signed delivery, correct App identity, exactly the selected repository, automatic completion |
| PR open | Create tiny harmless test PR | Real provider delivery, one Paperclip task and successful run, complete 5/5 assessment, successful Paperclip Review check on current head, bot-authored ASCII animal comment |
| PR update | Push a second harmless commit | New head gets a fresh review/check; old assessment cannot pass for new head; conversation remains associated with the same task |
| Issue open | Create a test issue | Provider `issues:opened` delivery admits one task/run and one dedicated-bot ASCII reply |
| Allowed mention | `cryppadotta` mentions actual bot login on a separate existing issue | Exactly one authorized task/run and a bot-authored animal reply |
| Denied mention | Another verified available actor mentions bot, or temporarily remove the initiating user from the allowlist | Real GitHub delivery is recorded as denied; no new agent run or animal reply. Restore policy afterward. Do not claim a second-human test if unavailable |
| No mention | Plain comment on an unrelated existing issue | No task starts merely because the bot receives comments |
| Duplicate | Redeliver a successful GitHub delivery | Delivery/session idempotency prevents duplicate tasks or publications |
| Persistence | Reload/restart after connection | Same App, draft, repository restrictions, identity, and settings; a later real event still works |

## Execution and fixes

Keep a compact record of visible screen transitions and provider-to-task-to-output
IDs. Inspect failures at their real boundary: deployed capability, enrollment,
callback claim, local exchange/vault, installation discovery, signature admission,
person/repository policy, sandbox execution, model/tool use, or publication.
Fix concrete defects with focused tests and rerun the affected live journey.
Do not substitute direct webhooks silently for the Cloud gateway being qualified.

Implemented the gap found during preparation: both manifest builders now subscribe
to `issues`, and new-issue intake has an explicit opt-in with the existing
repository, person, responsible-member, guest, and revocation boundaries. Issues
create ordinary tasks and cannot create PR assessments or commit checks.

## Evidence and cleanup

Link the actual GitHub PR/issues/comments/checks and Paperclip task/review/run
records here as they become available. Preserve screenshots of meaningful UI
states and sanitized runtime logs in the temporary evidence directory. Record
source revision, settings revision, time, and model costs alongside results.
Close disposable issues/PRs and remove their test branch after qualification;
retain the bot and test-drive data for the user's inspection unless asked to remove
them. Stop the public tunnel and relay at the end. Retain the private test runtime for inspection, with restart commands.

## Progress and remaining qualification

Updated 2026-10-07 after the final live retests. **The organization-owned App and all requested bot behaviors passed.** Six GitHub-triggered native runs succeeded. The final configuration is revision 4, with cryppadotta as the only permitted linked member. The same draft, connection, App, repository restriction, identity and vaulted credentials survived a restart. The historical diagnostics below record failures that were fixed or superseded; they are not pending handoffs.

Independent proof is saved in `live-e2e-proof.json`. The live acceptance results and remaining qualification limits are recorded at the end of this plan.

- Cloud staging advertises `githubApps.version=2` and `sealed_gateway` at
  `https://my-staging.paperclip.app/v1/connector/capabilities`. Production does
  not yet advertise this capability; this test uses staging explicitly.
- Test server is pinned to port **3110** after a sibling dev instance acquired
  3109. The sibling was left untouched. Same company, agent, draft, and vault
  survived the restart.
- trycloudflare: `https://drew-changes-emacs-analyze.trycloudflare.com`. Its local
  relay on 23109 exposes only a landing page and redacted `/api/health`;
  mutations and trusted board routes are denied. GitHub uses Cloud gateway
  ingress, not this tunnel.
- Animal Bot: `4be7066f-130b-4bfd-9a1a-740d52fe5080`. Real UI agent selection and
  one-click low-trust conversion passed. Agent instructions request 5/5 reviews
  and random ASCII animals through task-bound bot tools.
- Draft `d5918d73-be6a-46b7-bf89-01e396c84ce8` retains organization `paperclipai`
  and suggested name `Animal Bot E2E 20261007` after reload/restart.
- Cloud enrollment for **http://localhost:3110** is approved. Human sign-in and access confirmation completed. Installation selected only the designated test repository, and the dedicated App identity was linked and confirmed.
- Existing Daytona environment `49bd3525-7d3b-4edf-b719-95e48431ea06` uses the
  authorized vaulted key and snapshot `fleet-sbx-01e815d1e284-5caa7196b56e`.
  Low-trust and sandbox isolation remain enforced; periodic heartbeats are off.

### Source verification

- Event/parser and scheduling tests: **17 passed**.
- New-issue signed-ingress integration cases: **2 passed**, including default-off,
  deduplication, author-versus-sender identity, and publication revocation.
- Full GitHub agent review workflow integration group: **30 passed**.
- Server/UI targeted typechecks and UI token gates passed.
- Full `pnpm -r typecheck` and `pnpm build` passed.
- Final full typecheck and build passed after the enrollment fixes.
- Full `pnpm test:run` failed: **29 files failed, 711 passed, 59 skipped; 6 tests failed, 12,958 passed, 3,464 skipped**. Most failed suites could not bootstrap embedded PostgreSQL. Other failures include adapter accounting and large Git/Teams timeout cases. Do not label the full suite green or claim a verified baseline.
- New origin/enrollment-return tests: **23 passed**. GitHub integration regression including bound-registration origin changes: **30 passed**. Wizard UI including same-draft enrollment return: **14 passed**. Token gates passed.

### Real runtime evidence

- CLI run `7ea67041-d357-48e9-aec1-f8d230613f8e`, model `gpt-5.4`, ran inside
  Daytona and returned an ASCII animal. Its per-run callback endpoint refused
  connections, so it could not write the required comment or complete GIT-1.
  A successful model exit is **not** a passed task or GitHub E2E test.
- Automatic recovery run `322ce17e-3a56-485b-a8a7-7183c5faf69e` could write a
  comment and block GIT-1. It correctly could not schedule privileged retries.
  Both CLI runs failed to load `Paperclip_connections` and `Paperclip_projects`
  MCP servers because the sandbox cannot use host localhost endpoints.
- Switched the same bot to `paperclip_runner` / Codex / `gpt-5.4` in the same
  sandbox. Native tools use the authenticated Runner transport. GIT-2
  (`ac96bb88-2c6b-413c-8fd8-a59b26202128`) is a bounded fresh runtime smoke.
- Native run `13cda2bc-1bf4-4e97-b3b0-f189ba4e6a0a` stopped before model work:
  `runner_remote_artifact_platform_mismatch`. This Mac checkout lacks a matching
  Linux Runner artifact. Building this checkout's locked Runner source using
  an existing first-party Linux Docker image; without a separate paid sandbox probe.
- Matching Linux Runner built and verified from the locked current source;
  source, protocol asset, and binary hashes are recorded in
  `linux-runner-build-provenance.json`. The same environment and snapshot are
  retained. Startup retries create and release normal per-turn sandbox leases;
  no separate environment or paid capability-probe campaign was created.
- Native smoke run `f0d4b1e0-cf03-47bf-a77f-b3fcf1085fba` **passed** from
  14:48:51–14:49:33 UTC: bot-authored ASCII comment
  `799b4d23-8c68-4608-bb31-f1fcdde32490` persisted, then GIT-2 became `done`.
  Independent task/comment/run evidence is in `native-smoke-proof.json`.
  This qualifies native model/task tools in Daytona, not GitHub publication.
  Model `gpt-5.4`; metered OpenAI receipt remains `unpriced` / cost null.
- A live restart exposed the CLI ignoring saved `server.port` and moving to a
  lower free port. Fixed `prepareTestDriveEnvironment` to prefer the saved port
  and move upward only when occupied. All **34** CLI test-drive tests pass,
  including available and occupied saved-port cases; CLI typecheck/build pass.
  The test drive was then verified back on 3110, preserving enrollment origin.
- Model secret references stay vaulted. A normal agent config save replaces
  declaration IDs, so the driver refreshes the exact model-binding grant through
  the permissions API after configuration edits. No broad secret grant.
- Costs recorded by Paperclip are unpriced/null for the CLI turn; do not invent a
  monetary value. Startup-only failures did not run a model. Retain separate
  actual runtime, deterministic fixture, and external publication evidence.

### Evidence and resume

Sanitized evidence: `/private/tmp/paperclip-github-e2e-evidence/`.
Full check logs: `/private/tmp/paperclip-github-e2e-full-{typecheck,tests,build}.log`.
Linux build log: `/private/tmp/paperclip-github-e2e-runner-linux-build.log`.

The live matrix is complete. No GitHub consent handoff remains pending. The earlier TES-1 monitor remains paused. Retain the App, bot and test-drive data for inspection; close only this test's disposable provider fixtures and stop the owned public relay/tunnel.

Restart the retained instance with:

```sh
cd /private/tmp/paperclip-github-gateway-pr
PATH=/private/tmp/gateway-tools:$PATH node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts test-drive --data-dir /private/tmp/paperclip-github-e2e-20261007 --no-browser
```

Its instance `.env` contains the non-secret Linux artifact path and staging
gateway configuration; its model credentials remain in the retained vault.
Do not print the `.env` file or expose trusted board routes through the tunnel.

The earlier provider fixtures are now qualified:

- Mention issue: https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/1 . Created before installation to isolate mentions from issue-open automation.
- PR: https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/pull/3 . Branch `codex/github-animals-e2e-20261007`, harmless file `paperclip-animal-e2e.txt`.
- Initial head: `c1525d7a904142590babb421971e7590d0a03b26`.
- Retest head: `b046e7e18bdda6208515088540aee438091ab120`.
- New issues: https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/2 and https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/4 .

The following sections are chronological failure diagnoses. Their original intermediate limits are superseded by the final live results.

### Live enrollment diagnosis 2026-10-07T15:17:51.100312+00:00

Cloud enrollment was approved for `http://localhost:3110`. The old consent expired and was renewed with the same recipient/scope. Two actual setup defects surfaced: the enrollment return allowlist rejected the company-prefixed chat wizard path and fell back to the connector list; GitHub registration used the numeric loopback alias while Cloud correctly required the exact enrolled origin (`RETURN_ORIGIN_NOT_ENROLLED`). Fixed the unprefixed chat return path and its narrow allowlist, and select an already enrolled loopback alias only on the same port. Retry retains registration ID/state, using the current approved destination. Added 23 passing focused tests; server typecheck and token gates passed. No App was created before the rejection.

A restart briefly failed because macOS exhausted its SysV shared-memory IDs. Released exactly one orphan with zero attachments and a verified exited creator; did not stop sibling services or change kernel limits. Retrying the owned instance with the same database.

### Login-return recovery diagnosis 2026-10-07

The user completed GitHub login. Reopening the old manifest URL by GET lost the POST manifest, and GitHub displayed a blank personal-App form. No App was created: the organization App list contains no Animal Bot E2E 20261007, and the exact local draft still has no App ID. Its 30-minute registration had expired; the wizard incorrectly implied an App already existed and offered only credential recovery.

Added manager-only renewal of an expired, unconsumed Cloud registration after an explicit no-App-created attestation. It rotates bound routing state, retires the old registration, preserves owner/name/agent/connection, and refuses live, claimed, consumed, failed, exchanging, other-manager, and stale submissions. Eight focused integration cases and 16 wizard UI tests passed. Cloud consent remains approved for the same localhost origin. No provider creation, installation, or external bot publication is yet qualified.

### Browser POST diagnosis and current consent handoff

The initial scripted manifest form repeatedly reached GitHub's 500 page before creation. A loopback-only diagnostic using an ordinary HTML form reached the creation confirmation with the identical manifest, under both numeric loopback and localhost origins. No permission or manifest-field workaround was needed. Changed the real wizard to a mounted native POST form; verified that Continue to GitHub now reaches **Create GitHub App for paperclipai**. Fresh API preparation submits the mounted form with requestSubmit, guarded against duplicate effect execution. Wizard regression suite: 17 passing tests.

An action-time browser confirmation is pending for the exact private App, designated smoke repository, read contents/metadata and write issues/pull requests/checks, with webhook events routed through the staging Cloud gateway. Earlier blanket approval does not meet the browser tool's action-time access requirement. No App creation, repository installation, or real GitHub bot publication has occurred. The exact draft and approved enrollment are retained; the native model/task smoke remains qualified separately.


### Created-App scope failure and recovery — 2026-10-07 17:33 UTC

The user confirmed the exact App/repository access and completed creation. GitHub returned App ID `5226756`, name `Animal Bot E2E 20261007`, slug `animal-bot-e2e-20261007`. The stack rejected its valid `issues` subscription because credential verification still used a PR-only optional-event allowlist. Added `issues` to the optional allowlist, retaining older Apps and rejecting broader events/permissions. Six focused credential/lifecycle cases passed; server and UI typechecks passed.

Validation failed before credentials entered the vault. Recovered this same App through the normal manager existing-App API with a newly generated key and paired OAuth client credentials. Extended that API's optional recovery fields to accept both OAuth values together; secrets stayed in the vault, and transient plaintext files were deleted after successful storage. No duplicate App was created. The one-time manifest credential-loss edge remains a recovery concern: this fix does not implement a durable sealed receipt before validation.

Installation `168949146` is scoped to repository ID `1389500980` only. Native GitHub selection and identity confirmation completed; the original draft, connection and bot remain bound. Signed installation delivery independently passed. The no-mention control was delivered and filtered without task creation. The allowed mention admitted GIT-3 (`cef78507-a1e5-4f34-9379-384bc8f5cfbd`) and native run `2aa46373-3165-4714-b42b-1aa407a22f39`. Ordinary-comment orphan ordering delayed mention admission by approximately one minute; this is bounded behavior, not a lost delivery.

Live fixtures now open: issue 2 (new-issue automation) and PR 3 (initial head `c1525d7a904142590babb421971e7590d0a03b26`). Do not claim completed publication based on queued/admitted work. Connection screenshot: `github-connected.png`; scope proof: `github-selected-repository-consent.png` in the evidence folder.


### Duplicate response fix and final live results

The first successful tool publications exposed another product defect: the native runner's final summary replaced the generic progress comment with another animal, duplicating the tool's authoritative reply. Final presentations now remain internal after a confirmed task-bound GitHub comment, formal review, or assessment-summary receipt. The receipt must match the company, issue, run, endpoint, conversation and assigned agent. Pending/failed operations, another run's receipt, and check-only assessments do not suppress a final response. A generic completed progress marker remains.

A focused integration case verifies those receipt boundaries. The complete GitHub review workflow group passes **38 tests**, and chat-run publication units pass **20 tests**. After restarting the same instance, three real provider events each produced one animal response plus the generic completed marker, with no duplicate runner animal.

| Case | Result and independently observed evidence |
| --- | --- |
| Dedicated App setup | App `5226756`, slug `animal-bot-e2e-20261007`, installation `168949146`, repository `1389500980` only. Wizard completed automatically after installation and identity confirmation. Signed delivery and connection verification passed. |
| PR opened | Run `8b318bd5-3464-4a8d-a979-b918a322ea15` succeeded. Assessment `4074d5fc-87e9-4ccb-a1a6-ee6d8e6e75e4` completed at 5/5. Check `112924406209` passed on initial head `c1525d7...`. The App authored the animal review. |
| PR updated | Same task `344e157e-ba0f-416e-8c4b-d5819a7e95bb`; run `87545503-e6be-410a-85bf-316db115aa8c` succeeded. New assessment `fdff7e83-a777-4817-af0c-79f2eb8c08dd` completed at 5/5. Check `112928995770` passed on exact new head `b046e7e18bdda6208515088540aee438091ab120`. |
| New issue | Issue 2 run `28fcb039-2663-4773-93ef-4262e490bfa0` and post-fix issue 4 run `04308fc0-11c7-4f3a-b42b-478ba7b56118` succeeded. Issue 4 has one bot animal reply, comment `6043522941`. |
| Allowed mention | Initial run `2aa46373-3165-4714-b42b-1aa407a22f39` and post-fix run `97fc1ec0-4499-43c1-a6bb-f2ed972893d1` succeeded on the same task. Post-fix animal comment `6043507486` is authored by the dedicated App. |
| Denied mention | Temporarily removed cryppadotta from the allowlist, posted mention `6043347709`, and observed `filtered` with `Linked Paperclip account is not currently permitted`. No new run or reply. Restored exactly the prior policy as revision 4. This did not use a second human actor. |
| No mention | Ordinary comment `6043243532` was delivered and filtered because it did not address the agent or an active task. No task/run admitted. |
| Duplicate delivery | Redelivered original PR delivery `0efb52f0-c275-11f1-9c40-56d38adaec3f` through GitHub's controls. GitHub recorded HTTP 202 at 17:42:29 UTC. One original local delivery remained, with no extra task, model run or publication before the later fresh-head event. This qualifies duplicate prevention across the gateway; it does not claim a second stack admission. |
| Persistence | Restart at 17:41 UTC retained the original App, draft, connection, vault, identity, selected repository and revision 4. The three subsequent live events passed. |

Inspectable provider results:

- [5/5 review on the updated head](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/pull/3#issuecomment-6043294143).
- [Passing current-head check](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/runs/112928995770).
- [New-issue animal reply](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/4#issuecomment-6043522941).
- [Allowed-mention animal reply](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/1#issuecomment-6043507486).

All corresponding Paperclip tasks finished. All ten recorded sandbox leases have successful cleanup (eight expired, two released); no active lease remains. Costs were not independently priced for this qualification and no monetary estimate is claimed.

Final source checks after the response fix: repository typecheck, build, token gates and diff whitespace check pass. The earlier full-suite run remains a failed result, not a green claim: 29 failed files / six failed tests, with PostgreSQL bootstrap failures and adapter/timeouts. It was not rerun after the final response fix; the changed workflow's 38 integration and 20 publication tests were rerun and passed. The PR remains draft pending current-head CI/review and full-suite failure resolution.

Qualification limits: personal-account setup, delayed organization approval and production Cloud deployment were not tested live. Creation required recovery of the same App after the obsolete validator discarded its one-time manifest credentials; durable sealed credential receipt before validation remains an unresolved recovery improvement. The wizard's connected summary still lacks a repository list, and local task/run labels in GitHub comments lack public links. These do not change the verified event, access, check or publication outcomes.

### Cleanup completed

Closed disposable issues 1, 2 and 4 and PR 3 without merging. Deleted only the test branch. Retained the App, original connection, bot, vault and test-drive data. The public relay/tunnel was stopped. The private test drive remains available on port 3110 for inspection. Fixes and qualification record were pushed to draft PR #15416; current-head CI/review remain outstanding.


### Management page hierarchy qualification

The connected bot now separates instructions, triggers, and review output in
Settings from repository, people, and tool permissions in Access. Each linked
person appears once. Advanced controls are disclosed. Settings and Access share
one versioned draft across all connection tabs. Reviews show the latest assessment
per repository/PR and preserve earlier commit evidence in history. Conversation
titles link directly to tasks; provider labels link directly to their threads.

Walkthrough: Connectors → search GitHub → Animal Bot → Settings → Access → Reviews
→ Conversations. A harmless trailing newline was saved from Access after editing
Settings, persisted after a reload, and then was removed through the UI. Redacted
API snapshots confirm the full configuration returned exactly to its original
value (revision 4 → 6). Repository and people permissions were not changed.

The real instance was inspected at its desktop width, 820px, and 390px with the
actual mobile shell. Review history expanded correctly and the ASCII animal
rendered as a code block. Production Storybook fixtures verified a saved edit,
a pending current commit with its previous passing score hidden, a recoverable
configuration failure, and a mobile empty conversation state. These fixtures do
not qualify any new provider execution. Screenshots and configuration comparisons
are in the existing local E2E evidence directory.

Focused UI checks cover draft retention, revision conflicts, isolated repository
updates, override preservation/unique field IDs, implicit linked-member event
configuration, mentions-only trigger preservation, latest-review ordering, pending
head presentation, and GitHub thread labels. The affected management, setup,
AgentMail, sidebar, and shared UI-contract group has 47 passing tests. Repository
typecheck/build, Storybook build, and token gates pass. The earlier full-suite
failure and outstanding current-head CI/review remain as recorded above.

### Independent GitHub setting and review detail qualification

GitHub review bots now use their own default-off instance experimental setting.
The shared validator, persisted settings, managed feature catalog, setup and
management routes, catalog, agent channels, task controls, identity-link admission,
and agent connector discovery use that setting independently from chat connectors.
Existing event delivery is not paused merely by hiding the UI.

The same local test drive was restarted and inspected with **GitHub review bots
on and Chat connectors off**. Connectors showed both GitHub tools and the dedicated
review bot. Opening Animal Bot still reached Settings and Access. Reviews showed
the two real commit assessments as separate rows. Each row opened its own detail
URL with the exact commit, Markdown summary, rationale, coverage, and task/run,
GitHub comment, and check links. Reload retained the detail route; All reviews
returned to the list. The detail kept the Reviews contextual navigation. Desktop
and 390px list/detail layouts were inspected.

Formal approval and request-changes controls retain their off defaults and have
tooltips describing explicit actions after a completed assessment, independent
of scores and checks. **Run automatically** explains each person's authored
PR/issue scheduling and preserves mention-only access when disabled. The
responsible-member tooltip explains Paperclip accountability without personal
credential delegation. The tooltips were opened in the live UI, including the
approval tooltip at 390px. **Add external contributor** replaces the old label.
The normal bot-tools switch is removed; saved disabled restrictions remain
disabled until an explicit repair is saved. No bot configuration was changed
by this walkthrough. A final read found revision 7 with a separately saved
PR-opened prompt change relative to the previous revision-6 snapshot; that edit
was preserved. Tools, repository access, and formal review permissions remain
unchanged.

Focused verification: 388 UI tests and 134 backend/shared settings and identity
tests pass. The added connector-discovery integration test passes with a disposable
local PostgreSQL database; the sandbox-only attempt skipped because it could not
open the database port. The management UI group was rerun after the final tooltip
copy edit and passes. Repository typecheck/build, production Storybook build,
and token gates pass; the final discovery change also received focused server
typecheck/build. These checks do not qualify a new provider or model run. The
earlier full-suite failure and outstanding current-head CI/review still apply.

### Custom App identity and branding qualification

The live bot is the dedicated **Animal Bot E2E 20261007** App owned by
`paperclipai`, not the shared Paperclip App. Its verified GitHub author is
`animal-bot-e2e-20261007[bot]`; the human mention is
`@animal-bot-e2e-20261007`. The published review's GitHub author and App fields
agree with the saved endpoint identity.

The setup name field now explains GitHub's derived mention. Connected bots show
the verified, copyable mention in the header. Settings and wizard completion
share an optional App name/logo disclosure, the agent's PNG download, and the
owning App's GitHub settings link. Personal accounts use their corresponding App
settings path. Unknown legacy ownership uses the settings list, never an assumed
organization or the installation settings page. A renamed App can refresh its
identity through existing-App reconnect with stored credentials.

The preserved test drive was restarted after an interruption. The live header
showed the correct mention; copying and pasting it into an unsaved field proved
the exact text, then the original field was restored without saving. Downloaded
avatar is a 512×512 PNG, 30,616 bytes. Desktop and 390px branding layouts were
inspected. GitHub's App settings link reached its signed-in re-authentication
gate; no name or logo was changed, and App rename/reconnect was not tested live.
GitHub's manifest has no logo field, so provider upload remains an optional
GitHub settings action. No configuration, credentials or permissions changed in
this walkthrough.

All 59 focused management, setup, avatar-download and clipboard tests pass,
including Slack's existing download/error/retry coverage for the shared
downloader. UI typecheck/build, production Storybook build and token gates pass.
The earlier full-suite failure and current-head CI/review limits still apply.

### HTTP prerequisites and delayed-ping recovery (October 7, evening)

A second dedicated App, **Animal Bot Baby**, returned from installation with
`chat_webhook_not_verified`. This was a callback-ordering failure, not evidence
that localhost needs a tunnel: the original registration was created at
01:13:44 UTC on October 8, and a valid signed ping was recorded at 01:15:19 UTC.
Cloud enrollment and HTTPS gateway delivery were already active.

The wizard now explains HTTPS webhook delivery before selecting an agent on an
HTTP instance. Missing or unavailable enrollment shows a warning with Cloud or
public-HTTPS setup guidance; active enrollment explains that Cloud supplies the
HTTPS webhook. Desktop and 390px layouts were inspected without creating
another draft or App.

An installation return before the signed ping now redirects to the original
draft's waiting screen. Polling continues setup after the ping authenticates,
without weakening the manager action's signature gate. Live recovery also
exposed a `verifying` endpoint still at `provider_setup`; the wizard now finishes
configuration at that stage instead of prematurely attempting the optional
setup test. Already configured connections still require explicit reconnect.

After restarting the preserved test drive, the same Animal Bot Baby App and
draft reached **GitHub connected** and `active` / `complete`, with mention
`@animal-bot-baby`. Its saved signed-ping timestamp, company and assigned agent
remained unchanged. The original Animal Bot E2E connection remains active at
configuration revision 7. No new App, tunnel, provider permission, credential
entry, model turn or review execution was performed by this recovery.

All 21 focused database-backed wizard tests and 32 focused setup/management UI
tests pass. The delayed-ping regressions exercise both draft and installation-
advanced states through real configure/finish calls, reject unsigned pings,
retain App identity/configuration, and create no agent wakeup. UI/server
typecheck/build, production Storybook build, token gates and diff whitespace
checks pass. This remains connection qualification; the earlier full-suite
failure and outstanding current-head CI/review limits still apply.

### Correction: Cloud-backed localhost needs no HTTPS prerequisite (October 8)

The preceding HTTP prerequisite banner was misleading. Cloud already provides
the public HTTPS receiver, and localhost retrieves signed events through
outbound requests. The user's Paperclip origin does not need HTTPS or a tunnel
for this wizard. Removed the banner, its extra enrollment-status query, and
the two obsolete component stories. Keep the existing conditional Connect
Paperclip Cloud handoff as the actual setup action when enrollment is absent.

The running localhost wizard now shows Choose agent without an HTTPS warning.
No new connection or App was created during this correction. The delayed-ping
waiting and same-draft recovery fixes remain in place. All 30 focused setup and
management UI tests, UI typecheck/build, Storybook build and token gates pass.
The earlier full-suite and current-head CI/review limits still apply.

### Explicit mentions in descriptions and comments (October 8)

The user's issue #5 contained `@banana-bot-man` in its description. Its signed
`issues` delivery reached the stack at 11:24:21 UTC and was acknowledged, but
the handler used automatic issue policy without looking for an explicit
mention. Mentions-only correctly disabled automatic work, so no task existed.
The repository and configuring user's verified identity were already allowed.

Explicit mentions now enter the ordinary manual-message admission path for
issue and PR descriptions, conversation comments, inline review comments, and
submitted review summaries. Body edits trigger only when they add a mention;
an existing mention does not replay on pushes, title edits, reopening, or an
unrelated body edit. The authenticated editor is the initiating principal.
Original authors cannot lend their access to an unauthorized editor. The
existing repository, identity, membership, sponsor, runtime and low-trust gates
remain authoritative, including current-state checks before task mutation and
publication. Description requests do not automatically create review checks:
the agent must use its normal review tools when a review is requested.

Created comments preserve the native adapter's message and thread identities;
edited requests have distinct delivery-deduplicated identities. Comment edits
also retain their original lifecycle update. An explicit dependency processes
the new mention before an orphan edit receipt can wait for the old unmentioned
comment. Source URLs stay correct through both live and recovered admission.
Automatic policy skips appear in Activity without retaining provider content.

New App manifests subscribe to `pull_request_review` as well as the existing
four events. It uses the existing Pull requests permission, with no new
permission scope. Older Apps remain compatible; review-summary mentions need
that event enabled in their App settings. The gateway still transports the
original signed bytes, and the stack owns parsing and admission.

Live qualification used the existing Banana Bot Man App, company, agent,
installation, vault and single smoke repository, with revision 1 unchanged:
mentions-only, automatic events empty, and automatic issue runs off.

| Real GitHub source | Paperclip outcome | Provider outcome |
| --- | --- | --- |
| Issue #6 description | GIT-7 completed | One animal response from `banana-bot-man[bot]` |
| PR #7 description | GIT-8 completed; current head `7f456f37881bf4bfe39692f897d60e1625521298` | 5/5 review with animal; completed successful Paperclip Review check |
| Issue #8 without mention | No task | Activity explains mentions-only skip |
| Issue #8 comment edited to add mention | GIT-9 completed | Animal response from the same App |
| PR #7 inline comment | GIT-10 completed in the exact inline thread | Animal reply under that comment |

The original issue #5 was left intact. Review-summary delivery is covered by
signed integration tests; the existing App's subscription was not changed for
live qualification. All 51 GitHub workflow integration tests, 125 parsing,
policy and webhook configuration tests, 33 catalog tests, and seven native
GitHub adapter/provider regressions pass. The final five signed-source cases
also pass with mixed-case repository names and repository-specific guidance.
Workspace typecheck and build pass; server typecheck and build were repeated
after the final routing correction.

A fresh full `pnpm test:run` reported one failure in the unchanged
`workspace-runtime.test.ts` bounded-conflict case and was interrupted after
that failure while other server suites were still running. That exact test
passes in isolation. There is no verified baseline or green full-suite claim.
Logs: `/private/tmp/github-mentions-repo-tests.log` and
`/private/tmp/github-mentions-workspace-runtime-failure.log`.

Live review evidence: `/private/tmp/paperclip-github-e2e-evidence/github-description-mention-review.png`.


## Tool-owned GitHub replies — 2026-10-08

This supersedes the earlier receipt-dependent native-final policy and the
completed-marker behavior recorded above. GitHub discussion replies use the
agent's `comment` tool. Review replies use `submit_review`, which publishes the
summary and check. Runner final prose remains internal for every GitHub run.
Routine queued, working, native progress and completed comments are suppressed,
including retained automatic publications from an earlier instance version.
Explicit Board sends and real question cards remain available.

A failed run can publish one safe fallback if no reply was delivered. Confirmed
comments, formal reviews, assessment summaries and partial finding receipts
suppress it. Pending or ambiguous tool writes hold the fallback; an exhausted
retry or later authorization denial cannot disprove a possible earlier write.
The guard checks company, endpoint, conversation, task, assigned agent and run,
and repeats the check after acquiring the credential lane. Terminal reaction
cleanup stays independent of a provider comment. Legacy test-based setup accepts
a confirmed, causally bound tool reply instead of requiring a runner summary.

Mention and follow-up comments now start with the authorized GitHub username,
explain discussion and review tools, preserve custom guidance and ignored paths,
and identify provider context as untrusted. They omit the revision header and
empty exclusion list. They tell the agent not to quote the internal instructions
or add a separate review-completion announcement.

### Live evidence

The same low-trust Animal Bot, Daytona environment, dedicated Banana Bot Man
App, sole permitted repository and configuring member were reused. Configuration
revision **1** remains unchanged. These were real signed gateway deliveries and
native model runs; no synthetic webhook or host credential substituted for them.

- Issue #5: request comment `6061889213`, run
  `9ca64f81-6dcb-4db8-814b-922616a9a80d` succeeded at 14:19:46 UTC.
  [One ASCII fish reply](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/5#issuecomment-6061907432)
  was delivered by the `comment` tool. No routine or final-summary comment
  followed. The new task message names `cryppadotta` and uses the revised prose.
- The first PR retest, run `28e2f640-c9ec-4663-901b-6dbcbc8f4538`, submitted a
  review and separately called `comment` to announce completion. This was an
  agent-authored tool write, not an automatic stack publication. The prompt was
  corrected to explain that `submit_review` already publishes the answer.
- Final PR #7 request `6062038664`, run
  `1098a204-539b-4151-a5bc-4e161d8400c6` succeeded at 14:27:29 UTC.
  It called only the assessment publication tool, updating the
  [existing 5/5 summary with an ASCII rabbit](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/pull/7#issuecomment-6059614330).
  The [current-head check passed](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/runs/113363466934)
  on `7f456f37881bf4bfe39692f897d60e1625521298`. No new bot comment followed.
- All three runs retained internal final comments, cancelled their completion
  milestones without provider IDs, and completed acknowledgement removal.
  Read-only proof is retained at `/private/tmp/github-tool-owned-reply-proof.json`.

### Validation

- Full chat-channel integration file: **1,096 passed**, including unaffected
  providers, question cards, explicit Board attachments and recovery fencing.
- Final GitHub workflow, receipt cleanup, setup and replay subset: **78 passed**.
- Complete GitHub guidance/publication, event, receipt, webhook, origin and native
  access unit suites: **208 passed**.
- A concurrent policy run used the two old prompt expectations; the final updated
  policy suite passed. It is not counted as a final green combined run.
- Workspace typecheck and build passed. The final server build passed after the
  partial-assessment receipt guard changed. The previously recorded repository
  full-suite and current-head CI limitations remain; this is not a merge-ready
  claim. Failure-only and ambiguous-delivery cases were tested with fixtures,
  without deliberately breaking the live bot's sandbox or permissions.

## Known organization picker — 2026-10-09

GitHub setup lists organizations already observed through the configuring member's
usable repository connections and connected company bots. Repository discovery
retains GitHub's owner type, so personal repository owners and unknown legacy
observations are not misclassified as organizations. This adds no new OAuth
handoff or access grant. The account picker deduplicates organizations, preserves
saved ownership, and offers **Another organization** for free-text entry. The
two introductory App-creation paragraphs were removed.

Verification: 38 focused wizard/repository metadata tests passed. Shared build,
UI and server typechecks, UI, server and Storybook builds, and token gates passed. In the
retained test drive, `paperclipai` appeared from the existing connected App;
selecting it hid the redundant Organization field. **Another organization**
accepted `test` and enabled Continue. No GitHub registration was submitted.
The production Storybook journey covers known organizations and manual entry.
The repository-wide suite was not repeated for this focused follow-up; its
previous limitations remain recorded above.

## Mention acknowledgement cleanup — 2026-10-09

The stack already adds eyes when it durably accepts an authorized GitHub
comment, before queued work executes. Previously, removal waited for the native
run to finish. A confirmed comment or review-tool publication now stages removal
in the same transaction as its provider receipt. The existing reaction outbox
clears the original message independently, retaining retries, credential fences,
exact source binding and App-owned reaction checks. A late reaction add is
cancelled if the reply wins the race. Terminal cleanup still handles turns that
publish no reply; uncertain writes do not count as confirmed delivery.

Live test: the [Gonzo mention](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/5#issuecomment-6083303153)
was submitted at 14:49:44 UTC. Eyes were observed while Gonzo was queued. Its
[joke and ASCII animal reply](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/5#issuecomment-6083330049)
was posted at 14:51:20. Its eyes were gone at 14:51:24 while the same run was
still running; the native run succeeded at 14:51:31. Banana also received this
existing subscribed issue thread and replied. Each dedicated App removed only
its own eyes, leaving Gonzo's reaction intact until Gonzo replied. No subscription,
identity, permissions, runtime or configuration changes were made.

Evidence: `/private/tmp/github-eyes-live-observations.json`,
`/private/tmp/github-eyes-pending-20261009.jpg`, and
`/private/tmp/github-eyes-cleared-20261009.jpg`. The retained test drive remains
available on port 3110. Description and review-summary mentions still lack
reaction acknowledgement; this live proof covers a real issue comment.

Verification: 74 focused GitHub workflow and reaction integration cases, plus
all 34 GitHub receipt/provider stress unit cases passed. Server typecheck and
build passed. The broader three-file run passed 1,130 cases and failed the
existing rapid Slack callback-ordering test at its short wait deadline. That
case also timed out during a concurrent isolated run, then passed by itself on
both the previous commit `634a7dc53` and this change. The broad run is not claimed
green. No unrelated Slack code or test timeout was changed. Logs:
`/private/tmp/github-eyes-regression.log`,
`/private/tmp/github-eyes-final-targeted.log`,
`/private/tmp/github-eyes-slack-order-baseline.log`, and
`/private/tmp/github-eyes-slack-order-final.log`. Repository-wide checks were not
repeated for this backend follow-up; prior full-suite/CI limitations remain.

## Explicit mentions override bot subscriptions — 2026-10-09

Banana's existing issue subscription treated a Gonzo-only mention as an ordinary
follow-up. Both Apps share the Animal Bot agent, so Banana's unwanted run could
also delay Gonzo. Durable admission now checks exact, case-insensitive handles
of other non-archived GitHub bots in the same company. A message explicitly
addressed elsewhere is filtered before task work, agent wakeup or eyes. The
delivery ledger retains identifiers and the reason without retaining content.
Duplicate and recovered deliveries use the same decision. Mentioning both bots
still admits both; plain follow-ups, human mentions and unknown handles retain
subscription behavior. Automatic event policies remain unchanged.

Live test: the [Gonzo-only request](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/5#issuecomment-6083880345)
was posted at 15:22:51 UTC. Banana recorded "GitHub message explicitly mentions a
different connected bot" at 15:23:08 and created no run. Gonzo's
[single joke and ASCII animal reply](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/5#issuecomment-6083891075)
arrived at 15:23:29, 38 seconds after the request. Its native run
`3167e9d4-8154-4b88-af88-0316a1409c84` succeeded at 15:23:41. At the final
observation, no Banana reply or run existed and no eyes remained. This test did
not observe the pending eyes interval. Existing subscriptions, identities,
credentials, configuration and Daytona runtime were preserved.

Evidence: `/private/tmp/github-bot-routing-live-observations.json` and
`/private/tmp/github-bot-routing-gonzo-only-20261009.jpg`.

Verification: 13 new database-backed cases cover issue, PR and inline-review
subscriptions, exact handles, both-bot mentions, company/provider/archive
boundaries, duplicate deliveries and restart recovery. The broader GitHub
workflow/reaction group passed all 87 cases; three related unit suites passed
all 61 cases. Server typecheck and build passed. Logs:
`/private/tmp/github-bot-routing-focused.log`,
`/private/tmp/github-bot-routing-regression.log`,
`/private/tmp/github-bot-routing-units.log`,
`/private/tmp/github-bot-routing-typecheck.log`, and
`/private/tmp/github-bot-routing-build.log`. Repository-wide checks were not
repeated; the previously recorded full-suite and current-head CI limitations
remain. The retained test drive is running on port 3110 with this fix.

## Editable GitHub responses — 2026-10-09

Accepted GitHub requests now receive one App-owned working comment instead of
a new eyes reaction. The assigned agent has `update_comment` for meaningful
progress, then `comment` or `submit_review` replaces that same comment with the
final answer or review summary. No caller-selected comment ID is accepted.
Publication keeps its task, company, person, repository, credential and lease
checks. Marker recovery handles an uncertain first creation without duplicates.
Late progress cannot replace a final result. Terminal failure notices also edit
the same comment; a turn with no final publication ends with a neutral notice.
Existing disabled and quarantined tool decisions remain intact.

The first live trial correctly edited its acknowledgement with the final answer,
but the agent could not see the new progress tool. Its persisted Codex thread
retained the old declarations despite resume advertising the current catalog.
The native tool contract now rotates incompatible checkpoints while retaining
the same Paperclip task and saved history. Native GitHub guidance explicitly
permits provider progress edits and keeps semantic completion internal.

After that fix, the [issue request](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/5#issuecomment-6084847530)
was posted at 16:20:52 UTC. The [single Gonzo response](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/5#issuecomment-6084851008)
kept comment ID `6084851008` through these observed revisions:

| Time (UTC) | Response |
|---|---|
| 16:21:04 | Working on this… |
| 16:21:30 | Choosing a joke… |
| 16:21:33 | Joke selected; drawing the animal… |
| 16:21:38 | Final joke and ASCII animal |

Run `600d26e6-5065-414f-87eb-6b097192180a` succeeded. Both
`update_comment` actions and the final `comment` action were processed.

The [PR request](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/pull/7#issuecomment-6084888007)
was posted at 16:23:23. Its [single Gonzo response](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/pull/7#issuecomment-6084890857)
kept comment ID `6084890857`: working at 16:23:33, first progress at
16:24:00, assessment-ready progress at 16:24:15, final 5/5 summary and
ASCII animal at 16:24:20. [Check `113916193245`](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/runs/113916193245)
completed successfully at 16:24:23 on current head
`7f456f37881bf4bfe39692f897d60e1625521298`. Run
`701f9606-21fc-4c04-a37d-858b510e929f` succeeded. Its two progress edits
and review publication were processed. Banana filtered both source requests
without retaining content and created no new reply or run.

Evidence: `/private/tmp/github-editable-response-live-issue-v2.jsonl`,
`/private/tmp/github-editable-response-live-pr.jsonl`,
`/private/tmp/github-response-live-evidence.json`, and
`/private/tmp/github-editable-response-pr-final-20261009.jpg`. These tests
used the existing dedicated Apps, member identity, repository access and
Daytona runtime. The retained test drive remains running on port 3110.

Verification: 88 database-backed GitHub workflow cases passed, including issue,
PR and inline replies, retries, lost acknowledgement receipts, corrected review
assessments, revoked authority, ownership checks, failed turns and absence of
new eyes reactions. The 69 related publication/event/policy units, 49 native
checkpoint tests and 129 native prompt tests passed. Server and adapter-utils
typechecks and builds passed. Logs: `/private/tmp/github-editable-response-integration.log`,
`/private/tmp/github-editable-response-units.log`,
`/private/tmp/github-response-session-tests.log`,
`/private/tmp/github-response-runtime-prompt-tests.log`,
`/private/tmp/github-editable-response-typecheck.log`, and
`/private/tmp/github-editable-response-build.log`. Repository-wide checks were
not repeated for this follow-up; prior full-suite and current-head CI limitations
remain. This change adds no schema migration.

## GitHub instruction skills — 2026-10-09

Common and event-specific bot instructions now use the shared Markdown editor
and company slash-skill picker. Common instructions reach every admitted task;
event instructions reach only their event. The runtime selects skill keys from
the admitted configuration snapshot for the current wake, rather than scanning
GitHub messages or old task comments. Company scope, queued-event snapshots,
coalesced wakes, and the existing tool/isolation restrictions remain enforced.
The trigger selector now explicitly says **@mentions + automatic events**;
authorized mentions work in all modes, with separate per-person automatic-event
permission in Access.

The first real skill test exposed a native gap: the selected bundle reached the
runtime, but external chat correctly suppressed the old task description and
therefore omitted the native skill-selection signal. The native constructor now
projects only trusted, assigned skill names into that signal, retaining the
neutral external-chat title and excluding provider-derived skill references.
The checkpoint contract refreshes retained provider sessions so the current
selection is available during bootstrap.

For the live test, the shared editor inserted and saved `/github-instruction-smoke`
in Gonzo's common instructions. Its skill file contained an expected response
absent from the GitHub request. The initial request produced an honest unavailable
skill response. After the native fix, the [second request](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/5#issuecomment-6085445382)
ran as `5ca93e83-d8d8-4f13-b531-678437350497`. The native turn selected the skill,
read its materialized `SKILL.md` successfully, and posted the [expected response](https://github.com/paperclipai/paperclip-permissions-smoke-20260926-pap57-fee7428e/issues/5#issuecomment-6085451384):
“The otter has read its playbook.” plus the skill's ASCII animal. The run
succeeded and publication used the same working comment. Banana filtered the
request without retaining its content or starting another run. Temporary test
instructions were restored through the versioned manager API at revision 3;
the resulting configuration exactly matches the original configuration.

Verification: 88 database-backed GitHub workflow cases, 61 related policy/skill
units, 66 management/editor UI tests, and 67 native input/checkpoint tests passed
(three native transport cases were skipped). Server and UI typechecks/builds,
Storybook build, token gates and diff whitespace checks passed. Logs are
`/private/tmp/github-instruction-skill-{integration,units,ui-tests,native-tests}.log`
(the unit log is named `github-instruction-skill-units.log`), with live evidence
in `/private/tmp/github-instruction-skill-live-v2-evidence.json` and the screenshot
`/private/tmp/github-instruction-skills-live-result-20261009.jpg`. The broader
repository suite was not repeated; the earlier full-suite and current-head CI
limitations still apply. The retained test drive runs on port 3110.


## Settings and Access usability — 2026-10-09

Settings now separates always-available authorized mentions from the automatic-run
switch and event checkboxes. The passing-score slider spans report-only through
5/5. Automatic filters are grouped by authors, branches and labels. Ignored files,
inline options and formal review actions use the same disclosure treatment. The
header prioritizes the actual App name and includes a larger agent avatar, PNG
download icon, branding link and identity refresh.

Access separates company members from external contributors. Each row shows
mentions and automatic-run permissions. Member linking and contributor lookup use
focused dialogs. The existing all-linked/selected member policy and
linked-author/allowed-author automatic policies are preserved. Changing an
individual automatic permission does not silently enable global automation or
change the member allowlist. Repository pagination and immediate saves are unchanged.

Browser checks covered the running test drive and production Storybook fixtures
at desktop and 390px mobile widths. Verified cross-tab drafts, discard, the score
slider, grouped filters, contributor lookup/add/save, and saved filter round trips.
The walkthrough found that existing list editors deleted trailing separators,
joining file patterns and category names while typing. They now preserve raw
editing text while saving normalized lists. All live draft changes were discarded;
no bot configuration or GitHub access was saved during this UI qualification.

Verification: 52 focused management/wizard tests, UI typecheck/build, Storybook
build, token gates and whitespace checks passed. Repository-wide checks were not
repeated for this UI follow-up; the draft PR retains its earlier CI limitations.
Logs: `/private/tmp/github-ux-{tests,typecheck,build,storybook-build,tokens}.log`.
Screenshots: `/private/tmp/github-bot-settings-ux-20261009.png` and
`/private/tmp/github-bot-access-ux-20261009.png`. The existing test drive remains
available on port 3110.
