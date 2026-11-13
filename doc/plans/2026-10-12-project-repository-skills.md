# Project repository skills

## Finish line

Deliver automatic imports and five-minute refresh, project-derived visibility,
latest-version execution with immutable execution snapshots, legacy adoption,
production UI and Storybook coverage. Completion requires passing repository
checks, a live GitHub-to-routine update journey and a reviewable PR with evidence.

## Decisions

- Track the configured project branch, defaulting to GitHub's default branch.
- Import future skills unless excluded. Existing manually imported sources keep selections.
- Refresh using the setup person's existing authorized GitHub connection.
- Access through any originating project is sufficient; evaluate current project ACLs.
- Retain installed versions and project provenance after detach or upstream removal.
- New executions use latest installed versions; resumed executions keep their snapshot.
- Legacy projects adopt explicitly. Existing imported sources update automatically.
- Advanced reference pin UI and GitHub push webhooks are deferred.

## Current qualification — 2026-10-13 UTC

Implementation and live acceptance passed, including upstream updates, private
access/recovery matrices, eleven rebuilt browser journeys, responsive inspection
and a final real v2 execution after master reconciliation. All standard local test
phases completed across documented retries. The final safe-fallback correction
passed 89 pinned Node 24 cases and server typecheck/build. Project fallback retains
shared dependencies, permits safe package updates and restores complete packaging
when the repository fits. Final review/check results and authorized merge state
are recorded on PR #16066; only its exact green head may be merged.

GitHub CLI authentication was restored by the user. Local and browser-published
histories were reconciled with an unchanged, identical tree. Final-head checks
must pass before merging. Merge is already authorized; no further merge
permission is needed.

The temporary reconciliation checkout and obsolete previews have been stopped
and removed. Final local acceptance data and evidence are retained. See the
[acceptance report](2026-10-12-project-skills-acceptance.md) for current outcomes
and limits. The process notes below are historical and do not supersede this
checkpoint.

## Historical progress

- Repository implementation and verification paths inspected; worktree started clean.
- Persistence, attachment jobs, background checks, manual refresh, project access, runtime snapshots and Sources UI implemented; integration review remains.
- Initial preview migration was `0336_lovely_bloodstorm.sql`; master reconciliation replaces preview migrations with replay-safe generated `0341_abnormal_bucky.sql`.
- Focused source persistence tests passed (13 existing cases); new project source tests passed (3 lifecycle/access cases).
- Source API/UI regression tests passed: 69 tests. Runtime-skill regression suite also passed.
- UI/server direct TypeScript checks passed after building workspace dependencies; repeat after latest changes.
- Token gates passed. Storybook build passed.
- Storybook Playwright journeys passed: legacy adoption/navigation, automatic additions, failure/retry, preference keyboard behavior and mobile overflow (5 tests).
- Manual Sources review completed in IAB; fixed cramped intermediate-width action layout. Project creation and routine Storybook walkthroughs remain.
- GitHub account `cryppadotta` authenticated. Claude and Codex CLI sessions authenticated; no model API key in environment. Live test must use an authorized existing CLI session or connection.
- Live GitHub acceptance, expanded permission/worker/runtime coverage, required full checks and PR handoff have not run.

## Current process/evidence pointers

- Branch: `codex/project-repository-skills`; checkout `/Users/dotta/.codex/worktrees/4631/paperclip`.
- Owned Storybook: `http://127.0.0.1:6187`, exec session 14926. Port 6007 belongs to another process and was not changed.
- IAB tab 1 shows the full Sources journey; browser binding 4. Preserve/reuse the binding when continuing.
- Runner dependency build completed; exec session 59507 was its build handle.
- Logs in `/private/tmp/project-skills-*.log`; browser screenshots under `tests/storybook-visual/test-results/` (ignored).
- Full feature remains the finish line. Next: expand authorization/runtime tests, inspect project/routine journeys, launch isolated live instance and complete GitHub update execution acceptance.

## Verification

Source/worker lifecycle and failure tests; authenticated human/agent access matrix;
runtime latest/resume tests; Storybook browser journeys and responsive review;
live disposable GitHub repository and supported runner; token/map gates, Storybook
build, recursive typecheck, Vitest and production build. Record actual results here.

## Live acceptance progress (2026-10-12)

- Created the project and attached the disposable private GitHub repository through
  the production browser UI. The worker imported `acceptance-marker` without an
  import action. No agent assignment was added automatically.
- Created a routine through the UI with a stable skill mention. The real
  `codex_local` runner (`gpt-6.1-sol`, existing ChatGPT CLI login) completed it and
  wrote the exact first marker from the installed skill reference file.
- Pushed an updated marker and a new skill. The production worker imported both
  at 23:21:03 UTC, without Refresh, about five minutes after initial import.
- Ran the unchanged routine through the UI again. The runner wrote the exact
  updated marker. The first successful run retained version
  `1ccdfa45-4a82-44ad-96cb-9ffa6e20fc64`; the second selected
  `2bd9801c-1b96-417b-b081-2867e65afdcf`.
- A real agent bearer key could not list/read the private skill before project
  membership (404), and could after membership (200). Removing membership revoked
  access. Granting membership through a second private project restored access;
  its source response exposed only that accessible project's name. Both projects
  reused one source and the original skill identity.
- Restarted the owned instance with its retained data and latest source changes.
  Doctor passed for PID 40476 at `http://127.0.0.1:3110`; source links, installed
  skill identities and selections persisted.
- Manual refresh succeeded. Disabling the disposable GitHub connection produced
  a clear source error while retaining both installed skills. The connection was
  restored; the browser connection-repair journey is in progress.
- Initial provider setup attempted an unsupported model (`gpt-5.4`); corrected
  the disposable agent to the supported model before claiming live execution.
  Agent provisioning was an API fixture. Project/routine creation and execution
  used the real UI. No synthetic model response was used.

Evidence directory: `/private/tmp/paperclip-project-skills-proof-BGunNG`.
Non-secret records include `fixture.json`, `execution-v1.json`,
`execution-v2.json`, marker files, `automatic-update.json`,
`private-agent-access.json`, `private-union-access.json`, `connection-failure.json`
and `execution-v2.jpg`. The separate test key file is credential material and must
not be published or attached.

## Latest verification and remaining work

- Live legacy adoption reused the existing source and skill IDs. Listing the older
  repository did not import it. The real Sources action performed adoption.
- Seeded disposable human identities and real bearer authentication passed direct
  skill/file/version/source checks. Access through either project worked. Removing
  membership revoked access. Agent responsible-user mismatch failed closed.
  This is API identity proof, not a multi-person browser sign-in test.
- Linking the repository through an open legacy project made its skills visible.
  Changing that project to private revoked access for the unrelated company member.
- Real UI connection repair persisted after reload and kept installed selections.
- Current instance restarted at http://127.0.0.1:3109 (owned PID 73371). Startup
  applied migration 0337. Doctor passed. The unchanged routine produced the exact
  v2 marker again in successful run f003baa3-37d7-4203-bd4d-a0c4b45171ca.
  Its snapshot includes four selected immutable versions and excludes the new,
  unassigned project skill. Older execution version evidence remains unchanged.
- Recursive typecheck, production build, Storybook build, maps and token gates
  passed. Six browser journeys passed against built Storybook (no retries).
- Latest focused server/UI check passed 94 tests. Worker/startup check passed 44.
  The isolated recovery test passed. A GitHub review fixture was corrected to admit
  a new event before checking changed configuration; that focused test passed.
- Full suite is running in exec session 45645, log
  /private/tmp/project-skills-final-full-suite.log. Observe this exact handle.
- Manual mobile review found cramped provenance names. Source headings now use
  the full narrow-screen width, with actions below. Token/UI checks are rerunning.
  Desktop, intermediate and mobile real-app light captures and mobile dark capture
  are in the evidence directory. Finish both-theme Storybook and recovery-dialog
  review before final handoff.
- Still required: final full-suite result, remaining requirements audit, final UI
  build/browser verification, sanitized inspectable acceptance report, commits,
  rebase and template-compliant PR/review handoff.
- Owned current server session 94907; development Storybook 14926; built static
  Storybook 34961 (6188). Preserve ownership and use the stop helper for cleanup.

## Rebased checkpoint — 2026-10-12

- Implementation is in four logical commits on `codex/project-repository-skills`,
  rebased onto master `4b958ecbd8`. Current committed head is `afc5f22a0c`.
- Master added the downstream Storybook catalog. The new suites now live in the
  Skills feature home, with explicit stable IDs preserving every existing URL.
  Shared simulation lives in `ui/storybook/support/projectRepositorySkills.ts`.
  Catalog structural checks passed (225 files / 2,235 stories) and nine catalog
  tests passed. Existing source dependency records preserve their classifications.
- Post-rebase recursive typecheck, production build, Storybook build, map/token
  gates and all six built-browser journeys passed. No Linux visual baseline was
  compared or updated.
- The earlier full-suite process was stopped before rebase. The authoritative
  post-rebase full suite is exec session 12928, log
  `/private/tmp/project-skills-rebased-full-suite.log`. It is live; do not restart
  it because output is quiet.
- The owned instance restarted at `http://127.0.0.1:3110`, PID 71855, server
  session 62515, and Doctor proved committed head `afc5f22a0c` with ready UI/API.
  Its retained source, skill identities, routine and execution history persisted.
- Manual mobile connection repair passed via keyboard. A missing focus return
  was observed after saving; the UI now returns to the source actions button.
  Its eleven focused UI tests and UI typecheck passed. The updated Storybook
  build is session 73545 and must be followed by the browser focus assertion.
- Keep the full objective active. Still required: final suite result, complete
  requirements audit, remaining theme/state review, acceptance evidence handoff,
  template-compliant PR and review/check loops. No PR has been opened yet.

## Review fixes and evidence checkpoint

- PR #16066 is open in draft and attached to the Codex task. Initial CI passed;
  Greptile requested fixes for API-key repository creation, default-branch tracking,
  local file version freshness, and missing screenshots.
- API-key agents can attach repositories without an authenticated run. Their jobs
  retain no invented setup person. Default-branch bindings preserve HEAD, separate
  from fixed branches. Fresh unpinned local executions capture changed installed
  files; resumed/pinned executions keep their immutable selections.
- A local-import path was proved to discard private snapshot provenance. It now
  rejects known private snapshots/materialized copies as company-wide imports,
  with an opaque not-found response for unauthorized readers.
- All 27 focused source/runtime tests passed after these fixes. Six browser cases
  passed with real emulated touch taps, keyboard controls and repair focus return.
- The first post-rebase full run finished: 17,961 passed, six failed. Two failures
  used pre-review module implementations alongside added tests. Four other cases
  timed out or lost an HTTP/database connection and are being rerun in isolation.
  Final qualification must use a fresh full run on the frozen reviewed code.
- The approved initial Storybook preview published through the existing CODEOWNER
  workflow. Its immutable build is 38329548539-1 for commit 3e82dada92. Publish the
  reviewed head before handoff. Acceptance screenshots and minimized execution
  receipts are now in ui/storybook/public/project-skills-evidence/ for the existing
  Storybook artifact workflow. No credential or identity key files are included.

## Reconciliation checkpoint — 2026-10-12 evening

Master integration preserves the durable task-workspace changes alongside project skill authorization and execution snapshots. The regenerated migration follows master's 0338 and its real database replay regression passed. Recursive typecheck and production build passed in the temporary reconciliation worktree. Ten focused Storybook journeys passed, including project creation, second repository attachment and immutable simulated routine revisions. Final built-artifact checks, full-suite qualification, updated PR review and a current implementation acceptance run remain.

The reviewed-head full run ended with 17,687 tests passing, two failing, 383 skipped and 18 failed files. Database startup errors identify host shared-memory exhaustion; public MCP also timed out. This is a failed run, not completion evidence. The owned acceptance server was stopped after recording successful reviewed-head run e2cbfc2b-aa07-4fa0-b240-82033d6d1035, and its data/evidence remain available.

The user authorized merging once final PR checks pass. Do not merge an incomplete or conflicting head.
