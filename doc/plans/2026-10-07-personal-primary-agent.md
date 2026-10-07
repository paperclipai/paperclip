# Personal primary agent

## Current boundary

The user approved the revised Storybook design on 2026-10-07 and requested full
implementation plus acceptance testing in a real isolated test drive. This branch
now includes persistence, API wiring, and production defaults.

- Branch: `codex/personal-primary-agent-storybook`.
- Preview: http://localhost:6017/?path=/story/primary-agent-00-review-guide--start-here
- Source: `ui/storybook/stories/primary-agent/` (one feature folder).
- Shared presentation: `ui/src/components/primary-agent/PrimaryAgentPresentation.tsx`.
- Stories keep simulated state as the approved reference. The application now
  mounts a separate provider backed by a user/company preference endpoint.
- Delivery includes real test-drive acceptance on desktop/mobile and required
  repository checks. After reviewing the working feature, the user requested a
  pull request with passing checks and merge into master.

## Agreed product contract

Each person has one primary agent per company, marked with an accessible
"My primary agent" crown on the profile and agent list. Neither the Agents
sidebar nor the Chat sidebar shows a crown. Different people can choose different agents; the
preference will persist across devices. Crowning does not change roles,
reporting lines, permissions, tasks, routines, or shared Board Operations.

- The first human-attributed creation silently initializes the primary, including
  onboarding. Later creations, system provisioning, and agent-authored hires do
  not replace or establish a person's preference.
- Tasks preserve explicit assignments and restored drafts, then prefer a recent
  eligible assignee, then the primary, then the existing fallback.
- Chat reopens a valid recent conversation, otherwise the primary's conversation,
  otherwise its existing chooser. Opening Chat does not start execution.
- The individual agent page offers Set as my primary beneath the agent details.
  Kebab menus have no primary action, and there is no explicit removal option.
  Standalone component examples do not offer this action. The current primary
  shows its crown with no redundant set action. When a primary already exists,
  switching requires a modal with the two agents' avatars and an arrow above.
  The incoming primary has an outlined avatar and a crown beside its name:
  "This will make [new name] your primary agent, do you want to do this?"
  Cancel leaves the current primary unchanged. When none exists,
  choosing one applies immediately without the modal. Stars remain independent.
  Failures roll back and offer an actionable retry. These review decisions
  supersede the original menu, removal, and immediate-switching design.
- The primary stays first in the Agents sidebar, even when idle; other ordering
  is preserved and the primary appears only once in that section.
- Pausing and errors retain the crown and existing execution restrictions.
  Leaving or terminating clears it without resetting initialization. Crowning a
  previously left agent rejoins it under existing membership rules.

## Review coverage and implementation notes

Stories use the actual streamlined and classic Layout components, roster/profile
pages, composer, Chat pages/navigation, existing menus, and shared crown components.
Fixtures include idle/active, first-created result, absent/cleared/unavailable,
paused/error, independent stars, long names, loading, failed mutations, desktop,
mobile, and light theme. Interactive stories cover setting from the profile,
absence of primary menu actions, leaving, starring, rollback/retry, and opening
a task or Chat after switching, cancellation, and first choice without confirmation.

The streamlined Sidebar now includes the reviewed Agents section by default.
Stories can still supply it through Layout's existing sidebar slot for review.
The icon rail is retired in SidebarContext; collapsed coverage uses the supported
collapsible Agents section plus the mobile drawer. No rail is reintroduced.

Reloading resets the fixture preference. Task fallback is simulated through the
existing composer's defaults/recent-assignee input. Chat entry routing and the
first-created result are also simulations. These stories are design references,
not evidence of authorization, persistence, concurrency, or real execution.

## Verification at review handoff

- UI TypeScript build (`tsc -b ui`).
- 61 existing tests across SidebarAgents, AgentActionButtons, EntityRow, Agents,
  and AgentOverview.
- Token gates and palette/character synchronization checks.
- Full static Storybook build.
- Browser walkthroughs: switch crown and sidebar order, independent stars,
  rollback and Retry, leave/rejoin, direct profile action, task assignment/draft
  precedence, recent Chat history, Chat fallback/chooser, and mobile drawer,
  composer, and profile at 390 by 844.

## Implementation delivered

1. Added a company/user preference with nullable primaryAgentId and initialization
   state; enforce uniqueness. Synchronize db/shared/server/ui contracts.
2. Added authenticated GET/PUT `/api/companies/:companyId/primary-agent/me`, deriving
   the user from authentication, enforcing company access and agent visibility,
   rejecting agent actors, and recording mutation activity.
3. Initialized transactionally during human-attributed creation. Concurrent
   creations establish one primary and cannot overwrite an explicit choice or
   lifecycle-cleared preference. Backfill from the earliest attributable human creation;
   if that original agent is gone or terminated, leave the crown empty. Unknown
   ownership remains unset.
4. Added lifecycle cleanup and existing membership rejoin behavior. Connected a
   user/company-scoped query hook to the reviewed presentation and defaults.
5. Verified concurrency, backfill, lifecycle cleanup, user/company isolation
   (including local trusted mode), drafts, recent selections, unavailable agents,
   and real desktop/mobile task and Chat journeys.

## Real test-drive acceptance (2026-10-07)

- Isolated CLI test drive: `/tmp/paperclip-primary-agent-test-drive`, company
  **Primary Agent Test Drive**, prefix `PRI`, at http://localhost:3104.
- Maia was crowned automatically through the real creation API. Creating Alex
  preserved Maia. The simplified creation wizard's model-connection step rejected
  the disposable placeholder credential; Alex was created through the real API
  with the existing local Codex login instead. No creation-wizard success is claimed.
- Desktop: profile-only setting, cancel/confirm, persistence after reload, roster
  crown, sidebar ordering, absent sidebar crowns and menu actions, leave/clear,
  first choice without a modal, rejoin, and paused crown retention passed.
- Fresh browser-origin task composer selected Alex from the primary. After switching
  to Maia, the composer preserved recent Alex and Chat reopened Alex's recent
  conversation. An existing draft on the other origin remained intact.
- Opening Chat used the primary with no new execution. Sending a message produced
  **“Alex received this primary-agent chat.”** from a successful real Codex run.
- Real task **PRI-3, Acknowledge Alex’s task receipt**, completed with
  **“Task received by Alex”** and status `done`. The initial probe used an unsupported
  `gpt-5.4` subscription model; both agents were changed to `gpt-6.1-sol`, the successful
  checks were repeated, and the obsolete probe task was cancelled.
- Mobile at 390 × 844: the reviewed modal fits, confirmation switches the crown,
  and the page has no horizontal overflow. Viewport override reset afterward.
- Focused tests cover initialization, simultaneous creation/selection, audit order,
  leave races, backfill, visibility boundaries, viewer self-service, auth-derived
  user/company isolation, optimistic rollback/retry, session retry, task defaults,
  and recent Chat precedence.

## Verification results

- Repository typecheck passed with `pnpm -r --workspace-concurrency=1 typecheck`.
  Final server/UI typechecks also passed after the last feature refinements.
- `pnpm build`, `pnpm check:token-gates`, and `git diff --check` passed.
- Entire UI suite: **698 files, 7,760 tests passed**.
- Entire DB suite, run serially: **47 files, 166 tests passed**. Parallel attempts
  failed to initialize embedded PostgreSQL before migrations; the serial run
  resolves that migration-verification concern.
- Focused primary/default/provider checks passed: **106 tests** across final
  runs (9 database/API tests, plus provider, composer, and Chat tests).
- Existing onboarding, hire idempotency, resource membership, and company import
  suites passed: **125 tests**. Legacy approval plus terminalization checks:
  **15 tests passed**. Import/approval expectations now assert original creator
  attribution rather than dropping the new creation option.
- **Repository-wide tests are not green.** `pnpm test:run` was stopped after
  roughly an hour with failures, rather than being represented as a complete pass.
  `adapter-cost-failure-paths.test.ts` still has OpenCode timeout failures in a
  fresh rerun. `workspace-git-snapshot-streaming.test.ts` timed out after 300 seconds.
  Heartbeat database-setup timeouts passed isolated reruns. The broad run began
  before the final edits and also reported primary/approval failures; those suites
  passed in fresh processes against final source. Later broad-run groups did not
  complete. These local failures remain disclosed; PR checks must pass on the
  current head before merge.

The final-code test drive remains running at http://localhost:3104 with **Alex**
primary and **Maia's profile** open. Choose **Set as my primary**, confirm, and
reload to try persistence. New Task and Chat retain recent Alex choices by design;
the primary is their fallback when no eligible recent choice or draft exists.
