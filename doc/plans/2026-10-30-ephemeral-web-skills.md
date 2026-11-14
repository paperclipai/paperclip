# Skills on ephemeral web servers

## Qualification status

Implementation is in [PR #18334](https://github.com/paperclipai/paperclip/pull/18334).
Hosted qualification uses the owned disposable
[test tenant](https://ephemeral-skills-qa-oct-30.test.paperclip.app), external
Postgres, S3, and a real remote Paperclip Computer. Cloud policy reserves the
staging domain for master; the rejected staging branch request below made no
deployment.

- **Passed:** independent-process PostgreSQL/S3 failure matrix; hosted A → B → C
  replacement with predecessor homes absent; C reads and executes B's acknowledged
  save; historical repository pin delivery while a newer revision is installed.
- **Passed:** full CI and code review at `7ec495de77`, confidence 5/5, no
  unresolved findings. Workspace typecheck/build, focused regressions and the
  separate-process replacement matrix passed. Local timeout attempts remain
  recorded below; their results are not counted as passes.
- **Passed:** compatible image rollback to `6518b323` retained the newer managed
  revisions and delivered their bytes plus the historical repository pin remotely.
- **Passed:** deployed unassigned-skill Studio retry: the exact fork v3 was
  delivered and executed, Studio reached `succeeded`, and its output snapshot
  persisted. Independent package verification found zero blockers.
- The maintenance CLI configuration bootstrap regression and server typecheck
  passed. The PR records final CI/review status for the commit containing this
  evidence update.

Runtime candidate `9200e3fcb4` contains the native Studio selection/completion and
legacy completeness fixes. It is deployed and qualified. Later changes integrate
master, protect drafts during a delayed UI reload, and load persisted Cloud
configuration in the maintenance CLI; their verification is recorded separately.
The chronological record below
retains earlier failures and intermediate pending states; this section describes
the current qualification status.

## Accepted contract

Given the same database, object storage, secrets, and supported application
artifacts, a replacement server must discover, read, edit, and deliver protected
installed skill versions without its predecessor's files or process memory.
Disk is permitted for disposable scratch, verified caches, and execution delivery.
Managed authoring and library operations address immutable content, not a mutable
installed directory. Git remains the authoring source for repository skills;
installed revisions and run pins govern delivery. Linked local sources remain an
explicit self-hosted compatibility boundary.

Current, pinned, active/recovering, and authored versions retain durable bytes.
Unused historical Git versions keep the existing expiry/exact-commit policy.
Legacy conversion may use one maintenance window. Compatible later upgrades and
rollback use the same remote state. Other web-server persistence, Railway traffic
handoff, and production volume removal are outside this slice.

## Delivery and acceptance

1. Introduce managed ownership and content publication without installed paths;
   preserve access, atomic metadata/version publication, idempotency, conflicts,
   and active-run retention. Update Studio and API consumers.
2. Separate selection/pinning from materialization; restore exact runtime digests.
   Add bounded legacy conversion and disk-independent eligibility diagnostics.
3. Prove cold A → B → C replacements, concurrent writers, uncertain commits,
   offline upstream, corrupt/missing objects, access, retention and idle behavior.
   Run required checks and qualify one disposable staging tenant with a real
   remote agent. Finish with a reviewable PR and exact revision/evidence links.

## Canonical work and progress

- Worktree: `/Users/dotta/.codex/worktrees/d084/paperclip`
- Branch: `codex/skills-ephemeral-web`
- Draft PR: https://github.com/paperclipai/paperclip/pull/18334
- Approved plan: this chat, “Skills on ephemeral web servers,” nine sections.
- Implemented managed create/read/edit/delete-file/fork/rename/restore publication,
  immutable catalog installation/reset, Studio version conflict recovery, durable
  pre-materialization selection and exact pinned-runtime rehydration. Source
  disconnect retains immutable content and access provenance.
- Added bounded installation conversion, eligibility and independent version
  verification to existing migration tooling; conversion requires retired writers.
- Independent OS-process A → B → C qualification passed using owned Docker
  PostgreSQL and RustFS S3 fixtures. Real HTTP routes covered saves, supporting
  executable content, uncertain commit receipts, stale concurrent saves and upload
  crashes. This is not hosted Runner qualification.
- Studio tests: 14 passed, including draft preservation and confirmed reload.
- Workspace typecheck and build passed. Map checks and UI token gates passed.
  Broader compatibility coverage passed 362 cases; follow-up runs passed migration,
  policy, package, project access and retained-run cases after updating old model
  expectations. Final focused checks and the full repository suite are running.
- One-connection tests now exercise package acquisition before the publication
  transaction. Fork reassignment also uses the transaction's database handle.
- Host embedded Postgres cannot initialize: exhausted kernel semaphore pool.
  Owned Docker fixtures are `paperclip-skills-ephemeral-pg` (port 61006) and
  `paperclip-skills-ephemeral-s3` (port 61007). No unrelated databases changed.
- Disposable staging tenant created through normal onboarding:
  https://ephemeral-skills-qa-oct-30.staging.paperclip.app
  Agent `dfd238b5-5e5d-43ef-b34a-cb5bff2267f3` (Skills Qualification), paused.
  OpenAI API-key setup uses the explicitly authorized local credential. Candidate
  `6518b323528b2b595c5949c3ed2c57a8d2438cb6` is building under release run
  https://github.com/paperclipai/paperclip/actions/runs/41085949238.
  Single-tenant deploy request: `c65f3677-4b4e-4687-957a-28e2bfb89451`.
  Stack `stack-pool-50f5009d5644` is user-managed during qualification so unrelated
  fleet rollouts cannot replace the test candidate. No live run claimed yet.
- Greptile's first review found root-package path truncation, linked-local fork
  and restore regressions, and a concurrent receipt replay race. Fixed all four;
  focused review checks passed 76 server and 16 Studio tests. CI also exposed
  obsolete host-path fixtures and a company-deletion/publication race. Updated
  those fixtures and publication locking; 20 targeted integration tests passed.
  Skill detail now resolves existing metadata without seeding the entire library.
- Remaining: finish repository checks and PR review, candidate deployment and
  fresh-home remote Runner qualification including compatible rollback. The PR
  stays draft until hosted qualification and the final checks are complete.
- Greptile reached 5/5 with all six comments resolved at `8c0fae76a6`.
  CI at that revision passed typecheck, build, all unit/integration shards and
  Runner checks; two browser shards still require investigation. The shared-chat
  question fixture's five-second assertion raced a successful asynchronous run;
  its readiness wait now follows the existing run-settlement helper.
- A cold metadata assertion exposed three manifest downloads during history
  listing. New versions now persist a complete metadata index and migration
  backfills legacy indexes without changing content/version identity. Process
  qualification confirmed zero metadata/warm downloads; its tiny fixture measured
  a 176 ms cold read (two objects, 899 bytes), 37 ms warm execution preparation,
  899 MB process RSS and 820 bytes of temporary files. These local fixture numbers
  are not hosted latency or incremental memory claims. A follow-up compatibility
  run caught changed file ordering; preserving the existing order fixes that drift.
- Metadata/package compatibility passed all 44 tests after preserving file order.
  Both affected browser cases passed independently. Stop/reset now allows a bounded
  30-second cold startup; its failure trace showed cancellation during preparation
  when the old five-second assertion expired, before the fixture began streaming.
- The baseline image published successfully, but the deployment check rejected the
  branch with `fleet_campaign_staging_requires_master` (Cloud run `41092962684`).
  Current Cloud policy uses `test.paperclip.app` for branch experiments. The local
  Cloud checkout's older runbook missed this boundary. Qualification is moving to
  an owned disposable test tenant; the rejected request made no tenant deployment.
- All 53 applicable CI checks passed at `0dc9a42a6f` (two skipped checks).
  The next review found that complete metadata indexes bypassed the unchanged
  linked-local manifest shortcut. Whole-package identity mappings now retain that
  shortcut; subsets and remapped paths still use their projected inventory.
- A new concurrency regression reproduced a content save overwriting an already
  acknowledged metadata edit. Publication now checks the metadata fields it will
  replace as well as the version head, and returns 409 when they changed during
  preparation. The managed-content and catalog suites passed after this fix.
- Local package/project checks hit timing limits while an older full-suite worker
  remained active for over 80 minutes. That task-owned run was stopped; it is not
  recorded as a full-suite pass. All four isolated package cases then passed,
  including the two previous timeout failures and the linked-local regression.
  Final project-access/process qualification is running sequentially. Server
  typecheck passed with both final fixes.
- Correct disposable branch-test tenant:
  https://ephemeral-skills-qa-oct-30.test.paperclip.app
  Stack `stack-ephemeral-skills-qa-oct-30` is pinned user-managed. Baseline A
  `6518b323528b2b595c5949c3ed2c57a8d2438cb6` is confirmed serving from image
  `ghcr.io/paperclipai/paperclip:sha-6518b323528b2b595c5949c3ed2c57a8d2438cb6-cloud`.
  Deploy request `19c33461-d232-453a-bdd1-ba357459be48`, campaign
  `fleet-campaign-1793366873548`, Cloud run `41094804453`: one target succeeded.
  The user approved saving the same OpenAI key to this test tenant; its remote
  Codex environment verification succeeded on a Paperclip Computer.
- Studio created unassigned managed skill `3ade7878-8aaf-47c7-aebd-7da23a8afb5d`
  (Ephemeral Skills Proof), with instructions, `references/value.txt`, and
  `scripts/prove.sh`. Remote agent `300911d4-590d-4a26-b1c0-c80db14fa072` is
  preparing the executable flag through the ordinary API. Fresh-home replacement,
  delivered-byte verification and compatible rollback remain pending.
- Final sequential project-access/process qualification passed all 31 cases;
  the complete-map package checks passed all four isolated cases. The metadata
  and linked-local fixes were pushed as `ceab192b1774fcb5be17db57de5579d81007b9c1`.
- Remote preparation task EPH-1 saved revision 6, version
  `1abec28d-dd4a-4763-acd4-5a67af874911`, with the script executable. All three
  reported file digests match hashes independently computed from the Studio
  inputs. Company: `16cfa89e-f159-5040-927e-aca46ee87c2f`.
- Baseline Studio test `81951c91-ec59-4eae-b5c5-c0083119f6ae` failed before
  execution (`b326a961-c1b8-43ad-b38b-7f6424939ee3`): its route constructed
  heartbeat without the existing plugin worker manager. This is a route wiring
  failure, not missing skill content or missing image dependencies. The fix passes
  the app's existing manager through the Studio route to execution, matching other
  task routes. No Cloud composition/admission policy changes are required.
  The first route-suite attempt hit its 30-second module-load setup timeout before
  any test ran; a bounded 120-second setup-budget retry is running.
- The Studio route regression suite passed all 64 cases on retry, and server
  typecheck passed. The managed sandbox manager is reused from app construction;
  no provider behavior, permissions or lifecycle ownership changed.
- Baseline remote task EPH-3 passed on run
  `07a711a9-a7d7-45e3-8c00-f64f71d2a9cc`: the delivered v6 script ran directly
  with mode `555`, printed `skill-script-A: durable-skill-payload-A-20261030`,
  and all three file digests matched independently calculated input digests.
  Its saved task document records the execution-local installation path.
- Imported repository skill `581b718a-3681-48c4-96d5-87d12b694550` from
  `paperclipai/paperclip` commit `dff63551fe07934a82a0942e502adba3fcbb08ca`.
  The existing import filter admitted 12 files and excluded the API reference.
  A later explicit source refresh hit the repository size limit and retained
  the installed revision. That refresh is not counted as a successful update.
- Test-only env campaign `fleet-campaign-1793366873581` succeeded at
  `2026-10-30T17:38:00.006Z`, changing only `PAPERCLIP_HOME` to
  `/tmp/ephemeral-skills-a` on `stack-ephemeral-skills-qa-oct-30`.
  Audit evidence reports one target, one key, zero removed keys, and unchanged
  Computer images. Studio reopened v6 with its supporting files afterward.
  Unassigned fork `6381a0a0-582b-4d26-b858-4e56b606e07c` was created through
  Studio and saved as v2 with `unassigned-payload-A-20261030` in its reference.
- Review of `35b6a12fe4` identified a forced catalog reinstall conflicting with
  its own audit metadata write. A real Postgres regression reproduced the 409.
  Candidate auditing is now read-only; successful publication commits the new
  audit metadata, while unchanged/rejected operations retain audit reporting.
  Regression checks cover forced reinstall, a new slug, and a competing metadata
  writer. The combined catalog/managed run passed 29 cases and hit one unrelated
  15-second asset-test timeout; all four focused catalog cases passed on an
  isolated rerun. Server typecheck passed.
- Latest browser CI exposed another five-second startup assertion in the
  feature-disable journey. Its trace showed an active adapter invocation before
  the fixture's first message. The assertion now uses the existing 30-second
  cold-start budget; the exact browser journey passed locally in 12.5 seconds.
  No feature-disable behavior or fixture completion assertions changed.

- Latest code review of `07fffa749511a39b05b2dbc43adcce842195398a` is 5/5,
  with zero unresolved review threads. Hosted candidate build is run
  `41101360597`; baseline A remains deployed until it completes.
- Provider console independently confirmed external Neon Postgres and S3 on A,
  with `PAPERCLIP_HOME=/tmp/ephemeral-skills-a`, deployment
  `5fc05d1a-2451-465c-8a15-16b18d1e0d3d`, replica
  `f7393d02-49b6-40b9-ae94-db9181300bf4`. A temporary marker was written to
  that home so a later container can prove the predecessor's local state is absent.
- Imported the smaller `vercel-labs/agent-skills` repository at exact commit
  `93f5a2dee1a270015473e19d24a758a012fa058b`: skill
  `3e9f2b84-2d15-49f9-a5c0-8596f4c6e313`, source
  `0c03e633-d22e-4a63-b5a5-843823f2eb7b`, 75 admitted files.
  Early pin attempts were rejected by the existing Beta skills gate. The late
  error toast was confirmed; read-only DB inspection showed no saved pin.
- Beta skills is a tenant preference, so fleet feature override correctly
  rejected it as non-managed. Test-only env campaign
  `fleet-campaign-1793366873607` exposed only this preference, preserving the
  complete existing hidden-settings list and temporary A home. It succeeded at
  `2026-10-30T18:04:20.150Z`: one target, two keys, zero removed keys, unchanged
  Computer images. The tenant's normal Experimental UI then saved Beta skills
  enabled. No fleet default, identity, permission, or volume policy changed.
- The preference campaign replaced A's container: deployment
  `9ba9202e-7f47-4edd-b501-aa807760b132`, replica
  `d2131533-f4d2-4173-b984-ca46beaef61c`. Provider console observed the
  predecessor marker absent, then wrote a new A2 marker for the next replacement.
- Repository assignment saved through the library UI as historical version
  `918e2066-b241-4cdc-934a-db896138240b` (revision 1, `GitHub 93f5a2de`).
  Explicit source refresh to main published current revision 2
  `fa3bb9ac-fcd9-443b-970c-f62590f881dc` (`GitHub 1a2c79d4`); automatic
  updates remain paused for this fixture.
- Remote task EPH-4 (`e561a058-3e2d-4f90-9899-a69c6539ed42`), run
  `9917cfa3-caed-400a-b1a0-58183e2e2614`, passed after A's temporary state
  was replaced. Managed v6 hashes/output/mode matched EPH-3. The repository
  wrapper delivered revision 1 while revision 2 was current. Independently read
  exact-commit upstream contents matched the delivered instruction digest
  `50b55178a2da8ee931850193596601fa0517cd800e171366a903769f25bf4dda`
  and `rules/async-parallel.md` digest
  `6d2f841896279e976dfcdc1ac89e70771ac188baadfd43c096b5706cb838b961`.
  The agent used the rule to recommend parallel independent fetches and saved
  paths, command results and API history in task document `immutable-pin-proof`.
- Required CI gates `ci / verify` and `ci / e2e` passed on `07fffa749`.
  Latest check rollup: 52 success, two skipped, one cancelled advisory review
  job; Greptile separately completed at 5/5 with no unresolved threads.

- Candidate `07fffa749` deployed successfully through core-only test request
  `d4e172e8-a861-48cc-ae9c-e2f26c8ee636`, Cloud run `41106109829`.
  B is deployment `ed70e789-22c3-4b93-93de-da61d7f30ca4`, replica
  `16fbb2e8-a7b3-4f32-a483-bc2f5c77a8ee`, with
  `PAPERCLIP_HOME=/tmp/ephemeral-skills-b`. Local health confirmed the code SHA;
  provider console confirmed A's home and marker absent. The unassigned fork
  opened as v2 with zero agents. Studio acknowledged a supporting-file edit to
  the primary managed skill as v7 (`durable-skill-payload-B-20261030`).
- Independent verification on B read 23 saved versions: 21 `remote_storage`
  results and two `database_release_snapshot` results. No corrupt, missing,
  local-storage or provider-mismatch results. The next cursor returned zero.
- Live Studio test EPH-5, test `9c4f3775-2793-46c6-b09d-e3343e0e4c65`,
  heartbeat `7fe45977-a061-408b-b7c5-5721a7e9f08b`, passed the repaired plugin
  wiring but failed native admission: `skill_test` was excluded by Runner's
  task-mode allowlist and execution-input parser. This failure is retained;
  the Studio acceptance requirement remains pending a deployed retry.
- Follow-up admits and preserves `skill_test` through the existing native
  selection, execution contract and tool bindings. It does not relabel tests
  as standard work. Task-bound JWT restrictions remain with their authorization
  owners; the native surface is restricted as detailed below. No executor refactor or
  Rust protocol change is needed. Older images that reject this mode cannot
  continue a new Studio test; rollback qualification settles tests first.
- Follow-up local checks: 78 admission/input tests, 109 Runner contract tests,
  40 assigned-MCP tests, and three real-HTTP skill-test scope regressions passed.
  Initial scope/MCP attempts encountered sandbox socket restrictions; permitted
  retries passed. Runner TypeScript/Rust checks and server TypeScript check
  passed. Maps remain aligned (35 areas, 192 capabilities).

- B's v7 is `e1f96114-6be5-4878-b9ae-269bac0da215`; independent hash of
  its supporting file is `c2d9b967aa8ddfad7896804ea1a7ae613b8ff631ff6a084cee7553125bc7fd27`.
  EPH-6 (`c5377e90-c80c-4f97-8ada-c4eaf205af0a`), run
  `96537d81-b224-442a-9ec1-993fbd89ff56`, completed successfully and saved
  `server-b-skill-proof`. Direct script output contained the B payload; executable
  mode remained 555, other managed hashes were unchanged, and repository v1
  instruction/rule hashes matched the independent exact-commit reference.
- C home campaign `fleet-campaign-1793366873685` (target
  `fleet-campaign-target-1793366873686`) succeeded at
  `2026-10-30T18:36:03.930Z`, preserving both managed env keys and Computer images.
  Deployment `462e3327-e49b-4096-b5e2-73f5db058a9f`, replica
  `01c696c4-89b9-4358-9c2b-108faa4c9d50`, served `07fffa749` with home
  `/tmp/ephemeral-skills-c`. Console verified A and B directories and B's marker
  absent. Studio cold-read v7 and the exact acknowledged B payload.
- Unassigned fork v2 identity was independently confirmed as
  `8b008393-f909-424a-9f68-1995231455a7`. It remained at zero assignments on C;
  its supporting file was then edited through Studio to a C-specific payload.
  Execution on the candidate with native Studio admission remains pending.
- C's remote EPH-7 (`d57f6f66-7072-4fb9-abde-199edf5192ef`), run
  `c7f89682-ab9b-4f00-940f-88967c6c0264`, completed successfully. The saved
  `server-c-skill-proof` document (revision `8129375b-f56c-4b80-99b0-637481a31f72`)
  was independently opened and read. All five hashes matched the B run and
  independent references. Its new session `7f164893cdc73464e112e2572baed3ddc166bb29485d770c37fbf7449793cdc0`
  executed the unchanged script with exit 0, mode 0555 and the exact B payload.
  The managed selected/current version remained v7, and repository selection
  remained v1 while its current head remained v2.
- Review of `8821b040` found that native task creation omitted the admitted
  skill-test scope. Image build `41108317938` was cancelled before deployment.
  Native authorization now carries the saved scope, denies company/peer tools,
  task creation and external tools, and checks the scope before mutation receipt
  replay. Task context contains only the harness task. Real database regressions
  exercise both fresh tests and persisted tests after their task mode changes.
- Native scope checks passed: three new real-database cases plus four REST
  scope/image-access cases. The existing native tool-authority suite passed all
  37 tests. Server typecheck and map checks passed. The initial new-test attempts
  corrected a fixture tool name and matched the existing privacy-preserving 404
  for unrelated tasks; own-task reads returned 200.
- `350f1b377c459420a1c1474723501a4bccc6d7fc` received Greptile 5/5.
  The native-scope review thread is resolved. Test deployment request
  `d2480188-1fc9-4a22-a32b-16af7f439ca4` prepared in Cloud run `41110650568`;
  candidate image build is `41110729544`.
- The fork's C save is version `ef34d9e5-2533-497e-8411-a797117afb4a`.
  C's durable `tool.execution.completed` event at sequence 322 was inspected
  independently of the report: the real shell command completed with exit 0,
  mode 555, all five expected hashes, and `skill-script-A: durable-skill-payload-B-20261030`.
  A disposable `qualification-marker-c` was written in C's temporary home for
  the next container replacement check.
- Full CI at `350f1b377c` passed 50 checks but found two old `mode_denied`
  message expectations in case/reassignment tests. Both operations are rejected
  earlier by the native scope guard with 403. Updated the assertions and checked
  that denial never stops another task. The case-gate regression and all 26
  reassignment tests passed locally. Reassignment now uses the existing optional
  external-Postgres helper; initial attempts hit exhausted embedded-Postgres
  resources and a startup timeout, retained as failures rather than passes.
  These follow-ups change only tests and evidence, not candidate runtime code.
- Image `350f1b377c` deployed successfully in Cloud run `41115408877`, confirmed
  by local health on deployment `d70457ab-a812-45d5-8a38-657f6bfc02de`, replica
  `9f58192d-9207-4065-86e4-48887c6a8b3e`. A/B homes and C's marker were absent.
- Studio test `ef0aa327-f719-44a3-bea2-1d051f2a793a`, task EPH-8
  (`860476c5-d4bf-4619-9206-8aa18884f545`), executed successfully but delivered
  the agent's normally assigned primary skill instead of the requested unassigned
  fork. Its report explicitly records the mismatch. This is a failed qualification,
  regardless of the task's Done status. The fix passes the durable Studio pin into
  execution preparation, replacing ordinary assignments while preserving recovery
  pins and current access checks. Hosted retry remains required.
- The same EPH-8 heartbeat (`94eeb6ff-7d9e-49b7-bee2-0ef5f41ff8a4`) succeeded
  and marked its task Done, but the Studio row remained queued with an empty
  output snapshot. Native completion bypassed the REST-only success hook. Native
  status publication now calls the existing skills owner within its transaction;
  status, output and activity commit together. Four real-Postgres regressions pass
  for completion/cancellation, replay from another client, transaction rollback,
  blocked work and superseded tests. Completion uses a conditional terminal update.
- The two selection regressions pass, including assembled dispatch of an unassigned
  historical executable file. Server typecheck and map checks pass. A broad local
  execution suite attempt hit timeout cascades (20 passed, 9 failed); this is not
  counted as success. Isolated new tests passed; the full affected suite is rerunning.
- Compatible rollback request `2363f01e-2e6b-4b72-9234-3fd0c5f22e88` deployed
  `6518b323528b2b595c5949c3ed2c57a8d2438cb6` through Cloud run `41116892516`.
  Deployment `5034b027-d9e2-4bd6-8efe-526d3d065d7d`, replica
  `9ff45218-e553-4122-b411-e7052c521917`, was confirmed through local health.
  The predecessor's `qualification-marker-d` was absent. Studio reopened the
  unassigned fork's v3 supporting file as `unassigned-payload-C-20261030`.
- Rollback task EPH-9 (`d5d03621-9616-4713-88ad-0ea54e4c3d53`), run
  `7ae0b61d-0e9f-4761-914c-9dc399c0ebc8`, completed on a real remote Computer.
  Its `rollback-skill-proof` document matches all six independently known hashes,
  managed v7 and repository v1 IDs. It executed the unchanged script with exit 0,
  mode 0555 and the acknowledged B payload. Durable command event sequence 293
  was independently inspected through the tenant console and confirms those
  bytes, hashes and actual execution. The repository rule also produced the useful
  independent-requests `Promise.all()` recommendation.
- The complete affected suites passed all 33 tests in 65.65 seconds. The Studio
  fix is `417270ab18`; current master `3b84c89885` merged without conflicts as
  `5afd8c3b056f6c0fceeb121c0f398beb72317e2b`. Post-merge server typecheck,
  all 33 affected tests, map checks and UI token gates passed again.
- The independent OS-process replacement matrix passed again on `5afd8c3b05`
  (two scenarios, 54.24 seconds). A/B/C version IDs were
  `56c4b315-082f-4caa-8788-02e10b45d3a4`,
  `ed03e467-3a81-4256-849e-53ece688e5aa`, and
  `9ff5d4ce-43e7-4b2e-883d-8b010fc5c42b`. Cold read was 522.16 ms,
  two downloads/899 bytes; warm preparation was 143.72 ms with zero downloads.
  Reported RSS was 881,639,424 bytes and disposable home content 820 bytes.
  These are local fixture measurements, not hosted latency claims.
- Candidate request `9a03542e-ea41-4ea1-94c8-7dd1ae38c621` prepares in Cloud
  run `41118819981` and builds in Core run `41118878753`. The tenant remains on
  the verified rollback image until this candidate is deployed.
- Review at `5afd8c3b05` found that existing partial repository versions could
  bypass conversion and be reported as eligible. Installation conversion,
  eligibility and independent verification now compare the current saved inventory
  with the installed inventory. Missing files block readiness; conversion can use
  only complete saved/local content or the exact pinned remote source. Both JSONB
  and packaged legacy regressions pass, including upstream failure with an unchanged
  head, exact-commit repair and unchanged complete installations. The entire managed
  content suite passed 16 tests. Build `41118878753` was cancelled before deployment
  so hosted acceptance will use a candidate containing this correction.
- Full workspace typecheck passed after allowing the migration launcher's local IPC
  socket. The initial sandbox attempt failed with `listen EPERM` before that check
  could run. The workspace build is running separately.
- The workspace build passed on `9200e3fcb4` after correcting a missing-version
  null check caught by its first attempt. Greptile re-reviewed that commit at
  5/5 with zero unresolved findings. Image request
  `0b5a10c1-dccf-4c01-9db7-548ea07897a0` prepares in Cloud run `41120340127`
  and builds in Core run `41120440752`.
- Earlier failed Studio fixture `ef0aa327-f719-44a3-bea2-1d051f2a793a` was
  cancelled through Studio to settle its stale queued pin. Its mismatch report and
  draft output remain visible. It is still recorded as a failed qualification.
- CI run `41120305357` found the same obsolete restart-scope fixture in Runner
  static checks and general server shard 5. The helper always returned no saved
  skill; preparation now correctly rejects that state. It now reads a real durable
  test/version row, asserts missing-version rejection first, and still verifies
  restricted REST scope after task-mode edits. Both focused HTTP cases and server
  typecheck pass. The complete 52-case HTTP suite passed in 63.78 seconds. This follow-up
  changes only the test fixture and evidence, leaving image runtime code unchanged.
- Master advanced to `76fde891cc` during image publication. Merge `61f5664337`
  preserves both the skill-recovery and native-usage imports; no skills behavior
  changed in the merge. Full workspace typecheck and build passed. A combined
  local run passed 42 cases, failed three execution timeouts plus a tracer setup
  assertion, and skipped 52 HTTP cases after a setup timeout. Isolated retries
  are recorded below rather than treating the combined run as passing.
- Review found a delayed conflict-reload response could overwrite text typed after
  discard confirmation. The response now applies only while the same skill, file
  and draft remain current. All 17 Studio component cases passed, including a
  delayed response while the user continues typing. This client-only follow-up
  is separate from the `9200e3fcb4` server image used for remote delivery proof.
- Full CI run `41124309799` passed at `7ec495de77`; Greptile review 14 is 5/5
  with zero unresolved findings. The isolated local execution retry stopped
  producing progress and was interrupted; no success is claimed for that attempt.
  The full CI suites cover the integrated execution and HTTP cases.
- Candidate `9200e3fcb45082ad73fbb75863d56eb2e6ce526c` deployed successfully
  through Cloud run `41124147876`, ready at `2026-10-30T20:36:46Z`.
  Deployment `3daed721-eefe-4947-afe3-d8fd1db6aa2c`, replica
  `29375d2e-50ea-467e-9492-a2d4bc7e628e`, retained the temporary C home setting.
  Console inspection confirmed A/B homes and the rollback marker absent.
- The Studio retry created test `7c55d51d-c2c9-426e-a2fa-3606c486d41a`, task
  `e8405564-1d2e-4013-8aeb-145de0a76fbd`, and remote run
  `c6ebc90d-1411-404b-ad6d-789d960a7a48`. It delivered only the selected
  unassigned fork `ef34d9e5-2533-497e-8411-a797117afb4a` (v3), with
  `unassigned-payload-C-20261030\n`, stdout
  `skill-script-A: unassigned-payload-C-20261030\n`, exit 0 and mode 0555.
  Studio visibly reached `succeeded` and displayed the durable output snapshot.
  The fork still has zero assignments. SHA-256 values match the expected fixture:
  `SKILL.md` = `a97ee4d33cac28f9affcc53e48b3de00f72a9a8b70a0b3a53bb81569b1111ae6`,
  reference = `0d5a7396baaf395ef24e9136b2f9892e9878d863b42ff3195d376f61248d1f5f`,
  script = `8830c87e4e56e76dbe70bfac5fa4260d1e33d62eaa3289d1f8887a3fa9521da0`.
- Independent database inspection confirmed task EPH-10 is done, its native run
  succeeded, and its exact durable selection contains only the unassigned fork v3.
  The Studio row is `succeeded` with a 1,915-character output snapshot. Runner
  command event sequence 204 independently confirms all three hashes, actual
  script stdout, exit 0 and mode 0555; these are tool results, not only the agent's
  report. The Studio success screenshot is retained with the handoff.
- Final eligibility inspected 14 installations, all `version_backed`.
  Independent verification inspected 25 versions: 23 `remote_storage`, two
  `database_release_snapshot`, zero blockers, and zero rows at the next cursor.
  The first standalone command incorrectly reported packages unavailable because
  it had not loaded Cloud's persisted runtime configuration. The same services
  passed after loading that snapshot. The CLI now loads it read-only and fails
  explicitly if absent, without seeding configuration. A real child-process test
  covers missing configuration, no write on inspection, eligibility, and object
  verification; it passed. An initial diagnostic wrapper also used a nonexistent
  compiled DB entry point; correcting it to the image's source entry point allowed
  the bounded verification to run. Neither diagnostic failure changed skill data.
- The CLI child-process regression passed in 46.52 seconds, and server typecheck
  passed after the bootstrap correction. The CLI reads existing configuration
  without creating or changing it; no new maintenance process or listener exists.
