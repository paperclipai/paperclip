# Project repository skills: acceptance evidence

Live GitHub updates, immutable routine executions, access/recovery checks,
production-component browser journeys, and manual responsive review passed.
Local standard test phases were completed across documented environment retries.
Final review/check results and merge state are recorded on PR #16066; merge is
gated on its exact head. This report separates real outcomes from test fixtures.

## Environment and artifacts

Implementation checkout: `~/.codex/worktrees/4631/paperclip`, branch
`codex/project-repository-skills`, PR [#16066](https://github.com/paperclipai/paperclip/pull/16066).
The isolated instance uses embedded PostgreSQL and a retained disposable data
directory outside the checkout. Doctor verified the served source revision and
loopback port ownership before the live journeys. No production company data was
used. The test GitHub repository is private and contains only generated skill
fixtures. The supported live adapter is `codex_local`, using model `gpt-6.1-sol`
through the existing authenticated Codex subscription.

The tracked [evidence bundle](../../ui/storybook/public/project-skills-evidence/)
contains the original four captures and a final post-reconciliation capture and an explicit, minimized
[version receipt](../../ui/storybook/public/project-skills-evidence/versions.json).
It is included in the existing Storybook build artifact and branch publication.
Credential files, full provider logs, human authentication keys, and connection
secrets are excluded. This direct Codex task has no driving Paperclip issue or
injected artifact-upload context; the PR and Storybook artifact provide the
review access path.

## Live GitHub → import → execution

1. Provisioned an empty company, one authorized GitHub connection and a supported
   test agent through normal APIs. This is fixture setup, not onboarding proof.
2. Created a project and attached its repository through the real board UI.
   The background worker imported `acceptance-marker` without a second skills
   setup step. Import did not assign the skill to every agent.
3. Created a routine through the real UI and selected the stable slash mention.
   The runner read the installed skill and reference, then wrote the exact
   `project-skill-v1` marker in the task workspace.
4. Pushed a changed skill and a new skill to the configured branch. The production
   worker imported both at **23:21:03 UTC**, without Refresh, about five minutes
   after initial import.
5. Ran the unchanged routine through the UI again. The runner wrote the exact
   `project-skill-v2` marker. The earlier execution still identified its original
   immutable version.
6. Restarted the owned instance with retained data. A further real execution
   succeeded with v2. Its snapshot contained only four delivered immutable
   versions; the newly imported, unassigned skill was absent.

| Execution | Immutable project skill version | Exact output |
| --- | --- | --- |
| `2db73573-eeaf-420e-aad8-898a87377342` | `1ccdfa45-4a82-44ad-96cb-9ffa6e20fc64` | `project-skill-v1` |
| `ae685356-02a9-4369-9bb3-b76bb112bcce` | `2bd9801c-1b96-417b-b081-2867e65afdcf` | `project-skill-v2` |
| `f003baa3-37d7-4203-bd4d-a0c4b45171ca` | `2bd9801c-1b96-417b-b081-2867e65afdcf` | `project-skill-v2` |
| `e2cbfc2b-aa07-4fa0-b240-82033d6d1035` | `2bd9801c-1b96-417b-b081-2867e65afdcf` | `project-skill-v2` |
| `b91818ac-9e9a-4a98-bd6b-63c0a58e4a1a` | `2bd9801c-1b96-417b-b081-2867e65afdcf` | `project-skill-v2` |
| `83f6f277-5a4a-4814-ba55-8a7ed4a517e1` | `2bd9801c-1b96-417b-b081-2867e65afdcf` | `project-skill-v2` |

The earlier reviewed real execution passed on implementation
`614a2d1d72892128c7fc949d2485308756e7c687`. It delivered four selected immutable
versions, excluded the unassigned addition, and preserved the first run's v1
snapshot. The uploaded output was exactly 17 bytes, with the v2 SHA-256 hash in
the receipt. The model was `gpt-6.1-sol`; its successful heartbeat execution is
`b91818ac-9e9a-4a98-bd6b-63c0a58e4a1a`.

After master reconciliation, another real execution passed on
`cea9e474ba462ed9385ce2f8acb58c245585b310`. The unchanged routine completed
through the real API and supported runner; the completed task was inspected in
the browser. It wrote a fresh 17-byte workspace file matching v2 exactly, delivered
the same four immutable versions, and left the original execution on v1. Startup
checked the unchanged upstream source successfully at 11:45:25 UTC. This output
is a verified workspace file; the earlier reviewed execution also proved upload.
The new receipt and capture distinguish those two evidence paths.

Initial upstream commit: `d7e95f01903678531981ce684e721191ecb0a7da`.
Updated upstream commit: `f4b35ea0082150bda320cda7b3c0777d263bf430`.
The marker files and their SHA-256 hashes are in the receipt. These runs used
real model responses. An initial unsupported model selection failed; the agent
was corrected to the supported model before recording successful execution.

## Recovery, adoption, and access

- **Manual refresh:** the real Sources action completed without replacing skill
  identities or selections.
- **Connection failure:** disabling the disposable connection produced an
  actionable source error while retaining both installed skills. Re-enabling it
  and saving an authorized connection through the real repair dialog recovered
  updates. Reload preserved the result.
- **Legacy adoption:** an existing workspace was seeded without a binding to
  represent pre-feature data. Listing it did not import anything. The real
  **Import skills** action reused the existing repository source and skill IDs.
- **Private agent access:** a real bearer key could not list/read the private
  skill before project membership. Membership granted access; removal revoked
  it. Membership in another qualifying private project restored access.
- **Human access:** separate disposable users and real hashed bearer credentials
  passed skill, file, version, and source reads only through their qualifying
  projects. Responses omitted inaccessible project names. An unrelated company
  member received not-found responses. Revocation took effect on subsequent reads.
- **Responsible person:** an agent with project access could not read on behalf
  of an unrelated person. The same agent could read on behalf of an authorized
  project member.
- **Open/private transition:** linking through an open project made the shared
  source visible. Changing that project to private revoked the unrelated
  company member's access.

The multi-person evidence uses seeded identities followed by production bearer
middleware and APIs. It does not claim separate browser sign-in journeys. The
private GitHub repository requires the authorized owner's access for inspection.

## Automated proof

The final focused project-source suite passed **12 cases**. The source and runtime
suites passed **16 cases**. The replay-safe migration regression passed with a real
embedded database, retaining installed content, private provenance, scheduling,
and setup identities when renumbered SQL runs again.

The service and authorization suites cover transactional enqueue/rollback,
legacy edits without adoption, empty repositories, unchanged commits, additions,
exclusions, invalid siblings, source deduplication, ref changes, detach/delete,
lease competition/expiry, restart recovery, graceful shutdown, backoff/rate limits,
revoked setup access, and explicit connection repair. They also cover private
reads, forks and publication, responsible-person restrictions, immutable resume,
explicit pins, inaccessible references, and fresh local file snapshots. Known
project-derived local snapshots/materialized copies cannot become company-wide
imports. Default-branch HEAD and explicit branches retain distinct identities.
OAuth expiry and larger failure matrices use deterministic provider boundaries;
no live OAuth-expiry claim is made.

**Eleven browser journeys passed against the built Storybook artifact** on the
final implementation. They cover automatic import after project creation and
second repository attachment, empty-source guidance, legacy adoption/navigation,
background additions, refresh failure/retry, keyboard preferences, mobile touch,
connection repair/focus, repair after a concurrent update, and latest routine
execution with immutable earlier versions. Stories mount shipped pages and
components with simulated provider/import/execution data; they do not replace
the live acceptance above.

Recursive typecheck, production build, Storybook build, token gates, map checks,
and catalog checks passed after master reconciliation. The final fallback follow-up
also passed server typecheck/build and **89 pinned Node 24 cases**: scanner/source,
project worker, and both workspace authorization suites. Eleven built-browser
journeys passed again after master reconciliation. The signoff retry passed ten
browser/API cases across two runs.

The standard `pnpm test:run` phases on source d8ab984 were completed across retries:

| Phase | Passed files | Passed cases |
| --- | ---: | ---: |
| General server | 900 | 18,429 |
| UI | 729 | 8,181 |
| CLI | 66 | 527 |
| Shared | 89 | 908 |
| Skills catalog | 5 | 20 |
| Adapter utilities | 73 | 1,736 |
| Other workspaces | 130 | 2,079 |
| Database | 51 | 194 |
| Serialized server | 158 | 3,113 |

This is complete phase coverage, not a claim that one uninterrupted monolithic
command exited zero. The serialized run passed 156 files, then hit a 15-second
route-test timeout; the failed file and the last unrun file passed all 21 cases in
isolation. The final five-suite run passed all 89 cases on source
`40bafbb7a2f7753ac48765081bd2583f611cf5f2`, preserving assertions and deadlines.
Full final-head CI covers the reconciled master and subsequent corrections;
its authoritative results are linked from the PR.

GitHub CLI authentication was restored by the user. Earlier browser publication
and local source trees were identical and their histories were reconciled without
content changes. No host credentials or production data were mounted in the Linux
verifier. Review findings were fixed with regressions and resolved through the
[check-pr workflow](../../.agents/skills/check-pr/SKILL.md).

Earlier local full runs failed. macOS runs encountered database startup/hook
failures from shared-memory exhaustion and a public-MCP timeout. The first Linux
setup omitted generated SDK builds; the second lacked standard test utilities
and was stopped after that diagnosis. Those attempts are not passing evidence.
Two pre-existing login tests also assumed an x64 host. Their intended native
and legacy platforms are now explicit, and all 13 login cases passed on ARM64.
The subsequent 2 GB heap run exited unsuccessfully: 18,422 tests passed,
76 skipped, and one worker aborted from JavaScript heap exhaustion in the
existing setup-token route suite. Its 30 cases passed with an explicit 4 GB
heap. With the 4 GB heap, all 900 server files passed: 18,429 tests passed and
76 skipped. The UI group then reported 8179 passed and one failure. The reset
reproduced in isolation; its editor now holds accepted selections until parent
data refreshes. Both focused UI suites passed all 38 cases. Subsequent phase completion and final focused verification are recorded above.
The final Linux run uses Node 24, built workspace dependencies, pinned Rust,
and the standard process, shell, SSH and JSON test tools in an isolated container.
No host credentials or production data are mounted.

The ownership-checked acceptance cleanup passed: runtime, loopback port 3107,
and its embedded database stopped cleanly; disposable data and evidence remain
retained. All owned Storybook previews and the temporary reconciliation checkout
were removed after their captures and verification logs were preserved.

## Experience review and limitations

Manual real-app inspection covered mobile, intermediate and desktop in both
themes. Storybook inspection included long names, validation warnings, empty and
paused sources, retained removed skills, private project unions, and an 80-skill
list. The list had no horizontal overflow and its footer was keyboard reachable.
A cramped provenance layout, missing repair focus return, and blank simulated
routine section were found, fixed and covered by regression journeys.

The final concurrent-repair story also passed manual inspection at 390px in dark
mode. The selected account remained checked after a 409, its error and footer
fit on screen, keyboard retry succeeded, and focus returned to source actions.
The shared task-defaults editor was also inspected after saving on mobile in dark
mode: the acknowledged selection remained visible and Save became disabled.
Sampling does not claim interaction coverage for all **27 new exports**. No Linux
screenshot baseline was compared or updated.

The existing Storybook deployment workflow published commit 5869973 in run
38394544972, including the sixth real execution receipt and final task capture.
Subsequent fallback changes affect server code; shipped UI and story sources remain
identical to this published build:
[review guide](https://github.com/paperclipai/paperclip/blob/586997352198b2dbf025445706762e27d38e6764/ui/storybook/stories/skills/project-repository-skills/README.md),
[project creation](https://d1p6rlowie26tp.cloudfront.net/storybook/branches/codex-project-repository-skills-8ad0b8be51ae75bc/builds/38394544972-1/?path=/story/skills-project-repository-skills-02-journeys--create-project),
[repair retry](https://d1p6rlowie26tp.cloudfront.net/storybook/branches/codex-project-repository-skills-8ad0b8be51ae75bc/builds/38394544972-1/?path=/story/skills-project-repository-skills-02-journeys--repair-conflict).
Published deployment metadata and story IDs were verified over HTTP. The in-app
browser blocked CloudFront navigation, so hands-on inspection used the identical
local built artifact. No browser security warning was bypassed.

## Inspectable captures

Real isolated Sources page:

![Real Sources page](../../ui/storybook/public/project-skills-evidence/sources-desktop.jpg)

Shipped mobile repair dialog with Storybook fixtures:

![Mobile connection repair](../../ui/storybook/public/project-skills-evidence/connection-repair-mobile.jpg)

Real completed routine execution:

![Real routine execution](../../ui/storybook/public/project-skills-evidence/routine-execution-final.jpg)

## Review fixes

Initial-import and scheduled-refresh queries exclude live leases before bounding
batches. A real database regression places ten leased records ahead of eligible
work and verifies import and refresh still proceed. Connection repair derives
its source from the current query and reloads the revision after a conflict while
retaining the chosen account. Runtime-test teardown drains tracked execution
writes before truncation, resolving a reproduced database teardown deadlock.

![Mobile concurrent repair](../../ui/storybook/public/project-skills-evidence/repair-conflict-mobile.jpg)

The final review identified an oversized-repository refresh that could drop shared
dependencies. Repository sources retain installed versions when fallback would omit shared
files; safe self-contained packages can still update. Initial and subsequent project fallback scans reject detected omitted
dependencies. Project sources automatically restore complete packaging when it fits. All 56 scanner
and source-service cases passed, including manual and scheduled oversized refresh,
retained shared/sibling files, unchanged versions, and recovery after size reduction.
The signoff fixture retry also passed ten real browser/API cases across two runs.

Environment retries also preserved the original failures: a telemetry opt-out
variable conflicted with a mocked CLI test; Docker overlay storage affected probe
identity tests; a native temporary mount initially disallowed execution; and an
oversized stream fixture failed under that mount. The normal-storage cases and
all 56 probe cases on an executable native temporary filesystem passed. A later
host rerun used Node 26 and hit database/subprocess timeouts. The pinned Node 24
run passed the unchanged audit deadline, project suites and authorization cases.
No assertions or timeout thresholds were relaxed to obtain these results.

## Final source-removal integration

Integrated master’s keep/delete choice with project provenance. Removed project
sources retain an internal access identity, invalidate refresh and attachment leases,
and stop tracking. Kept copies and forks remain dynamically restricted. Ordinary
reattachment retains removal; explicit adoption restarts tracking. The rebuilt Storybook passes all 13 interactive project-skill browser cases, including
kept-copy access wording and cancelled removal; the Sources UI/API suites pass 21
cases. The initial Linux pass exposed two harness mismatches: source authorization
now precedes request validation, and repository skill instructions use a wrapper.
Both assertions retain their intended contract with corrected fixture setup/file
paths; the final service pass and current PR checks are recorded on PR #16066.

## Final review corrections

The security review’s per-revision approval recommendation conflicts with the
approved automatic/latest behavior. The response records repository-author trust,
per-refresh credential/access/policy revalidation and the manual-update option.
The scanner subsequently passed. Greptile then identified two concrete defects:
legacy adoption without a saved source ID did not restore removed tracking, and
Codex’s reused home could retain a revoked private skill link. The initial correction resolved the removed repository/ref; the final privacy
review superseded reuse with separate active tracking identity, described below. Codex launches against a
home scoped to its permitted immutable inventory, including an empty inventory,
with the selected credential source preserved. Three Codex launch/injection/sync
suites pass 32 cases; final service and real-provider results are recorded on the PR.

Post-review verification passed 212 cases across 13 pinned Node 24 suites,
plus the full typecheck and build. A fresh real ACP routine execution (`PRO-7`,
`95d14fcf-5643-4d5f-9512-d160efcb2446`) delivered four pinned versions and
reported the v2 marker. The CLI probe exposed the host’s old Codex 0.153.4
client: both requested models were rejected before model work. The repository
already pins Codex 0.160.0. With that client and the original `gpt-6.1-sol` model,
`PRO-9` succeeded in run `d94d7009-8787-4483-81e4-71ec0b512ed6`, marked its
task done, and independently verified the existing 17-byte v2 evidence file
without rewriting it. Its invocation used `skill-runtimes/<agent>/<inventory digest>`;
the selected account remained usable. The v1 execution still identified version
`1ccdfa45-4a82-44ad-96cb-9ffa6e20fc64`. Eight successful execution receipts
now distinguish newly written files from provider-reported or preserved outputs.
Failed probes are recorded separately. The disposable agent’s original settings
were restored and the superseded probe task was cancelled.

The live walkthrough also reproduced a withdrawn AI connection request still
showing an active “Fix connection” action after a successful task. A failing
regression test captured it. Withdrawn requests now use the existing terminal
card renderer; 70 interaction/Sources UI/API cases pass. A production-component
Storybook state and a narrow light-theme browser case preserve this recovery state.

The final compatibility review also found provider settings skipped for generated
Codex homes. A launch-level regression failed for both default and explicit
credential homes. Provider settings now apply to generated skill homes while
caller-owned homes remain untouched; the three Codex suites pass 33 cases.

Final qualification passed 213 service/runtime cases on pinned Node 24, 70
interaction/Sources UI/API cases, and 14 rebuilt Storybook browser journeys.
Typecheck, build, token gates, maps and catalog checks passed. The restarted
real app on source `c9a5897bb0843ee5ac89ee0bb9210ca864d6ceca` shows the
withdrawn request as inactive after reload, alongside the completed CLI result.
The updated CLI capture records this corrected recovery state. Final head checks
and merge status remain authoritative on the PR.


The final retained-content privacy correction separates tracking from provenance.
After removal, adoption creates or joins an active source; it never adds readers
to the removed source holding editable copies. Forks capture the originating
project set independently, so later open-project attachments cannot expose private
local edits. Membership, project visibility and deletion remain dynamic. Generated
migration 0341 makes source identity uniqueness apply only to active rows. The
regression matrix covers public re-adoption, direct private file/version denial,
private fork preservation, original-workspace adoption, and membership revocation.

Final qualification of the retained-audience correction (`4f7df5e683`) passed
232 tests across 14 pinned Node 24 suites. One scanner subprocess deadline failed
under concurrent build/install load; the unchanged full batch passed on retry.
The 37 source/privacy cases also passed on macOS. Final typecheck and production
build passed after installing two test dependencies added by concurrent master.
Repository policy leaves lockfile publication to its scheduled refresh bot; no
lockfile change remains in this PR. The rebuilt artifact passes all 14 interactive
browser cases. Maps, token gates and catalog tests pass; the catalog inventories
227 files and 2,252 stories without claiming all were rendered. Application and
preview processes owned by this task were stopped with their evidence retained.
Current-head GitHub checks and review results are recorded on the PR.

The final catalog review found stale immutable versions after installed catalog
bytes changed. A reference-only update regression failed before the fix. New
unpinned executions now compare installed catalog files, as they already did
for local files, without network fetching; unchanged content reuses its version
and pinned resumes preserve the old bytes. The runtime/catalog suites pass all
17 cases. This final correction changes no UI; the published Storybook build
38427815861 pins 6219538f75 and contains all eight successful execution receipts
and the two explicitly classified old-client failures.

A fresh review then identified a removal/import race and stale account selection
in generated Codex homes. Both were reproduced before correction. Final source
linking locks the source before the binding, follows removal's lock order, and
rechecks removal and the binding lease. A losing import retries with independent
tracking; it never adds readers to retained edits. Generated homes now include
the selected subscription account and credential source in their digest. Switching
accounts uses a new home; same-account token refresh keeps the home. The regression
uses a regular credential file to model remote copy-back. The source/Codex suites
pass 71 cases, and recursive typecheck and production build pass. These are
deterministic race and launch tests; they do not claim another live model run.

The final default-account follow-up reproduced a mismatch between host and
company credentials: hashing the host source while seeding the saved company
login could reuse a previous account's generated home. The digest now reads
the same prepared company or explicitly selected home used for seeding. The
default-company switch regression fails before correction and passes afterward.
All 33 Codex launch/injection/sync cases and recursive typecheck pass. The
source-removal correction passed fresh review; final CI/review results remain
recorded on the PR. No extra live-provider result is claimed for this correction.

The final security scan identified API-key imports persisting a responsible user
as unattended refresh authority. Direct imports now share project attachments'
setup resolver: API keys retain attribution without a setup person; authenticated
runs derive the person from the persisted active run. Legacy recovery cannot
restore deliberately absent API-key authority and accepts agent attribution only
with a matching recorded run. With valid membership fixtures, both API-key
regressions fail on the previous route setup and pass after correction. All 101
affected route/source/database cases pass, including scheduled repair and legacy
audit recovery. Recursive typecheck and production build also pass. Current-head
security and CI results are recorded on the PR.

Final master reconciliation includes `da9af6741585aeb439b5d38af398eab841131d6e`.
Master added migration 0339, so the unmerged feature migrations were regenerated
through `pnpm db:generate` as 0340 (project tracking), 0341 (retained source removal)
and 0342 (active-source identity indexes). Their replay-safe SQL preserves installed
content and provenance. Migration numbering/safety and five-snapshot retention
pass. All 151 affected source, authorization, catalog-version and Codex cases
pass across eight suites on the merged checkout, along with recursive typecheck,
production build, maps, catalog and token gates. Inherited budget/secret review
sources retain their prior classifications; no extra provider proof is inferred.

The final merged Storybook build succeeds and all 14 project-skills browser
journeys pass against it. This includes the inherited shell updates; no Linux
visual baseline comparison is claimed. Final publication and current-head PR
gates are recorded on the PR.

CI caught a stale replay-test filename after regeneration. The test now opens
0340_salty_vance_astro.sql; its preservation assertions remain unchanged. The
wider macOS Node 26 database run hit eight unrelated native PostgreSQL deadlines.
The qualified Node 24 rerun passed all 51 database files and all 195 tests, with
no skips or changed deadlines. Its input records e3b107976f plus the one-line
fixture correction and the corrected fixture hash. This supplements the 151
merged service/runtime cases and 14 rebuilt browser journeys. Final PR checks
remain the authoritative merge record.

The last concurrent catalog merge integrates master 252d9b5077. Its background
trace-context and runtime-skill suites pass all 12 cases; recursive typecheck
and build pass. Feature controls and fixtures are unchanged from the 14-case
built-browser qualification. The verification inventory now records 59 remaining
gaps and preserves variable-dialog and production obligations for the partially
covered routine-run journey. Catalog/map checks pass without treating source
classification or test presence as additional execution proof.

The final resource review adds generated migration 0343 and durable automatic
refresh credits: unchanged Git trees require no download, including empty commits;
512 MiB of scan/download allowance refills per hour, with conservative reservations
and refunds for small repositories. Manual Refresh remains available. Initial
imports admit 20 jobs per project and 100 per company; overflow remains durable
and is admitted as capacity frees. Repository attachment requires workspace-write
permission, and skill-import policy is checked before provider reads. Policy denials
stop automatic retries until an explicit repair/adoption. These changes passed
all 61 qualified Node 24 files and 397 tests without skips or deadline changes.
The final PUT-route and legacy-tree-learning follow-up passed all 48 affected
cases; recursive typecheck and production build pass afterward.

The final running checkout (32c5cdc4ee plus the recorded PUT-route/tree-learning
follow-up) also passed isolated runtime doctor. Through the real board UI at
127.0.0.1:3107, a new disposable project was created without repositories, then
the approved private acceptance repository was attached through Configuration.
The saved workspace persisted after reload. Sources showed both skills imported
automatically under the new default-branch source without Refresh or adoption.
The earlier projects track main explicitly, so their existing source and versions
remain independent. The picker warned that another connection could not load;
the selected Acceptance GitHub connection successfully listed and attached the
repository. This is an additional real attachment check, not another model run.
The screenshot is retained in the inspectable evidence gallery.

A later master merge introduced 0340_open_warlock. All unmerged feature schema
changes were regenerated together as 0341_abnormal_bucky through pnpm db:generate,
with the same preview replay safeguards and five newest snapshots. Agent setup
now pins only a GitHub connection/grant already authorized in the persisted active
run identity. Responsibility remains attributable but does not authorize searching
the person's other connections. Missing run selection and legacy agent sources
require an explicit human connection repair before unattended reads.

Final-head 684105f683 passed all 402 qualified Node 24 cases across 62 files
and all 14 rebuilt browser journeys; CI and security also passed. Greptile then
reported a deferred-admission/detach race and stale generated Codex settings.
Both regressions failed before correction. Admission now conditionally updates
only still-pending, capacity-waiting bindings with a workspace. Generated homes
include selected config.toml content in their identity, so edits and removals
reach the launched process without carrying old private inventory. Focused
verification and fresh final-head review are recorded on the PR.

Both final review fixes pass all 54 affected worker/Codex cases, recursive
typecheck and production build. Master c7f4b74111 changed workspace preparation
and its catalog notes; the catalog conflict preserves both sets of stable IDs
and classifications. Its affected workspace tests and final CI/review are
recorded on the PR. No new feature canvas or provider run is inferred from
this source reconciliation.

A subsequent queue review reproduced two database failures: adoption held the
binding while waiting for the company lock, and 100 deferred rows from a full
project hid another project's work. Both regressions fail on the previous head.
Adoption now captures run identity and takes the company queue lock before
source/binding locks, reusing that validated setup while enqueueing. Admission
excludes full projects before its bounded waiting-row selection. Verification
and current-head gates are recorded on the PR.

The final initial-import resource finding is corrected with durable company
credits, reserved before provider work. The failing-download regression observed
five reads before correction instead of the allowed four. New cases cover
worker recreation/refill, small-import refunds and completed large measured
jobs retaining their charge. These are simulated download sizes with real DB
transactions, not new oversized live downloads. Generated migration and final
qualification results are recorded on the PR.

The initial-budget commit passes all 251 qualified Node 24 database/source/setup
cases across 54 files. The final refill review reproduced a backwards timestamp
from interleaved older/newer sweeps. Both initial-import and source-refresh
reservations now clamp time to the persisted budget timestamp. The real database
regression fails before correction and verifies no repeated refill afterward.
Focused final verification and current-head CI/review are recorded on the PR.

Qualified Node 24 reproduced the earlier timestamp assertion failure, then passed
all 57 affected cases on the corrected source with no skips or deadline changes.
The macOS reproduction timed out in native DB setup; its broader attempt hit a
privacy-test deadline. Those failures are retained separately from the qualified
pass. Recursive typecheck and production build pass after the correction.

Final head 0fa7fd008b passed fresh security and Greptile 5/5; tests completed
without failures before another master merge introduced a catalog conflict.
Master 7eea9d8214 moved Storybook metadata into each story and made generated
indexes ignored. The two project-skill suites now carry their existing capability
associations, production/fixture classification and durable limits inline, keeping
all explicit meta IDs and exports. Both feature recipes and master's verification
sections are retained. The deleted aggregate catalog/review ledger stays deleted.
Map/generator validation passes; rebuilt browser and final-head gates are recorded
on the PR. This structural migration is separate from the earlier live receipts.

The final catalog-merge CI attempt lost eight jobs to the same runner shutdown;
the logs show cancellation rather than failed assertions. Greptile separately
reproduced adoption restoring a stale workspace selection. Adoption now shares
the editor's root-provenance/project/workspace lock order, re-reads the selected
repository, rechecks project access and rejects a changed selection before queue
mutations. Its real edit-interleaving regression fails before correction. Final
focused results and fresh CI/review are recorded on the PR.

The stale-adoption correction passes all 61 affected Node 24 cases across four
suites with no skipped tests or changed deadlines. The macOS broader attempt
timed out starting two native databases; it did not establish a code failure.
Recursive typecheck and production build pass. The final rebuilt Storybook
publication 38464595162 pins 60537b0695 and contains all eight live receipts;
the adoption-only correction leaves its controls and fixtures unchanged.
