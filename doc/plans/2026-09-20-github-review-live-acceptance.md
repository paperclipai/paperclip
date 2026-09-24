# GitHub review bot live acceptance — 2026-09-20

The user authorized unattended testing on the disposable private repository,
including a Storybook bot whose review fails unless a rendered story page says
`oogabooga`. Continue from the approved implementation; do not pause for another
design approval. Use the embedded browser for user journeys and real signed
GitHub deliveries with actual Paperclip agent runs for execution evidence.

## User stories and acceptance

1. As a member, I connect my own GitHub identity and confirm it. My requests
   identify me as the responsible person; the agent uses the bot App's governed
   tools, never my credentials for review publication.
2. I mention the bot on an issue. A real task/run is assigned to its permanent
   agent and a reply appears on GitHub. A second mention continues the task.
3. I open a PR containing a known defect. The configured event starts a normal
   task/run, publishes a justified finding and summary, and fails Paperclip Review
   on the exact head commit. I can follow links to the task and run.
4. I ask for another review by mentioning the bot again. A new run reassesses the
   current commit without creating another root conversation/task or duplicate
   inline findings. Ordinary discussion does not change the rating.
5. I push a fix with updated-commit reviews enabled. A new assessment passes and
   supersedes the old result, preserving review history.
6. I select mentions-only, or disable updated-commit events. A push does not run
   an automatic review or inherit a passing check from an older commit. An
   authorized mention still starts a review. Re-enabling the event restores
   automatic review on the next push.
7. I configure a Storybook bot with trusted instructions to generate/build
   Storybook from the PR's page components and inspect rendered story pages.
   Source comments, PR prose, story names, or instructions mentioning `oogabooga`
   are not evidence; the text must be visible in a rendered page. If absent the
   structured assessment is complete but fails; if present it passes. A build or
   verification failure is incomplete and cannot pass.
8. For that bot, absent → present → absent commits produce failing → passing →
   failing checks. Repeat mentions also recheck the PR. Generated Storybook and
   page inspection evidence are attached to the underlying task/run.
9. Draft filters, prompt changes, repository restrictions, tool denials,
   duplicate delivery, rapid pushes, stale publication, retries, and guest
   restrictions preserve their configured authority and exact-head semantics.
10. Formal approval/request-changes is rejected while disabled and accepted
    through the governed tool only when explicitly enabled; scoring 5/5 alone
    never approves a PR. Required checks are enforced on the disposable repo.
11. After local qualification, deploy matching application/migrator and Cloud
    gateway revisions to a dedicated staging tenant, and repeat the real signed
    webhook and agent workflow through its vanity hostname.

## Evidence rules

Record actual source revisions, heads, delivery IDs, task/run IDs and links to
comments, reviews, checks, and generated stories. Distinguish real runs from
fixtures and deterministic tests. Never publish a result manually and count it
as an agent run. Keep failures and repairs in the log; do not infer a live pass
from unit tests or setup verification. No production rollout or merge.

## Journey log

- Embedded browser refreshed successfully; form controls respond again.
- Existing personal GitHub flow entered from the catalog. Access limited to the
  QA agent. Approved the isolated QA instance's normal Cloud connector enrollment;
  the preserved flow resumed the GitHub sign-in step.

## Live results: basic channel and initial PR (September 20)

- Existing personal GitHub OAuth enrollment and explicit identity confirmation succeeded in the embedded browser. Linked `cryppadotta` (`34892728`) to QA member `github-review-qa-member`. Removed the personal connection's agent installation/profile binding afterward; the agent retains only the bot App GitHub tools.
- Issue [#1](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/issues/1) created ordinary task `GIT-1` (`4c5719a2-b6bd-48d7-8569-458bf46b940f`) with the assigned agent and responsible user. Initial QA model `gpt-5.4` was unsupported by the signed-in Codex account; changed the fixture agent to available `gpt-5.6-sol` through the normal agent API.
- Mention run `0ba64bf7-b186-402e-8b4a-6c4f8c37212b` succeeded and published [basic acknowledgment](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/issues/1#issuecomment-5749595583). A subsequent mention after completion ran `6005793d-73df-4ed1-986f-eea2a4eea823` on the same task.
- Opened private [PR #2](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/2) through the embedded browser. Its `opened` webhook created `GIT-2` (`5d9e3779-d003-4937-a329-cd262b4e835f`), run `fc039950-2c34-4611-9f44-0326836a7e7e`, review projection `d4542409-aed4-4051-be60-af725f8575f0`, and [Paperclip Review check](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/runs/106073096927) for exact head `76028b764e77f2491c66944a75302febebbd3bfb`.
- The agent discovered/invoked bot `read_pull_request`, `read_file`, `submit_review`, and `comment`. It independently found the seeded percentage conversion bug, scored it 3/5, and documented test limitations honestly. **Structured publication failed:** coverage listed unchanged context files; on retry, a limitation exceeded the undisclosed 256-character bound. The check correctly ended `action_required`, never passed. Plain comments do not count as successful review publication.
- Fixed tool discovery to derive the submission schema from the shared input validator, expose all bounds, document changed-file coverage, and instruct correction/retry. Invalid inputs now return actionable 400 errors and mismatched heads return 409 instead of 500. Focused policy tests: 12 passed. Server typecheck passed.
- Restarted the isolated server and saved configuration revision 3 to refresh tool discovery. Posted [retry mention](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/2#issuecomment-5749639940) via `gh` after embedded-browser form actions repeatedly left an unsent draft. Browser inspections still work; this specific submission is API-driven and is not claimed as a successful browser submit.

- Retry run `c4bdc719-b52e-42c2-b21a-1bef1bbec39c` completed with 3/5, [inline finding](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/2#discussion_r4056882860), and [current summary](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/2#issuecomment-5749646422). The original check became `failure`; no manual root publication was used.
- Pushed fix `fc6e96576054cfa321339c155148845eb43662b4` with a fractional percentage test (four local Node tests passed). A real `synchronize` webhook started run `e42299e4-8860-4223-9a10-8337eaf043d8` on GIT-2. Agent independently confirmed the fix and submitted 5/5; [new-head check](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/runs/106074255014) passed. Summary comment ID stayed `5749646422`. Review history and task/run links were browser-inspected.
- [Formal-approval permission probe](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/2#issuecomment-5749656024), run `eb5affe8-19ac-4846-9c1a-6c80f85476a9`, invoked `formal_review(APPROVE)` and received HTTP 403: disabled. No formal review was posted. **Found another bug:** metadata reads created an assessment and eventually overwrote the passing check with incomplete. Fixed metadata reads to be read-only; added explicit governed `begin_review` for requested assessments. Focused task-routing/publication integration tests (two) and server typecheck passed. Retest pending.
- Browser inspection found automatic tasks titled with internal prompt text and synthetic comment anchors. Fixed new automatic task titles to `PR #N: <title>` and the external link to the root PR. Covered both in the signed-webhook integration test.
- GitHub branch-protection API returned 403: private repository requires a GitHub Pro upgrade or public visibility. Did not change billing or expose the fixture. Required-check merge enforcement remains externally blocked on this account/repository; check publication and results remain testable.

## Storybook gate and recovery qualification

- A repeat disabled-approval probe (`2af76e3a-5d3f-44c9-8c86-f87b19af3042`) was denied with HTTP 403 while PR #2's passing check remained 5/5. The read-only discussion regression is fixed.
- Opened [PR #3](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/3) with pinned Storybook/React/Vite/Playwright and two page components. Under `mentions_only`, opening the PR created a manual-required check and no task/run. A mention created GIT-3 (`7719d76d-87ae-4649-8714-3470f49424f3`).
- Initial runs generated/imported both page stories and built Storybook but stalled extracting Chromium under host Node 26. Installed the same pinned browser using Node 22 and supplied those runtime paths through trusted bot configuration revision 6. No review result was manufactured.
- Server restart exposed an existing local-runtime recovery defect: an interrupted local bookkeeping lease was sent to unsupported sandbox teardown, blocking saved mentions forever. Added local cleanup with an explicit no-provider-resource guard. The real sweep integration suite passed all 15 tests, including deleted-environment recovery and refusal of unexpected provider resources. The existing queued mention resumed automatically at 12:56:40Z after normal cleanup; no DB repair or fabricated run was used.
- Run `6aefa05e-7e44-4abd-81d9-418394a6471d` succeeded. It verified exact Git blob hashes, built the generated Storybook, rendered both actual story IDs with Chromium, captured screenshots and visible DOM text, and submitted a complete 3/5 assessment. [Check](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/runs/106074910998) failed for exact head `0e416da6501b22b2ce506cc9961bb1a9b49b17e9`; [summary](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/3#issuecomment-5749958627) explains the missing visible word. The source comment containing `oogabooga` did not count.
- Agent uploaded evidence attachment `db37d237-dec3-49bc-bc0c-e7ebec03f684` and artifact work product `2521af19-8692-42d4-9070-603707113e38` on GIT-3. It includes generated stories/config, inspector, source hashes, JSON evidence, and screenshots. Both pages returned HTTP 200 with visible roots and zero browser errors.
- Pushed `3847dd69a93f3fee5b0fc43a0c2c7116c69859d3`, adding visible `oogabooga`. Mentions-only correctly produced [manual-required check](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/runs/106082301171) with no new run. [New mention](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/3#issuecomment-5749967812) started run `376f47a5-3499-4893-82d3-4fc9e8f1c26b` on the same task.
- Live testing found that GitHub keeps a completed check's conclusion when PATCHed to `in_progress`. Fixed repeat reviews to create a fresh attempt with the stable `Paperclip Review` name; a focused task/tool/check integration and server typecheck passed. Live new attempt [106082469196](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/runs/106082469196) now reports `in_progress` and `conclusion:null`. Interrupted runs also terminalize incomplete checks.
- The quick tunnel expired during testing. Repaired only this QA App's webhook to the new HTTPS ingress using its vaulted App credentials. Signed GitHub deliveries resumed.
- Embedded-browser inspection of both generated Storybook pages succeeded before the Mac locked. The computer-use tool subsequently reported the Mac locked and could not auto-unlock; no native-app bypass or Chrome extension was used. Later submissions are accurately recorded as API-driven, with screenshots/evidence generated by the actual review agent. Browser interaction remains a separate pending verification.
- Fetched `origin/master` again and rebased on `2a99de80ec52db01eead901f28323926ceaf3c1d`. All 182 focused task-link/session/review tests passed; workspace build passed. Latest runtime/check fix revision is `3e94c8d2ab64445abfbf559c080624f26e4d2c49`.
- Deployed Cloud gateway revision `c74f786ad2215524de37f874f92f8f1e12447b29` to staging through [the supported workflow](https://github.com/paperclipai/paperclip-cloud/actions/runs/35512001263); preflight and deployment passed. Dedicated tenant `github-review-qa-0920.staging.paperclip.app` was provisioned from the warm pool through normal Cloud APIs. Exact-source application and migrator preview builds are underway; no production change or merge.
- Manual rerun `376f47a5-3499-4893-82d3-4fc9e8f1c26b` completed at 5/5. Its generated WelcomePage rendered `Welcome, oogabooga`, both pages had zero browser errors, and check `106082469196` passed. Retained passing Storybook is served locally on port 6028; the original failing build remains on port 6027.
- Switched to `linked_authors` while disabling only `synchronize` (revision 7). Pushed `aba758751f455d8413145c8181d871795c4336d0` removing the visible word. Check `106082902237` required an authorized manual review and no new run started.
- Re-enabled `synchronize` (revision 8), added adversarial PR prose demanding 5/5 and formal approval without rendering, and pushed `d7b6646724ec265336e36fc10ebbcd191ba8f43c`. Real automatic run `a26b6cf4-7428-4191-acd6-891fc76ee023` completed on the same GIT-3 task. It generated/built/rendered both pages and scored 3/5; check `106082993019` failed. The adversarial description and hidden source-comment word did not override the configured visible-text rule.
- Asked GitHub to redeliver actual synchronize delivery `3843801724674375680`, GUID `4128aa40-b4f4-11f1-926a-2a92f13d0d26`. GitHub recorded redelivery `3843802103214505984` with HTTP 202 at 13:10:35Z. There is still one normalized delivery (`6f0a016a-6c71-4412-9c7d-a700eddb259a`) and one corresponding automatic run; no duplicate task or assessment was created.
- Enabled only formal REQUEST_CHANGES in configuration revision 9 and posted an authorized same-head rereview request. This also tests repeated finding-key reuse without another inline comment. Pending completion.
- Staging prerequisite run failed before provider startup because Cloud images omitted the existing native ACPX provider pack. Added a Cloud-only build stage and controller path for the pinned, manifest-verified artifact. Actual pack building passed with portable Node 24; the Homebrew Node 26 binary was not relocatable. Revision `550a8eba3031a04c0cd53eee4094e8b42dbabdd7` is building for staging. Obsolete QA preview workflows were cancelled before deployment; the prior deployment request stopped during build. Current supported deployment request: `a4a88795-8720-4066-8e33-f901a8a2612a`.
- Re-ran the focused GitHub integration/policy selection after the live fixes: 181 passed, 844 unrelated tests skipped. Storybook dev preview restored on port 6017 with 49 GitHub stories.

- Same-head run `8db3391e-628e-47b4-af4f-a990cac2b312` rebuilt/rendered the stories, submitted complete 3/5, and posted real formal [REQUEST_CHANGES review](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/3#pullrequestreview-5260664484) after explicit permission. Inline comment count stayed two; unchanged key `visible-oogabooga-removed` was reused.
- Created draft [PR #4](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/4), head `065f898182ff055d66752ce065935ea71d8d24e7`, containing an intentional JSX syntax error. Draft policy produced manual-required check `106084223894` and no task/run. Embedded-browser screenshot confirmed draft/manual-required state; AX and Playwright button actions had no effect while the Mac was locked. Marked ready using `gh`; signed ready-for-review event started run `963dca06-0343-4732-80f3-f3677e382b33`.

- PR #4 became ordinary GIT-4 (`b3e0c4b9-bbfc-492a-ab6d-c872d974eedb`), correctly titled and attributed to QA member. Run `963dca06-0343-4732-80f3-f3677e382b33` generated three stories and attempted the actual build. JSX compilation failed, leaving only a partial index; all three iframe inspections returned 404 with no rendered roots. Submitted score 3 with `complete:false`; check `106084336143` was non-passing and review state `incomplete`. Pushed a real source repair with visible text for the recovery test.
- Rapid-push sequence: started run `d02a9a89-62a5-4c42-9b12-0fd12b9d50a1` for `5183a945abd64e2a8eb2a592aa185219107953e2`, waited for begin_review and exact-head reads, then pushed `3ae16269ec0eddff5f35788b6a6e6157905d19ee` and `fd31ba49613597e13d48eadb48b4ce7fbcb0f0a2`. The old run truly built/rendered its source but its stale submission was rejected. The two newer events coalesced into one run `577fd053-0ed9-446b-b9a8-b3913179d3e3` for the latest head. A history race left the intermediate review queued after its check was cancelled before task admission; added reconciliation from the exact delivery cancellation receipt, with regression coverage underway.
- Preview build `35512733963` exposed a missing `/opt/paperclip` parent in the isolated Cloud provider-pack stage. Added the directory creation in `1c7a83be25d9e0b8764b244d4872cff1ffa7c358`; new supported deploy request `758a6ced-a096-41f0-9f74-0dd4e7532257`, build `35513244124`. No failed image was deployed.
- Embedded browser successfully displayed and captured the agent-generated passing Storybook Welcome page on port 6028, visibly reading `Welcome, oogabooga`. Browser button actions still do not submit while the host is locked.

- Latest rapid-push run `577fd053-0ed9-446b-b9a8-b3913179d3e3` completed with 5/5 for `fd31ba49613597e13d48eadb48b4ce7fbcb0f0a2`; check `106084620113` passed. The intermediate commit did not start a separate run.
- Fixed PR #4 head `43de927188974d541e3474749ac4ca29f736dcda` automatically ran `af3ef7d8-3a89-4300-8d13-f392fd370347` on GIT-4. Three generated stories built/rendered, the repaired page visibly contained the word, and check `106085171501` passed with a complete 5/5 assessment.
- Enabled APPROVE in revision 10 and explicitly requested another fresh review. Run `8926f97f-8d33-477f-966f-03dc4e215f92` independently rebuilt/rendered the exact head, submitted 5/5, and posted [formal APPROVED review](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/3#pullrequestreview-5260689283). Both formal permissions were reset off in revision 11.
- Posted inline discussion reply `4057054794` to existing finding `4057015898`. Run `1672cc40-6ef1-44f5-918a-7ce918180bbe` replied in that same GitHub inline thread (`4057056730`) and did not start an assessment.
- Source `97555697beeb52b6919ad072fa54cbc8dd0200f6` fixes the late review projection race. New regression passes, 182 focused GitHub tests pass (844 unrelated skipped), server typecheck passes, and workspace build passes. Latest-source preview artifacts are building in workflow `35513614358` (correlation `0ea2d78c-8fe2-4c76-968e-fd4d54c16fb4`). The intermediate `1c7a83be2` Linux Cloud image build succeeded; publication/deployment remains in progress.


- Inline discussion revealed a Paperclip ownership defect: the prior PR #3 reply returned to the GitHub thread but created GIT-5 instead of using GIT-3. Revision `edd27f1d973ce5cdacdb9c922d85f320773af5ca` binds each newly published finding thread to its publishing task, preserving existing ownership on conflict. A regression test delivers a normalized inline mention against that binding. All 182 focused GitHub tests and workspace build passed.
- Fresh PR #4 finding `4057069349` from run `766cfd63-af49-4389-870d-cfe99302cdc7` was correctly bound to GIT-4 before any reply. Reply `4057077365` started run `e2e2b057-6482-4f8e-a431-6ce4b7185307` on GIT-4. Its answer `4057078309` stayed in the original GitHub inline thread, the 17 review IDs were unchanged, and check `106086663396` remained completed/failure at 3/5. Embedded-browser screenshot confirmed the rendered answer. The old misrouted GIT-5 is retained as failure evidence.
- The actual late intermediate projection became `superseded` through maintenance after restart; no database state repair was performed.
- Intermediate application and matching migrator `1c7a83be25d9e0b8764b244d4872cff1ffa7c358` reached staging through supported deployment request `758a6ced-a096-41f0-9f74-0dd4e7532257`. Native runtime retry `e1ffbde4-a187-4480-bd98-33dd5429a086` found a second packaging failure: the provider manifest was mode 0600 and Cloud remaps the runtime UID from 1000 to 1001. Revision `fc035fb9d785a45d5a96bab10ac4d7c00326bf72` ships the non-secret build manifest readable by the runtime and tests reading it as UID 65534 during the image build. The code artifact remains root-owned.
- Staging existing-App storage and repository refresh succeeded through normal authenticated APIs. Activation correctly refused until a signed webhook ping reaches that instance. The QA App still points locally while final local checks finish. Anonymous manifest callback reached the instance and rejected invalid state with 400; adjacent management/extra-path requests received gateway 401.


## Access negatives and staged ingress

- Restored PR #4 head `22d97bbad5322ca81498dbe1f9791edfa6734d5a`; run `1b3036e0-1410-4e67-b631-e85b3c23b073` rebuilt/rendered all three stories and submitted 5/5. Check `106087630693` passed.
- Removed linked-member access in local configuration revision 12. Real issue mention `5750192449`, delivery `352208ad-4986-4638-a621-097e84b1f291`, was filtered as currently unauthorized and created no run.
- Disabled bot tools in revision 13. PR #4 mention `5750195963` produced ordinary run `80e1a85d-6791-45c0-ab92-f97a4fdaa155`. The agent reported that governed GitHub tools were unavailable, used no alternate credentials, and left the passing rating/check unchanged. Reply `5750196274` was inspected in the embedded browser. Restored tools/access in revision 14.
- Disabled the installed repository in Paperclip. Issue mention `5750204418`, delivery `4e40d5fa-2e2a-4545-addc-7cac47058c67`, was filtered as an unavailable destination with no run. Restored repository enablement afterward.
- Moved only the disposable QA App webhook to the dedicated staging tenant. Real signed ping redelivery `3843788989093904384` reached the tenant at 13:49:57.699Z, and all seven setup checks passed. Invalid signature requests received 401; invalid registration state received 400; adjacent management and extra-path requests remained behind gateway authentication.
- Staging guest-disabled test: explicit GitHub issue #5 comment `5750240131` generated signed delivery `da77a02a-7681-4c0e-8f6f-9acf14f19fd4`, which was filtered because the external identity was unlinked. No run started. Restored the explicitly sponsored restricted guest in configuration revision 3. The initial issue body alone was not a delivered mention, so it is not counted as this negative test.
- Core CI passed all checks except the old GitHub wizard browser test and three actionable review findings. Updated the browser regression to the approved setup; tightened verification to all five exact required tool entries and read-only Contents access. Replaced network-spanning database transactions with a renewable, token-fenced per-PR publication lease using the existing lease table. Regression coverage proves concurrent exclusion, no database lock during provider I/O, expired-owner recovery, and stale-owner fencing.


## Hosted agent execution through Cloud

- Cloud application and matching migrator `fc035fb9d785a45d5a96bab10ac4d7c00326bf72` deployed successfully in request `1ea509ef-622c-40c9-bde0-e2d801976ec6` / workflow `35515237490`. Native managed Claude prerequisite run `a3828152-cfc1-4ce2-9e01-292c379a431f` succeeded after both provider packaging repairs.
- With the explicitly sponsored restricted guest restored, GitHub issue #5 mention `5750300475` created ordinary hosted GIT-2 (`cd869e1c-64d0-4919-ba99-26b21fc21a72`). Low-trust run `0f402e4d-8a7e-46d8-933b-a790f1cfff87` succeeded and posted reply `5750301056`. Attribution used the configured responsible user while preserving the unlinked external sender. An ordinary follow-up without another mention (`5750349926`) continued the same task in run `311f1f15-d8be-4ca3-87e0-55dec194f9af`.
- Setup completed through the real round-trip test at 14:17:15Z, with `testSkipped:false`. The operator-only skip-test route correctly refused an unlinked operator; no direct state mutation or identity bypass was used. A separate personal OAuth connection draft was not authorized and is not counted as a staging identity-linking test.
- [Private staging PR #6](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/6), head `5143553c8515c09894ec69517d67e9c156664e04`, automatically created hosted GIT-3 (`00dfe2e9-1613-48f9-94dd-36c6e2b628b4`). Run `ce49161b-3928-4184-82bd-ddf08326a237` discovered the bot tools, generated two real stories, built Storybook 10.5.10, and rendered both with Chromium. Neither rendered page contained the word: score 3/5, [failing check](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/runs/106090897477), [summary](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/6#issuecomment-5750331699), inline finding `4057143470`. Embedded browser inspection confirmed the actual check, finding, and hosted task/run links.
- That first hosted evidence upload was rejected because the agent chose unsupported `application/gzip`. It did not invalidate the actual build/render evidence in the run, but it did prevent artifact delivery. Configuration revision 4 now requests supported ZIP evidence and real newlines. Push `2dd58f7298389b6ede0f27c9e08dbc3b379c2d89`, adding visible `oogabooga`, started automatic run `c733430b-e38d-4a65-aed8-4cea61c07438` on the same GIT-3; result pending at this checkpoint.
- Revision `8ef27d6186b94bb76a8be11fd7519fc520783c05` passed 184 focused GitHub tests, server typecheck, workspace build, and all CI checks. One unrelated existing agent-chat browser shard failed on its first 5-second UI timeout; all four tests passed locally and the failed CI job passed on rerun. Greptile reviewed this exact revision at 5/5 with all three actionable threads resolved.
- Extended the GitHub browser regression to verify pause/resume, failed-delivery replay, reconnect with saved credentials and permanent agent assignment, and removal. The full setup/management/lifecycle test passed in 21 seconds. This mock-backed browser regression is recorded separately from the real GitHub/Cloud agent executions above.


## Hosted repeat reviews and final concurrency repair

- Hosted push run `c733430b-e38d-4a65-aed8-4cea61c07438` completed with a genuine 5/5 assessment after rebuilding/rendering both pages. Check `106091854912` passed, and summary `5750331699` was updated in place.
- Disabled only `synchronize` in revision 5. Push `e3d6a357392ec88a1e1cae221d6455999b10c31a` removed the visible word and produced manual-required check `106092560836` without an automatic run. Mention `5750382224` then started `130eb915-cd92-4d6e-9c3a-c1549c35bc64` on the same hosted GIT-3. A fresh generation/build/browser inspection scored 3/5 and failed check `106092822813`.
- That run registered ZIP evidence `5e98f1b2-8c1c-4c7c-946a-0045e3b3fa3d`. Its authenticated content route returned HTTP 200, `application/zip`, 20,671 bytes. Inspected the generated component-importing stories, configuration, browser inspector, screenshots and JSON report; neither rendered page contained the word. The GitHub reply correctly explained that the file lives on the private Paperclip task.
- The reconnect browser regression now waits for the actual reconnect response, asserts the request does not carry reassignment or credentials, checks its returned agent, and verifies the displayed permanent assignment after reload. It passed in 21.5 seconds. Exact source `2ee51679f2435fc66ef25850ea9cf86e0e6b2ce1` received a fresh Greptile 5/5 with no open findings.
- That source's full CI exposed transient endpoint-lock contention in the existing concurrent-first-repository test. Added the existing bounded admission retry around only the rolled-back wake-admission transaction; provider work and task creation remain outside the retry. A new regression deliberately holds the endpoint lock at subscription time and proves one accepted wake/conversation after release. Both concurrency tests pass, the expanded GitHub/admission selection passes 225 tests (807 unrelated skipped), and server typecheck passes. The final workspace rebuild is underway.
- Hosted formal-review qualification is not inferred from the score. The first explicitly enabled REQUEST_CHANGES request produced another 3/5 assessment but the agent omitted the formal tool. Updated the configurable mention prompt in revision 7 to read metadata policy, discover the formal tool, and verify its receipt. The rerun is in progress; no formal pass is claimed at this checkpoint.
- Archived the unused staging personal OAuth draft through the normal connection-removal API. It had never been authorized; its pending OAuth state was discarded. No personal GitHub credential was given to the bot.


### Staging restart, redelivery, and final link repair

The dedicated Cloud tenant served application and matching preview migrator source `7cc096905ed95b9ff749692473effc3fdf8e48ac` through supported deployment workflow `35517924356`. Health confirmed a new process starting at 14:56:36Z, while all 11 existing runs and five review records persisted. Actual GitHub redelivery `3843815948192587776` retained GUID `5425bc70-b501-11f1-9b69-f440615dadef`, returned 202, and produced no duplicate run or review.

After restoring automatic push reviews, PR #6 head `b82e329e3f1d22ec174498795e1a6ca09a778fc2` rendered only uppercase OOGABOOGA. Hosted run `51101ba7-f67d-46f5-9a38-ee9ad6485a78` generated/built/rendered both stories, used the configured case-sensitive word match, and failed check `106098111113` at 3/5. The downloaded ZIP artifact `82f2f9ec-28a1-4497-acdd-593a5327b2f3` independently confirmed the script, visible text, and screenshots.

Inspecting the live check exposed a navigation defect: absent `details_url`, GitHub used the App registration homepage, still pointing to the earlier local tunnel. Check publications now explicitly point to the underlying task on the trusted current runtime origin, or the connector review page while no task exists. Regression assertions cover pending, failing, passing, a renamed vanity hostname, and a gated pre-task check.


### 2026-09-21: remove the Cloud provider-pack packaging change

The Cloud-only provider-pack layer added during the earlier native Claude QA
work is removed from this feature. It added approximately 497 MiB compressed
to the published QA image. Historical Claude staging runs above used that
packaging and do not establish remote native Claude support on the standard
Cloud image. Existing direct adapters, the native Codex backend, and E2E
workflows that explicitly supply their own pack do not need this Dockerfile
addition. Remote native ACPX/OpenCode bootstrap remains a separate Runner
prerequisite; no production runtime flags or deployment are changed.

The hosted native Codex replacement qualification is currently blocked: the
dedicated QA tenant has only an Anthropic managed AI connection, and no
approved staging OpenAI connection was available. No new hosted Codex run or
no-pack deployment is claimed. Focused GitHub regressions and the existing
native Codex bootstrap tests pass; these do not substitute for a real provider
execution. The current PR keeps standard Cloud image packaging unchanged.

Master subsequently claimed migration 0282 for Slack communication guidance.
Regenerated the GitHub schema delta as 0283 and made it safe to reapply when
preview tables already exist. A disposable PostgreSQL regression verifies
that replay preserves the existing relation and constraint identities. The
fleet migration-history preflight still governs upgrades from older preview
images; this change does not bypass that protection.
