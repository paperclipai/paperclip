# Skills on ephemeral web servers

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
