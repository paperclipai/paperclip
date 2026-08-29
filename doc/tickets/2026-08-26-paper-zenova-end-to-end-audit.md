# Paper Zenova end-to-end audit

Date: 2026-08-26
Environment: `https://paper.zenova.id` (production), followed by `https://paper-dev.zenova.id` (staging)
Method: read-only navigation and network inspection with `agent-browser` 0.27.0, plus source and route-registration audit. No production records were changed.

## Executive summary

The production UI was running a server/UI revision that had several user-facing route modules present in the repository but not mounted in the application. This made the organization switcher, cycles, improvement suggestions, authenticators, GitHub connections, and company MCP settings fail or remain loading. The initial production sweep also exposed two sidebar URLs—`/SIX/tasks` and `/SIX/work-overview`—that rendered the app's `NOT FOUND` page because only their newer canonical routes were registered. The live quota panel also exposed the provider's raw abort error during a slow OAuth usage request. Issue `SIX-6013` contains a comment claiming that a screenshot was attached, but the browser frame was ephemeral and no durable attachment was uploaded.

The candidate patch mounts the missing routes, keeps organization-management URLs global, restores the browser profile/live-stream contracts, extends quota provider polling to 20 seconds with an explicit timeout error, hardens issue deletion around issue-owned dependencies, restores the sidebar's task/work-overview aliases, and adds regression coverage. The existing candidate issue-comment attachment enrichment is retained so future uploaded files are shown beside their comment.

## Findings

### A1 — Organization switcher is non-functional in production

Severity: P1
Status: fixed and validated on staging.

Evidence:

- On `/SIX/dashboard`, the organization button rendered `Select organization` and its menu rendered `No organizations`.
- The browser recorded repeated `GET /api/organizations?includeArchived=true` responses with HTTP `404`.
- `server/src/routes/organizations.ts` existed, but `organizationRoutes` was not mounted by `server/src/app.ts`.
- The client route classifier also treated `/organizations` as company-scoped, which could turn the manage link into `/SIX/organizations`, even though the route is global.

Candidate changes:

- Mount `organizationRoutes(db)`.
- Add `home` and `organizations` to the global route roots.
- Add route-classification regression coverage.

Acceptance check on staging:

1. The organization button loads the organization list without a 404.
2. Selecting another organization changes the selected organization and lands on a company belonging to it when applicable.
3. “Manage organizations” opens `/organizations`, not `/<company-prefix>/organizations`.

### A2 — Several company settings/work surfaces call unmounted APIs

Severity: P1
Status: fixed and validated on staging.

The production browser saw these failures:

| Surface | Request | Observed behavior |
| --- | --- | --- |
| Cycles | `GET /api/companies/:companyId/work-cycles?includeArchived=true` | `Loading cycles...` remained visible; HTTP `404` |
| Improvement suggestions | `GET /api/companies/:companyId/improvement-suggestions` | page shell rendered without its data; HTTP `404` |
| Authenticators | `GET /api/companies/:companyId/authenticators` | form rendered but existing records could not load; HTTP `404` |
| GitHub settings | `GET /api/companies/:companyId/github-connections` | connection data unavailable; HTTP `404` |
| Company MCP | `GET /api/companies/:companyId/mcp-servers` | company MCP data unavailable; HTTP `404` |
| Notifications | notification route module was present but unmounted | source-confirmed; staging request validation required |

Candidate changes mount the corresponding route modules and export `workCycleRoutes` from the route barrel.

### A3 — Quota panel intermittently reports a misleading abort error

Severity: P1
Status: fixed and validated on staging.

The configured Codex OAuth credential was valid. A quota refresh initially returned the raw message `This operation was aborted`, then succeeded after a later refresh. The provider request helper used an 8-second abort timer; the same endpoint completed successfully in about 1.1 seconds when retried, indicating a transient slow-provider/request-window problem rather than invalid credentials.

Candidate changes:

- Increase the Claude and Codex quota fetch timeout to 20 seconds.
- Convert an abort caused by the local timeout into an explicit provider-timeout error.
- Normalize abort-shaped errors at the API boundary and preserve the last successful sample when one exists.
- Add adapter and route regression tests.

Acceptance check on staging:

- A valid OAuth credential never displays the raw abort exception.
- A slow request displays a clear timeout state and the last successful sample when available.
- A successful refresh displays live windows and does not mark the credential unavailable.

### A4 — Screenshot claimed in `SIX-6013` was never durably attached

Severity: P1
Status: historical evidence cannot be recovered; future-flow guardrail added.

The comment at [SIX-6013](https://paper.zenova.id/SIX/issues/SIX-6013) says “Screenshot attached” but describes a managed-browser frame. Read-only checks returned:

- `GET /api/issues/SIX-6013/attachments` → `200 []`
- `GET /api/issues/SIX-6013/work-products` → `200 []`
- `GET /api/issues/SIX-6013/live-runs` → `200 []`
- The comment row had `attachmentCount: 0` and no attachment metadata.
- The issue page contained no screenshot card; only avatar images were present.

Root cause: a live-browser frame is an ephemeral run artifact. The frame was not uploaded through the issue attachment/artifact API, so it disappeared when the run ended. The screenshot cannot be reconstructed from the stored issue data.

Candidate changes:

- Clarify the browser automation skill: live frames must not be described as durable attachments; retained screenshots require an upload followed by an attachment lookup confirmation.
- Retain the existing issue-service enrichment that resolves direct and Markdown-referenced uploaded attachments onto comment rows, with regression coverage.

Acceptance check for a future retained screenshot:

1. Capture a redacted image.
2. Upload it to the target issue and require HTTP `201`.
3. Fetch the issue attachments and verify the returned attachment ID/content path.
4. Only then describe the screenshot as attached.

### A5 — Browser profile and live-session contracts were missing from the server

Severity: P1
Status: fixed and validated on staging.

The browser UI calls company browser-profile, browser-filtered live-run, browser-stream, and browser-activity endpoints. The `browser-stream` service existed in the repository, but the corresponding routes were absent from the server route module on the candidate base. That left the browser page unable to load its profiles or live sessions reliably, and left the live preview without a server stream contract.

Candidate changes:

- Restore company browser-profile list/create/assignment/delete routes with company authorization and activity logging.
- Restore browser-only live-run filtering and issue/task scope fallback for legacy runs.
- Restore the per-run browser SSE stream and activity marker endpoints with agent ownership checks.
- Ignore stale issue-scoped frames from an earlier run, bound frame reads to 5 MiB, and require JPEG framing before publishing an SSE frame.
- Add browser stream and live-run regression coverage.

Acceptance check on staging:

1. `/SIX/browsers` loads without an API route error and can open the Profiles panel.
2. Browser profiles and project assignments return HTTP `200` for the selected company.
3. Browser-filtered live runs return HTTP `200`; an empty result is presented as an empty state, not a failure.
4. A live run can expose its stream only to the owning agent or board operator, and a fresh frame marks browser activity.

### A6 — Dev deployment source was pointed at a stale branch

Severity: P1
Status: corrected operationally; CI hardening remains.

The Dokploy `paperclip-dev` compose was configured to build `deploy/paper-dev-20260825-credential-routes` while the candidate was being pushed to `dev`. The CI deploy job queued a deployment but did not wait for rollout or verify the served bundle, so a successful deploy trigger could still leave the old revision live.

Action taken:

- Changed the `paperclip-dev` Git source branch to `dev`.
- Manually deployed the candidate and verified the served root bundle changed to the candidate build before browser validation.
- Kept production untouched during the stale-branch investigation; it was promoted only after the corrected candidate passed staging.

Follow-up:

- Make the deploy job wait for a healthy rollout and verify a revision marker or immutable asset before reporting deployment success. The public health response currently returns `commit: null`, so the bundle/source evidence must remain part of the release check.

### A7 — Issue deletion returned an internal error in staging

Severity: P2
Status: fixed and validated on staging.

Evidence:

- During candidate validation, temporary Epic `SIX-85` and child `SIX-86` records were created in `paper-dev`, completed through the UI, and then hidden after testing.
- An authenticated `DELETE /api/issues/SIX-86` returned HTTP `500 {"error":"Internal server error"}`.
- A follow-up `GET /api/issues/SIX-86` still returned HTTP `200`, so the delete did not complete. The same behavior was seen while attempting to remove the temporary parent record.

Impact: operators could not reliably remove an issue that was created accidentally or solely for a test, and the generic response gave no actionable reason. The failure was caused by restrictive foreign keys on issue comments, read states, inbox archives, thread interactions, feedback votes, and durable usage records that were not handled by the delete service. The test records were hidden as a reversible cleanup step while the fix was implemented.

Candidate changes:

- Delete issue-scoped transient thread/read/inbox/feedback rows within the same transaction.
- Detach durable cost and finance events so historical usage is preserved.
- Reject deletion of a parent issue while child issues remain, with a structured `issue_has_children` conflict.
- Translate any remaining protected foreign-key dependency into a structured `issue_delete_blocked` HTTP 409 instead of an internal 500.
- Add service regression coverage for read-state deletion and parent/child deletion ordering.

Acceptance check on staging:

1. The previously failing child `SIX-86` returned HTTP `200` from `DELETE /api/issues/SIX-86`.
2. The previously failing parent `SIX-85` returned HTTP `200` after its child was removed.
3. Subsequent GET requests for both identifiers returned HTTP `404 {"error":"Issue not found"}`.
4. The focused acceptance suite passed 5 tests, including the read-state and child-guard cases.

### A8 — Sidebar Tasks and Work Overview links rendered NOT FOUND

Severity: P2
Status: fixed and validated on staging and production.

Evidence from the first post-promotion browser sweep:

- `/SIX/tasks` loaded the application document but rendered `NOT FOUND`.
- `/SIX/work-overview` loaded the application document but rendered `NOT FOUND`.
- The sidebar labels already linked to `/issues` and `/work`, so the visible labels and their documented newer routes were inconsistent with the route names used in the audit navigation.

Root cause: `boardRoutes()` registered `issues` and `work` but did not register the user-facing compatibility paths `tasks` and `work-overview`.

Candidate change:

- Add relative redirects from `tasks` to `issues` and from `work-overview` to `work`, preserving the company prefix and making the canonical destination explicit.
- Add a route-registration regression test.

Acceptance check:

1. `/SIX/tasks` redirects to `/SIX/issues` and renders the Tasks view.
2. `/SIX/work-overview` redirects to `/SIX/work` and renders Work Overview.
3. Both routes produce no browser page error and no non-2xx API response.

## Audit coverage

The production read-only sweep covered dashboard, browsers, inbox, decisions, status, tasks, initiatives, tickets, AI issues, work overview, cycles, cases, routines, artifacts, skills, workspaces, projects, agents, organization settings, timeline, costs, activity, credentials, quota, and the `SIX-6013` issue detail. Pages with missing route registrations were recorded above instead of being treated as successful merely because their shell rendered; the final route-alias candidate was then checked by URL and rendered heading.

The browser audit did not exercise destructive production mutations, credential edits, issue creation, uploads, or agent runs. Staging-only smoke records were created for the candidate acceptance checks; no production records were changed by the browser checks. The production deployment was performed separately through the managed Dokploy workflow after staging validation.

## Candidate verification

Already green in the candidate worktree:

- Codex quota timeout regression test.
- Credential quota route normalization tests.
- Issue comment attachment-enrichment regression test.
- UI company-route tests, including global organization routes.
- Targeted UI quota/attachment tests.
- Targeted server improvement, MCP, authenticator, GitHub, and issue-service tests: 214 tests passed.
- Browser stream and live-run route tests: 13 tests passed.
- Browser page and company-route tests: 21 tests passed.
- Browser wake-prompt tests: 6 tests passed.
- OpenAPI route coverage test: 3 tests passed, including the browser-profile, browser-activity, and browser-stream operations added during this audit.
- UI and server typechecks.

The latest full local `pnpm test` aggregate reached 534 test files with
6,235 tests passed and 9 skipped. One host-sensitive assertion failed in
`server/src/__tests__/heartbeat-process-recovery.test.ts`: the missing-secret
case observed one adapter mock call under the all-in-one runner. The exact
test passed twice in fresh processes, the complete heartbeat file passed
111/111, and the serialized shard containing heartbeat and OpenAPI passed all
27 suites. The stable runner now retries that heartbeat file in a fresh
process because detached-process cleanup can race under aggregate load; the
full aggregate was not rerun after adding that retry. This is isolated from
the production runtime behavior and is recorded as a verification caveat,
not treated as a green full-suite claim.

`pnpm -r typecheck` passed. `pnpm build` passed with nonfatal existing warnings
about unresolved fonts, pure comments, and large chunks. The UI token gate
remains red on repository-wide findings (30 color, 213 arbitrary-bracket, and
108 raw-font-size violations); the latest runtime commit contains no UI
files, and the pre-existing UI debt remains a separate follow-up.

Live staging evidence for final runtime candidate `7c404216b9bf331c621e97078d1cc798773892c2`:

- Dokploy `paperclip-dev` deployment finished `Done` from `dev`; the deployment record reported the exact candidate commit.
- `GET https://paper-dev.zenova.id/api/health` returned HTTP `200`, `status: ok`, `bootstrapStatus: ready`, authenticated/private deployment mode, and backup status `ok`.
- The dashboard showed `API VALUE`, month tokens/spend, per-credential MTD tokens, cache miss, cache hit, output tokens, cache coverage, and quota windows. Refresh requested `GET /api/companies/{companyId}/credentials/quota-windows?refresh=true` and returned HTTP `200`.
- `/SIX/epics` showed `New Epic`, the Epic/Human task/AI execution work-type choices, and the acceptance-criteria field.
- `/SIX/cycles` exposed the 1-, 2-, 4-, and 7-day cycle presets.
- `/SIX/tasks` resolved to `/SIX/issues`; `/SIX/work-overview` resolved to `/SIX/work`. The canonical pages rendered successfully.
- Browser/session route checks and the final staging sweep produced no agent-browser page errors or non-2xx API responses.

Live production evidence for final runtime candidate `7c404216b9bf331c621e97078d1cc798773892c2`:

- Dokploy production deployed branch `deploy/paper-prod-20260826-7c404216` and finished `Done`; the deployment record reported the exact candidate commit.
- During container replacement, the public health endpoint briefly returned HTTP `502`; after warm-up the server container became healthy and `GET https://paper.zenova.id/api/health` returned HTTP `200`, `status: ok`, `bootstrapStatus: ready`, authenticated/private deployment mode, and backup status `ok`. The health response still reports `commit: null`, so the immutable revision-marker follow-up remains open.
- The dashboard showed API value, month tokens/spend, per-credential MTD tokens, cache miss, cache hit, output tokens, cache coverage, and quota progress. Refresh returned HTTP `200`.
- `/SIX/tasks` redirected to `/SIX/issues`, `/SIX/work-overview` redirected to `/SIX/work`, and `/SIX/epics` showed `New Epic`, the Epic work-type control, acceptance criteria, and `Create Epic`.
- `/SIX/cycles` exposed the 1-, 2-, 4-, and 7-day presets.
- The organization switcher successfully changed Six Zenith → Chrysler and back; the company switcher changed HYC → SIX and returned to `/SIX/dashboard`.
- A settled sequential agent-browser sweep rendered dashboard, browsers, inbox, decisions, status, tickets, work, work overview, epics, cycles, and global Organizations without a page error. The captured API requests contained no 4xx/5xx responses.

Remaining follow-up:

- GitHub Actions run `33003480218` for the exact runtime candidate completed
  `cancelled`: typecheck passed, but the test step was cancelled and build and
  deploy were skipped. Do not treat CI as green. The local baseline
  `@paperclipai/adapter-utils` failures above should be triaged separately.
- The A6 CI hardening follow-up remains: make the deploy job wait for a healthy rollout and verify an immutable revision marker; the public health response currently returns `commit: null`.
