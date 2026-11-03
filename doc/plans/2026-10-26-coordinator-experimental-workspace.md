# Coordinator experimental workspace — functional implementation

Status: implemented in an isolated worktree; real-data browser verification passed for the review flow. The managed OpenAI connection is connected. The live native blog journey completed with a corrective intervention; required-review enforcement is being hardened before acceptance. Scott authorized this phase with “go” after CTO UX review. CEO review is deferred to the functional experience. This authorizes isolated implementation and verification, not production deployment or external publishing.

## Product contract

The selected Coordinator synthesis is the visual and interaction reference. Use the existing production models and owners for conversations, tasks, attention, questions, approvals, documents, artifacts, permissions, and native execution.

- Settings → Experimental exposes a personal, initially-off new-workspace preference. The classic experience remains usable. Switching does not stop or reset work, change task ownership, grant access, or alter budgets. Coordinator chat guidance can recommend task suggestions under existing permissions; the preference does not enable instance capabilities.
- Chat, Tasks, Needs You, More and mixed Recents form the primary navigation. An ongoing conversation belongs to a person and an agent. The coordinator is a default that can be changed.
- Chat extracts intent and success criteria. A suggestion does not create a task until accepted. Confirmed work stays represented by a task card in chat, with status and ID; navigation happens only on user action.
- Direct task creation remains simple and more structured than chat. Existing task hierarchy and work history survive.
- Task conversation stays in the center with a sticky composer. Contextual tabs open on demand. Needs You history is scoped to that surface. Reuse production tab selection, fading labels, keyboard interaction and mobile presentation.
- Needs You cards emphasize decision context and actions, use at most three type styles, and keep a visible perimeter. Revision entry replaces approval actions until cancelled. Resolved cards collapse to receipts; recent visibility decays while full history persists.
- A decision is recorded once. Task, Needs You and the originating agent chat show the same resolution. Chat receipts are compact and open the exact conversation location and reviewed work version. Quality acceptance is distinct from task completion, execution approval and publishing permission.
- Suggestions use Arrive. Confirmed cards resize and Gather light concurrently (prototype references: 480ms shape, 1,400ms light), clipped to the changing card; reduced motion settles immediately and navigation never replays creation. Relative timestamps retain exact accessible dates.
- Preserve the approved Precision palette/typeface with Editorial hierarchy, spacing, borders and subtle depth. Tokens and reusable components remain in the existing design system and Storybook.

## Isolation and baseline

- Source baseline: local master `1fbbef45a8d399771add7a27a04b12f3a20e264c`.
- Branch: `codex/coordinator-experimental`.
- Checkout: isolated `paperclip-functional` worktree.
- Separate runtime home: sibling `paperclip-runtime` directory.
- Instance: `coordinator-functional`; explicitly empty initialization; fresh signing keys; no immediate or deferred copy from the primary instance.
- Allocated ports: app 3210, embedded PostgreSQL 55460; verify actual ownership before claiming readiness.
- The original prototype remains in its separate worktree and is not the application baseline.
- The managed Codex worktree tool was unavailable for this chat placement. An ordinary Git worktree was created instead; the original checkout and prototype were not reset or altered.

## Milestones

1. Personal experiment preference and real-data workspace; retain classic and demonstrate reversible navigation on durable records.
2. Real internal blog journey: clarification → accepted task → native execution → copy and visual → revision → exact approval → usable channel drafts.
3. Narrow reliability proof: mixed users/interfaces, retry uniqueness, stale/two-person decisions, access, reload/reconnect, drafts, native stop/continuation, essential phone flows.

Use small, additive contracts and focused tests. Do not port prototype fake data/state into production controllers. Do not create an alternative decision write store. Chat-origin handoffs are distinct from task parent-child relationships.

## Ownership while implementing

- Personal preference: DB/shared/service/route/API/hook/Experimental settings and tests.
- Workspace presentation: shell/navigation, task/chat surfaces, reusable tokens and component stories.
- Decision integration: canonical cross-source history, Needs You presentation, exact target links and historical artifact viewing.
- Task handoff: accepted chat suggestions, safe standalone task creation, handoff lineage and canonical chat decision updates; immutable visual-review binding as required.
- Integration: isolated runtime, real data fixture, live native proof, browser checks, acceptance and remaining-limit report.

## Verification record

Maintain exact commands and results in the local evidence directory. Distinguish source/component checks, real API/browser persistence, and live provider work. No passing claim follows from a test merely existing.

Initial environment results:

- Git worktree creation: passed; exact baseline above.
- Dependencies: installed offline with pnpm 9.15.4 and frozen lockfile. System pnpm 11 was incompatible; pinned version used without changing the lockfile. Plugin SDK links prepared with the repository helper.
- Instance initialization: passed through `worktree init --empty`; separate config, database/storage paths, keys and ports.
- Startup and migrations: passed after running the embedded PostgreSQL package's own symlink hydration helper (offline dependency installation had skipped its postinstall). App is bound to loopback 3210, PostgreSQL to 55460, with fresh isolated storage and keys.
- Personal preference browser check: default OFF, ON, reload persists, OFF restores Classic, ON restores Coordinator. Live check used local-trusted `local-board`; per-user separation has service/route/DB coverage, not two live authenticated users yet.
- Full `pnpm -r typecheck`: passed. Full `pnpm build`: passed, with existing large-bundle/dynamic-import warnings. Whitespace, module-boundary, token and map structural checks passed. The complete repository run finished with failures; see the final verification record below.
- Focused service/UI checks cover exact revision reads, three decisions retained, private/company access, handoff idempotency, document/attachment review identity, canonical invalidation, motion, relative timestamps and Classic preference preservation. These are not live-provider evidence.
- Storybook catalog generation passed; production task-card and compact receipt components rendered in dark desktop and light 390px phone views without horizontal overflow. Story data is explicitly synthetic.
- Fresh native onboarding exposed a name-only placeholder bug. Fixed the wizard to defer runner selection until the provider is selected, preserving the same setup ID; 190 wizard and 3 native setup lifecycle tests passed.
- Scott completed the separate managed OpenAI sign-in in the isolated instance. The connection reports connected; existing terminal credentials were not imported. The native Chief of Staff completed onboarding and the bounded blog test, with the assisted recovery documented below.

Browser verification against the actual application and isolated PostgreSQL records:

- The clearly labelled fixture agent is paused and separate from the onboarding Chief of Staff. Its context comments do not enter the durable chat-delivery outbox. The fixture is not evidence of agent-generated work.
- COO-6 copy review, COO-7 channel question, and COO-8 document-based visual-brief review were resolved through the real UI. All three persisted in Recent Decisions, full history, and the originating conversation as compact receipts. The visual brief is a document, not a generated image.
- Search by task ID and grouping by task worked. History filtering to Answered returned the channel question. Revision entry removed Approve/Revise controls, and Cancel restored them.
- After copy approval, the fixture helper created document revision 2. Clicking the approval receipt still opened reviewed revision 1 and focused its original interaction in the task conversation.
- Work-product approval did not silently mark tasks done. Because the fixture agent was paused, the canonical feed correctly exposed separate stalled-review work. Coordinator now explains this state and reuses existing recovery actions. Marking the three disposable tasks done removed them from pending attention while retaining all three original decision receipts. Tasks → Needs attention and conversation task cards reflected those changes.
- At 390×844, compact chat receipts remained readable and their links opened the exact reviewed document in the mobile panel. Desktop receipt navigation opened only the requested document tab after default-tab correction. The initial description and durable messages use relative timestamps in Coordinator.
- The task panel picker did not offer Decision history. That panel remains exclusive to Needs You.
- Light and dark Needs You views were both checked and captured. The original dark preference was restored.
- Production components were also checked in Storybook; motion/reduced-motion and no-replay behavior have focused test coverage. OS-level reduced-motion browser emulation was not exercised. A live agent-generated suggestion was subsequently accepted in COO-10, creating COO-11 without navigating away from chat.

Final review corrections and limits:

- A scope-change regression now remounts task panel state before persistence when account/workspace/company/task changes. Forty-three panel tests include Classic → Coordinator → Classic changes in both desktop and mobile placements, retaining each saved tab set.
- Cross-task document reviews retain both identities: the originating task and interaction remain in the conversation URL, while `documentIssue` identifies the owner of the exact reviewed revision. Sidebar reads use that owner's protected endpoint and never substitute the origin task's cached document. Eighty-five focused UI cases and five history cases (including PostgreSQL integration) passed. This cross-task variant was automated-tested, not browser-tested.
- Coordinator direct creation now includes optional Success criteria. Nonempty criteria become a section in the existing canonical description; no new data store or required field was added. Draft restoration and unchanged Classic payload have 89 passing dialog tests. The live browser subsequently verified the optional field and both description/criteria draft restoration. The preview had retained an old Vite transform; a timestamp-only watcher refresh loaded the current module, with its content hash unchanged. The disposable draft was cleared without creating a task.
- Full repository typecheck and build passed; final server/UI typechecks and the final UI build also passed after the late fixes. Structural module, token, and map checks passed. The initial full command stopped after the failed server lane. All remaining required lanes/projects were subsequently executed through the supported stable runner. The aggregate remains failed; original failures and focused subsequent results are retained in `../evidence/coordinator-test-ledger.json`.

Local review evidence lives outside the checkout in `../evidence/`: `coordinator-fixtures.json`, the bounded seed/advance helper, and screenshots `coordinator-needs-you-receipts.png`, `coordinator-exact-review.png`, `coordinator-mobile-chat.png`, and `coordinator-mobile-approved-revision.png`.

### Launch and verification limits

Start this checkout with explicit `PORT=3210` as well as its isolated config:

```sh
PORT=3210 PAPERCLIP_TELEMETRY_DISABLED=1 PAPERCLIP_NO_BROWSER=true PAPERCLIP_OPEN_ON_LISTEN=false PAPERCLIP_UPDATE_CHECK=0 pnpm dev:once
```

Use the pinned pnpm 9.15.4 toolchain on this machine. The initial launch omitted `PORT`; the app honored config port 3210 but the development supervisor polled its default 3100. A restart request returned 202 while remaining pending. The owned process was subsequently relaunched with explicit port after checking that no provider login or agent work was active; the current backend is loaded and serving the new history routes.

That restart exposed a paused-agent recovery failure: replaying queued chat messages could throw an invocation conflict and prevent readiness. Delivery now defers non-invokable agents before queuing, handles the concurrent-pause conflict narrowly, and lets other conversations recover. Seven new database cases and the existing concurrent delivery/reset regression pass. The final restarted instance became ready. Initial fixture comments that would have been treated as pending delivery were removed through their owning services before re-creating the isolated fixture agent; no live agent run resulted.

Earlier managed OpenAI sign-in attempts ended without a connection; their precise exit cause was not exposed. Scott then completed the supplied device sign-in, and the isolated managed connection reported connected. The native Chief of Staff completed onboarding (COO-9) and ran the blog workflow below. Host CLI credentials were not imported. The backend was guardedly restarted at 00:37:25 UTC on October 27 after the required-review and native-tool-contract checks passed and active run count was zero. Readiness and no outstanding restart were verified.

Recent Decisions currently uses a 24-hour display window, still an adjustable experiment assumption; full history is retained. Project Recents are session-memory only, and the originating-chat task sidebar filters loaded pages with explicit pagination. Chat decision receipts currently follow durable direct chat handoffs (including all tasks in an accepted suggestion tree); independently created later descendants do not yet inherit that origin. Live native execution now has the qualified evidence below. Two-user concurrent decisions, hosted migration, stop/recovery, and destination-native channel draft preparation remain unqualified. X and LinkedIn copy is exportable inside the saved document; nothing was sent or published.

Scope limits: no production rollout, hosted qualification, publishing, bulk migration, automatic learning or autonomous trust promotion. CEO/CTO review the functional outcome before broader adoption. Per-destination draft support must be proved or labelled export-only.


### Live native blog test — October 26–27 UTC

- Managed OpenAI connection `250883b8-2fce-4435-8309-e5895d096844` reports connected; native Chief of Staff `43bc05f1-724e-4e10-a157-63158450e618` executed real provider work in the isolated company.
- Chat COO-10 clarified audience, desired outcome and supplied product facts through the existing question interaction. A saved plan and suggested task were accepted through the UI at 23:45:39 UTC. This atomically created COO-11, copied its plan, began native work, and retained the task card in chat.
- **First-run failure retained:** the native agent generated a 428-word blog, X/LinkedIn drafts and an original SVG source, but declared Done at 23:48:19 UTC without creating the explicitly requested quality review. The task had no structured review requirement; prose acceptance criteria did not enforce one. Do not count this as an unassisted successful journey.
- A normal task correction reopened work and produced a real per-item verdict request. At 23:51:58 UTC the test reviewer approved the unchanged SVG and requested a more concrete opening in the copy. The agent produced a new 420-word copy revision, synchronized the downloadable Markdown, and requested approval of exact document revision 2 (`5ffcbfb7-2197-4138-bade-b642186089ef`).
- Approval through the task UI persisted at 23:58:21 UTC. Native work then completed COO-11 at 23:58:45 UTC. Needs You and the originating chat both show the compact approval receipt. Clicking the Needs You receipt opened the exact revision in the right panel and the original interaction in the task conversation. These are disposable test verdicts, not Scott's creative or publishing approval.
- **Additional observed failure:** the coordinator independently requested duplicate reviews of the completed work. The first duplicate was cancelled through the supported skip action with a superseded reason. The second duplicate was also skipped with an explicit reason. Completion delivery now includes existing canonical review references and guidance to reuse them; this guidance is not a hard prohibition against duplicate requests. No history was deleted.
- The SVG is a registered downloadable source attachment. Native rasterization failed; the parent rendered the unchanged SVG with the repository's Sharp dependency for visual inspection. This proves the source is usable, not native image-preview generation. The source has no scripts/external references. The initial final message used local paths; the corrected final response links registered downloads.
- Review details in Coordinator confirmation cards now start collapsed, while the prompt, exact-item link and actions stay visible. Seventy-seven focused resolver tests and UI typecheck/token checks pass; live visual confirmation of that new disclosure remains pending.
- Required human quality review is now an optional typed execution contract tied to named outputs and exact document/attachment targets. The authoritative completion path rejects Done until the bound outputs are approved. Existing tasks without this requirement retain their behavior. The initial gate passed 218 focused tests; the subsequent native-tool contract fix passed 75 server and 32 runner tests, server typecheck and runner TypeScript build. This does not guarantee an agent will infer structured requirements from arbitrary prose.

Evidence: `../evidence/coordinator-live-blog-{task,interactions,comments}.json`, `coordinator-live-chat-{task,interactions,comments}.json`, `coordinator-live-task-suggestion.jpg`, `coordinator-direct-task-draft.jpg`, `coordinator-live-svg-render.png`, and `coordinator-live-revision-review.jpg`.

The long-running full test command was started before several late edits. It has recorded two workspace-runtime fixture failures (host Git default branch), one Muse fixture cleanup failure (Python 3.9), and two history projection failures. A fresh focused history run passed all five cases against temporary PostgreSQL; the first failures remain saved, with the stale pre-edit transform as the evidence-supported explanation. The broad command ended with its server lane: 1,152 files passed, 8 skipped, 3 failed; 24,845 tests passed, 130 skipped, 5 failed. Later UI/package and serialized groups were run separately through the supported stable runner and are now complete. Do not report the full suite as passed.


Late verification notes:
- The general UI lane ran 803 files: 802 passed and IssueDetail failed 29 of 157 tests because its existing fixture never resolved the newly added personal-preference read. The fixture now explicitly supplies the Classic loaded/off state, with added loading and Coordinator-to-Classic scope checks. A fresh focused run passes all 159 cases; production identity/loading behavior was unchanged. Preserve `/tmp/coordinator-issuedetail-focused-before.json` and `-after.json`. CLI and remaining package/serialized lanes subsequently finished; exact results are in the ledger.
- Attachment quality review binds immutable attachment/asset/hash identity. Deletion or identity mismatch invalidates it. Adding a new attachment alongside the approved one does not automatically declare it a replacement for that output slot. A revised visual requires a new bound review. Do not describe this as automatic attachment-version supersession.


### Final repository verification — October 27 UTC

- Every required lane/project executed. Across original invocations: 2,558 files passed, 10 skipped, 9 failed; 43,546 tests passed, 158 skipped, 40 failed. This is **not** a clean full-suite result.
- The 29 IssueDetail fixture failures were corrected without changing production loading behavior; fresh 159/159 pass. Two history failures from the earlier long-lived transform pass on a fresh isolated five-case run. Original failures remain recorded.
- Exact-name isolated retries passed for the heartbeat timeout and routines socket failure; their original causes are unconfirmed. The OpenCode mismatch persists and is explained by inherited PAPERCLIP_ADAPTER_MODELS taking precedence over the test's discovery mock in unchanged source.
- Other remaining environment failures: two Git default-branch fixture failures, one Python 3.9 Muse cleanup failure, and three Hermes failures because the host Python is below its >=3.10 prerequisite. No unrelated source or global environment changes were made to force a green run.
- Full repository typecheck and build passed before the final native-tool contract edit. After that narrow edit, server typecheck, runner TypeScript build and 107 focused server/runner tests passed. Structural and final diff checks are recorded alongside the evidence.
- Source of truth: `../evidence/coordinator-test-ledger.json`, which preserves first failures and subsequent verification separately.


### Required-review live follow-up — complete, with recovery retained

COO-12 was suggested in the ongoing Chief of Staff chat and accepted through the real UI with `requiredQualityReview(copy)` persisted atomically. The native agent saved a 137-word task document. An attempted Done write before approval returned `422 required_quality_review_incomplete` and left the task in review.

Its first review attempt exposed a native tool contract mismatch: the guidance requested `resolverPolicy`, but the advertised schema rejected it and the authority did not forward it. The log retained two schema-denied calls, then a successful unbound confirmation. Exact denied arguments were not retained, so attributing both errors solely to that field is an inference. The unbound request was skipped with an explicit reason; no history was removed. After the schema/authority/guidance correction and guarded restart, normal task feedback resumed the native agent. It created a human-only confirmation tied to quality key `copy`, its requirement fingerprint, and document revision `5f90ffa3-6b94-4d25-8475-c7d298f621e8`, without editing the copy.

Needs You opened that exact revision and the corresponding conversation interaction. A disposable test approval through Needs You persisted at **00:41:03 UTC**. Native continuation completed COO-12 at **00:41:40 UTC**. The approval appeared in originating chat, and the coordinator's completion notification at **00:42:20 UTC** linked the existing approval without creating a duplicate. Both task and chat had no pending interactions or active run at the final checkpoint. This is a successful recovered native path, not an untouched first-attempt success.

Final review links:
- Chat: http://127.0.0.1:3210/COO/chats/chief-of-staff
- Blog package: http://127.0.0.1:3210/COO/issues/COO-11
- Enforced-review follow-up: http://127.0.0.1:3210/COO/issues/COO-12
- Needs You: http://127.0.0.1:3210/COO/decisions

Proof screenshot: `../evidence/coordinator-live-required-review-approved.png`. The feature remains personal/default-off under Settings → Experimental; this isolated review user has enabled it. No commit, PR, push, merge, production deployment, external publication or original-checkout modification was performed.

Next gate: Scott and CEO/CTO review this functional isolated experience. Subsequent work should prioritize reliability and the still-unqualified cases above before broad rollout; sales/support workflow qualification and hosted/multiplayer qualification remain later stages.

### Design Proposals sidebar and task-list styling — October 27

Scott requested the Storybook Design Proposals styling while retaining the Coordinator IA. CoordinatorSidebar now composes the shared sidebar recipes, section label, scrolling and truncation behavior. Chat, Tasks, Needs You, More and mixed Recents remain in place. CoordinatorTasks adapts real records to the reviewed TaskList and TaskListToolbar; task detail links retain their originating view. Needs attention hydrates the distinct task IDs from the same canonical decision feed as Needs You, including tasks outside the first list page, rather than inferring attention from status. The all-task view pages in batches of 200 and explicitly offers Load more; local filters cover loaded records, while search also queries the server. No global proposal theme was enabled and the experimental/classic routing gate is unchanged.

Source additions: `ui/src/pages/CoordinatorTasks.tsx`, its focused test, and `ui/storybook/stories/design-proposals/coordinator-tasks.stories.tsx`. Shared changes are limited to controlled collection inputs, optional view choices and task-link navigation state. The new Storybook example mounts the real sidebar and task-list adapter with synthetic read-only APIs; its desktop shell, mutations and destination pages are not production integration proof.

Verification: UI typecheck/build passed; 21 focused UI tests passed; Storybook catalog structure check and 30 catalog/map tests passed; token and module-boundary gates passed; `git diff --check` passed. Browser checks covered the running dark workspace, server-backed search, real task-detail navigation and return, More navigation, empty attention view, light Storybook pending-decision rows, and responsive layout. Mobile inspection caught a clipped empty state inside the horizontal table, corrected by rendering it outside the table. Pending decision cache updates and hydration failures were exercised in tests; no live decisions or agent work were triggered in this styling pass. Build emitted existing large-chunk/dynamic-import warnings. The full repository suite was not rerun and its earlier qualifications remain above.

Review app: `http://127.0.0.1:3210/COO/issues`. Storybook: `http://127.0.0.1:6107/?path=/story/coordinator-tasks-design--all-tasks`. Visual evidence: `../evidence/coordinator-proposal-styling.png`. This remains an isolated, uncommitted functional experiment awaiting design review.


### Composer, chat-card and attention refinements — October 27

Scott requested a lighter New Task composer, explicit suggested-task actions, compact plan links, pending chat questions in Needs You, and created task cards after the complete creating reply. Changes stay behind the existing Coordinator presentation gate.

- Coordinator direct creation now says **New Task**; optional success criteria uses a transparent, borderless input with its accessible label and keyboard focus retained. Regular task details already render the assignee and model/effort controls; verified both in the running COO-14 detail. Standing chats continue to use the header agent switcher.
- Suggested cards say **Suggested Task**, with **Reject**, **Revise…**, and primary **Create**. Revise reveals a required feedback field with Cancel/Request revision; Cancel restores the original actions. Creation retains the existing morph/light treatment. Single-task suggestions omit the redundant selection count; multi-task selection remains supported.
- Saved plan cards use a compact Open plan link with the title and owning task/revision destination, without a content excerpt. Unsaved live plans stay compact and do not fabricate a destination. Classic plan previews are preserved.
- Canonical pending-interaction attention now admits visible standing-chat containers. The previous execution-only summary filter dropped their questions. Permission, addressee, resolver, dismissal, and execution/review queue behavior remain enforced. Ordinary user text does not itself become a decision; structured agent requests do. The latest two UI/UX requests in COO-10 were already answered during inspection, so there was no live pending example to resolve.
- Created task cards use persisted origin-run provenance to follow the creating run’s complete reply, including steering segments and a live tail. Accepted suggestions retain their original slot. Missing older provenance keeps chronological fallback; no timestamp-based ownership guess or migration was added.

Verification: 192 composer/dialog tests; 11 compact-plan/commitment tests; 9 focused ordering/handoff UI tests and 302 existing thread/motion tests; 144 backend handoff/interaction tests; 38 attention/history tests; and 3 Needs You UI tests passed. UI/server typechecks, UI build, token/module-boundary/map checks and 20 catalog tests passed. Browser verification covered the live New Task label and transparent criteria input, regular task controls, a compact plan opening its sidebar, and COO-16’s created card appearing after its final creating reply. Storybook used actual components with local fixtures for Reject/Revise/Cancel/Create, light/dark, and phone layouts; no live task, question, or verdict was created by this pass. Backend reload completed at 16:54:55 UTC with zero active runs and readiness confirmed. Full repository tests and a fresh provider-run journey were not rerun; earlier qualifications above still apply.

Review: http://127.0.0.1:3210/COO/chats/chief-of-staff and http://127.0.0.1:6107/?path=/story/coordinator-task-commitment--dark . This remains an isolated, uncommitted experiment; no publishing or production rollout.

## 2026-10-27 — Description-only creation and shared task clarification

Scott removed the separate success-criteria input from the intended creation flow. New Task now needs only the description. Existing saved criteria are folded into the editable description on draft restoration so prior input is not lost. Native ordinary-task context instructs the assigned agent to inspect existing context, ask one material missing question in the task through canonical `request_human_input`, reuse pending/answered context, and resume via `wake_assignee`. Clear tasks proceed directly; this is agent guidance, not a deterministic semantic validator.

Canonical pending task questions now appear as answerable cards in the associated standing agent chat, with a short task-context sentence and an exact interaction link. Current-generation handoffs and caller-created ordinary tasks assigned to that chat’s agent are eligible; questions already in the chat are not duplicated. Read authorization and canonical attention audience/dismissal rules apply. Direct-task pending questions survive a chat reset; recorded answers start at the current chat boundary. Handoff history retains its prior session semantics. No question is copied into description text or a second interaction record.

Needs You desktop and phone badges use the complete pending feed’s `totalCount`. Classic retains its existing today-based semantics. The prior desktop count used `deskBadgeCount`, while mobile had no Coordinator badge. Both now share the Needs You cache; resolution and access/triage events invalidate projections. The sidebar’s minute timer was removed; focus and live events drive refreshes.

The highlighted runner progress paragraph had `text-sm` in JSX but was overridden by Coordinator’s 17px desktop / 16px phone body rule. A scoped progress override now uses `--text-sm` and `--text-sm--line-height`; browser computed values are 14px and 20px. Final answers and human messages retain their selected type scale.

Verification: 206 focused UI tests passed, plus 99 live-update tests after the triage-event addition and the phone badge test. Backend agent reported 45 PostgreSQL/OpenAPI cases and 15 task-markdown cases passed; UI/server typechecks, UI build, token/module/map checks and 30 catalog/map tests passed. The browser confirmed desktop badge, 14px progress text, and removal of the separate criteria input; existing saved draft text was preserved. The Storybook question fixture mounts the real query/resolver and verifies answer submission/removal without touching live task decisions. The backend restarted with zero active runs; `/api/health` is ready with no pending restart. A fresh provider-generated vague-task/question/answer/resume journey was not run, so model adherence remains unverified.

Operational limits: pending chat projection currently reads one complete authorized company attention snapshot when eligible tasks exist (including that owner’s existing bookkeeping). It has no polling loop. Receipt projection merges two bounded canonical history queries. No schema changes, publication, merge or production rollout occurred in this refinement.

### Live clarification acceptance trial — October 27, 18:25–18:29 UTC

After Scott explicitly approved creating and answering a bounded test task, COO-17 (Acceptance trial — pilot welcome draft) was created in Coordinator Lab for the existing native Chief of Staff. Its description requested a two-sentence draft but omitted the audience and next action. The existing managed connection was reused; the paused fixture agent and unrelated pending proposal were left intact.

- The agent inspected the task and requested the audience through one canonical human-only question, `126c8260-eff6-4b00-ac46-12ba63598a19`, with `wake_assignee`. The task entered In Review and the initial native run ended successfully while waiting.
- The identical interaction ID appeared in the task interactions endpoint, canonical attention feed, and standing chat pending-question projection. Browser inspection confirmed answerable cards in task detail, Needs You, and Chief of Staff chat. Needs You showed 2, comprising the new question and one unrelated pre-existing proposal.
- One answer was submitted through the chat card at **18:28:54.550 UTC**. Test data supplied both the audience (busy operations leads in a private team pilot) and next action (create one small task for the existing agent by Friday). All three already-open browser surfaces updated without reload: the question became an Answers recorded receipt, task detail displayed the answer, and the Needs You badge returned to 1. The unrelated proposal remained pending.
- Native continuation `8fd00336-e884-4c40-bd91-3a1a2a483608` began at **18:28:54.683 UTC** and succeeded. The agent recognized both inputs, saved document `pilot-welcome-draft` revision 1, and completed COO-17 at **18:29:27.938 UTC**. The saved body contains exactly two sentences and the agreed Friday action. The document was opened in the task sidebar. Nothing was published.
- Final canonical evidence contains exactly one question, one interaction-created event, and one answered event; no pending task question or live company run remained. The standing chat projection no longer contained the pending question and retained its compact answer receipt.

Qualification retained: the initial native run reported a question payload validation failure, corrected the schema itself, then created the single canonical question. This is a successful end-to-end trial with automatic recovery, not a clean first-tool-call result. No manual agent recovery or implementation fix was needed. This one local-trusted/native-agent scenario does not establish reliability across all models, authenticated users, hosted environments, or concurrent responses. The previously recorded full-suite failures remain unchanged; no suite rerun was needed for this evidence-only follow-up.

Review: http://127.0.0.1:3210/COO/issues/COO-17#document-pilot-welcome-draft . Evidence: `../evidence/clarification-trial/` includes the saved creation request, canonical before/after snapshots, run records, activity/comments, draft revision, browser snapshots, and pending/completed screenshots. This closes the fresh live-clarification gap above while preserving the broader experimental review and rollout limits.

### Chat typography, answer surfaces and pinned navigation — October 27

Scott requested `text-sm` for chat bubbles, answer-field backgrounds matching the composer, and pinnable More… destinations. Coordinator conversation text now uses `--text-sm` and its line-height on desktop and phone; this supersedes the larger final/human-message scale recorded above. Question answer inputs use the same card/light and muted/dark surface tokens as the main composer. Classic rendering retains its existing styles.

More… uses the shared Flyout with separate navigation links and accessible pin buttons. Pinned pages appear in pinning order between More… and Recents; they can be unpinned from either location. The browser-local preference belongs to the current user, across companies, and stores only route names. It does not sync across devices. `usePinnedNavigation` owns storage and cross-tab notifications; the sidebar registry filters unknown destinations. No new server/API or agent execution behavior was added.

Verification: 38 focused sidebar, bubble and question-form tests passed, plus UI typecheck/build, token gates, map structure and diff checks. The live TES-1 browser showed final/human/progress text at 14px and answer/composer backgrounds both `rgb(42, 42, 40)`. Keyboard pinning, reload persistence, pinned navigation and unpinning from both surfaces passed. The 390×844 phone drawer fit all More… controls. Temporary Projects/Agents pins were removed after verification. Screenshot: `../evidence/coordinator-pinned-navigation.png`. Two authenticated users, cross-device persistence and light-mode visual inspection were not exercised; account isolation and cross-tab updates have component coverage.

### Decision resolution motion — October 27

Scott requested the task-card resize and Gather Light treatment when a decision is resolved through its CTA. Needs You now retains the resolving card until canonical history confirms the result, then runs the same shared `CoordinatorTaskMotion` geometry transition and contained light simultaneously. The full form size is captured before the CTA starts saving so independent resolver/history refreshes do not turn an interim empty layout into the starting shape. After the 1.4-second light treatment, the compact receipt settles into Recent Decisions. Failed saves keep the form actionable; cancellation/expiry and reduced motion settle without the effect. Revisiting a resolved card does not replay it. The task-detail composer takeover and chat receipt presentation are unchanged in this pass.

The shared component remains presentation-only; no new decision authority, mutation, or history record is created by the animation. Existing task suggestion/creation motion keeps its timing and clipping. `coordinator-decision-motion.stories.tsx` mounts the real Needs You and resolver components with isolated confirmation/question/failure responses, with light, dark and phone examples.

Verification: 10 focused Needs You/card-motion tests passed, UI typecheck and build passed, and token/module-boundary gates passed. Browser checks covered approval and answer transitions, simultaneous changing geometry and Gather Light, clipping within the border, both retained receipts, phone/light layout, and a failed save retaining the form without an effect or receipt. Reduced-motion settlement and no replay on return have automated coverage. No real decision was resolved or agent continuation triggered in this pass; full-repository and hosted/multiuser qualification remain outside this animation change. The legacy `check-task-chat-motion.mjs` command could not execute because it references the already-absent `TaskChatRedesignGate.tsx`; the token gate passed. Build emitted its existing chunk-size/dynamic-import warnings.

Review: http://127.0.0.1:6107/?path=/story/coordinator-decision-motion--dark . Approve or answer a fixture to try the motion; reload resets it. Visual evidence: `../evidence/coordinator-decision-gather-light.png`. The functional app on port 3210 includes the change through Vite HMR; the experiment remains default-off and uncommitted.

### Chat model controls and Storybook organization — October 27

Scott requested the decision-motion suite under Design proposals and model/thinking controls in the standing-chat composer. The story now lives at `ui/storybook/stories/design-proposals/coordinator-decision-motion.stories.tsx`, under **Design proposals / Components / Coordinator decision motion**. Its stable ID and review URLs are unchanged. Catalog metadata identifies experimental design review while retaining production components, fixture boundaries, and the canonical decision capability reference.

Coordinator chat now exposes the shared model/effort picker for supported agents, with a fixed agent identity. Agent switching remains in the header. Ordinary task composers keep their existing assignee/model controls, and Classic chat keeps its prior presentation. Desktop uses the existing popover; phone uses its existing dialog. Provider catalogs, supported thinking levels, defaults, and reset behavior reuse the shared picker.

On send, the conversation container is ensured first (including the first-ever message), the selected settings are saved in its existing `assigneeAdapterOverrides`, and the message is then admitted through the existing ordered/idempotent comments endpoint with its client request ID. Conversation messages cannot use the task PATCH-with-comment path. The agent configuration is untouched. These are separate writes: failure to save settings prevents message submission, while a later message failure can leave the preferences saved. Existing running work is not retroactively reconfigured; no per-message atomic settings snapshot is claimed.

Verification: 299 focused picker/composer/task-detail tests passed. UI typecheck and build, token/module-boundary gates, catalog generation and diff checks passed. Browser verification confirmed the model catalog and effort control in the live Chief of Staff chat, the fixed agent identity, the 390×844 phone dialog, and the moved Storybook navigation. No model selection was persisted, chat message sent, or provider run launched during browser verification; provider execution remains untested for this change. The build retained its existing chunk-size/dynamic-import warnings. The unrelated legacy motion checker limitation from the preceding entry remains unchanged.

Review: http://127.0.0.1:3210/COO/chats/chief-of-staff and http://127.0.0.1:6107/?path=/story/coordinator-decision-motion--dark . Screenshot: `../evidence/coordinator-chat-model-selector.png`. The experimental implementation remains isolated and uncommitted.


### Chat task assignment default — October 27

Scott requested new tasks from chat to default to the current conversation agent, unless the user explicitly specifies a different agent or person. Chat and suggestion guidance now states that policy, including that “for me” alone is not a human assignment. No best-fit routing is added.

Accepted suggestions resolve missing/null ownership to the source conversation agent. The route authorizes the same effective assignment before the interaction service creates the task atomically, so the default cannot bypass assignment permission. Direct raw REST creation derives the fallback only from the caller's verified same-company, same-agent run-bound conversation; ordinary task creation outside chat retains its prior behavior. Native creation already defaults to the current agent. The MCP helper preserves explicit human ownership as well as alternate agents. Normal assignment, visibility and company checks remain in place. Existing tasks and pending suggestions with an explicit assignee are not rewritten.

Verification: 182 focused persisted-handoff, native/MCP/REST and interaction-route tests passed. Coverage includes omitted/null ownership, explicit agent/person overrides, non-chat behavior, default assignment denial, selected-task authorization, atomic handoff and existing containment checks. Initial test execution was blocked by sandbox local-port restrictions; the approved rerun used disposable PostgreSQL/HTTP test servers. Three new test fixtures initially reused titles and exercised deduplication; unique titles corrected the fixtures and all checks passed. Server typecheck, module boundaries, map checks, Storybook catalog and diff checks passed. No live model trial or new user task was run; instruction-following with an explicitly supplied model-generated assignee remains a model behavior, while missing-owner defaults are enforced in code.

The isolated development server was ready with zero active runs before requesting its guarded hot restart. Readiness was confirmed afterward at 22:54:57 UTC, with no remaining backend changes or pending migrations and zero active runs. No production, credentials, deployment or existing task ownership changes.


### Task title typography — October 27

Removed the Coordinator-only display-heading size override (34px desktop, 28px narrow screens). Display and edit modes now share the existing `text-2xl` (24px), normal-weight, leading-normal classes from the task title's InlineEditor. Removed the unused title-size/leading custom properties. Browser verification on COO-19 confirmed both modes at 24px with 36px line height after rebuilding/reloading; editing was cancelled without changing task content. UI build, forbidden-token gate and diff checks passed. The first token check used an absent script filename; the existing `check-forbidden-tokens.mjs` gate subsequently passed. Build retained existing chunk-size warnings.


### Floating composer background — October 27

Removed the Coordinator composer's rectangular background/backdrop and extended desktop history behind the floating dock. Only the rounded composer and its accessory surfaces cover history. Transparent dock space passes pointer input through. The dock measures its own height with ResizeObserver, scoped to Coordinator, so transcript bottom padding and the scroll-to-latest control accommodate multiline input and question takeovers. Mobile retains its existing sticky layout with a transparent surrounding dock; Classic retains its previous layout.

Verification: 313 existing thread/scroller tests, UI typecheck/build, token and module gates, and diff checks passed. Browser inspection confirmed a transparent dock, transcript viewport extending to the dock bottom, and measured 140px bottom padding for a 124px composer; history scrolling and the floating composer were inspected in the live standing chat. Phone, light-mode visual inspection and dynamic takeover resizing were not separately exercised in this pass. Build retained chunk-size warnings; jsdom reported its existing unimplemented window.scrollTo notices. No messages or task content were changed.


### Chat card copy, answer navigation and surface colors — October 27

Plan cards now read “Open [document title] in the sidebar”; live unsaved cards read “Writing [title]”. Coordinator human chat bubbles use the task-description `--liveness-blue` token with white foreground. The account/feedback footer uses the same primary-sidebar background token as Coordinator navigation in both themes.

Local answered-interaction receipts anchor directly to their canonical response-comment bubble, prevent route navigation when the answer is mounted, and disable task quicklook. Cross-task decision receipts retain the source-task link and exact decision context. No interaction records or permissions changed.

Verification: the four relevant suites passed across focused runs (344 tests including the new local-answer navigation case). The initial plan test still expected old live-card copy and was updated; subsequent focused runs passed. UI typecheck/build, token/module checks and diff checks passed. Browser checks confirmed blue/white chat bubbles, identical dark sidebar/footer computed backgrounds, the simplified plan text, existing cross-task answer links, and a local receipt click keeping the standing-chat URL unchanged while jumping to its answer. Light-mode visual inspection and phone behavior were not separately exercised. Build retained chunk-size warnings. No user messages or decisions were submitted.

### More flyout and Needs You ordering — October 27

The primary label is “More”. Its flyout uses a shared hover surface across each destination and pin action, with the pin overlaid at the row's right edge like the Tasks/New task pair. Opening the flyout focuses its container, leaving Search unhighlighted and its pin hidden until interaction. Keyboard users can still focus the pin. Needs You now applies its sort, group, search, agent and project controls to visible recent receipts as well as pending decisions; project choices include projects found only in recent receipts. Filtered empty copy distinguishes no matches from being caught up.

Verification: 11 focused Coordinator sidebar/Needs You tests passed, including recent receipt reordering, grouping and filtering. UI typecheck and build passed. In the rebuilt local app the More flyout opened with transparent Search background and zero pin opacity, and changing sort from newest to oldest visibly reordered the recent receipts. The original sort and filter were restored after verification. No decision was submitted.

### Question validation and document context — October 27

Canonical QuestionForm owns attempt-based validation: typing and restored drafts do not display field errors until Next/Submit or keyboard submission is attempted. Invalid answers stay unsent, and correction clears the warning. Busy/upload guards, draft persistence, optional skip, and browsing pagination remain intact. This shared form behavior applies to all its consumers.

Coordinator's saved plan belongs to document chronology rather than inferred run-write placement. BOB-2's plan was saved at 03:52:42Z and its concept output at 03:53:12Z; the previous last-write/fallback embedding misplaced the earlier plan after the output. The UI now shows the saved plan before that output. Classic embedding is unchanged. No canonical documents or descriptions were rewritten or removed.

The shell resolves standing-chat references once from the existing person/company-scoped chat list and roster. Markdown displays those references as “Chat with [agent]”, routes to the chat, and preserves anchors instead of exposing task IDs/status previews. Markdown document links share SidebarDocumentLink with compact plan cards, retain their exact revision/annotation href, and keep inaccessible-task handling. These presentation changes are Coordinator-only; execution and authorization remain with their existing owners.

Verification: 265 focused question/composer/thread/Markdown tests passed, followed by 18 link/card checks including one additional inaccessible-document regression after review. UI typecheck, build, token/module-boundary gates, map checks, and diff checks passed. Browser checks in the rebuilt local app confirmed BOB-2 plan-before-output order, TES-2 labels/navigation to CTD chat, and the compact recommendations link opening the Skill Recommendations sidebar tab. Validation was exercised in component/integration tests; no live user answer was submitted or agent run triggered. Full-repository and hosted/multiuser qualification were not run. Existing build warnings remain.

Proposed redundancy policy, awaiting design direction: a complete task brief can stand alone for simple work; show a separate plan when it adds approach, dependencies, checkpoints, or verification. If a saved plan remains necessary internally, it can stay accessible from the sidebar without repeating the brief in chat. For plan-heavy work, use a short introductory message linking the canonical plan. This pass only fixes ordering and presentation.
