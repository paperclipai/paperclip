# SDLC Policy

This is the single source of truth for how work flows through our pipeline. All agents and contributors must follow this flow.

## The Standard Flow

| Phase | Gate | Owner | Output |
|-------|------|-------|--------|
| 1. Feature Identification | User need validated | CEO / Product | Issue created with user story |
| 2. Scope & Research | Exhaustive spec complete | CEO + assigned engineer | Plan document on issue |
| 3. Development | Code complete, PR merged to `main` | Founding Engineer | Working code on `main` branch |
| 4. Testing (Programmatic GO + Browser GO) | Programmatic GO for every change; Browser GO for UI/user-facing changes | QA Engineer + DevOps | Programmatic GO plus Browser GO record when in scope, or bug subtasks |
| 5. Staging Deployment | Manual staging workflow dispatched with QA GO metadata | DevOps Engineer | Live on staging URL plus workflow record of the QA gate |
| 6. Staging Validation | Real-user testing passes | Board / CEO | Sign-off comment |
| 7. Production Release | Board approval | DevOps Engineer | Live on production URL |

## Phase Details

### Phase 1: Feature Identification

- CEO or Board identifies features that users need.
- Each feature gets an issue with a clear user story and acceptance criteria.
- Priority is set based on user impact and business value.

### Phase 2: Scope & Research

- Assigned engineer researches the feature exhaustively.
- A plan document is created on the issue covering architecture, dependencies, risks, and timeline.
- CEO reviews and approves the plan before development begins.

### Phase 3: Development

- Engineer implements the feature on a feature branch.
- Code is reviewed and merged to `main` via pull request.
- All CI checks must pass before merge.
- Merging to `main` does not authorize a staging deploy by itself.

#### Temporary Option 3 merge path on `main`

As of 2026-05-20, Ratiq-Multimodal `main` is using the temporary Option 3 branch-protection path from [FAI-2048](/FAI/issues/FAI-2048):

- Pull requests targeting `main` must pass all 9 required status checks.
- The issue thread must contain a QA `GO` verdict before merge.
- `required_approving_review_count=0` means GitHub does not require an approving review for this repo during the temporary policy window; the QA-GO comment is the human-review substitute.
- Merge with `gh pr merge --squash` only. Do not use `--admin`, and do not temporarily edit protection rules to force the merge through.
- When a second human collaborator is added to the repository, restore `required_approving_review_count=1` and remove this temporary policy substitute.

### Phase 4 — Testing (Programmatic GO + Browser GO)

**4a. Programmatic GO/NO-GO (all changes — unchanged from today)**
- Build passes; typecheck/lint clean; unit + integration tests pass; CI green.
- Deterministic, fast, cheap. Required for **every** change.

**4b. Browser GO/NO-GO (UI / user-facing changes only — NEW hard gate)**
- QA drives a real browser through the actual user journey(s) for the specific feature/bugfix on a running pre-staging instance, in the isolated QA browser context (FAI-5734).
- Produces a machine-readable **Browser GO record** (schema below).
- **Scope rule (board decision):** applies to UI / user-facing changes only. Infra / CI / docs / backend-internal changes are **Programmatic-GO only** and explicitly skip 4b. The PR author/QA classifies the change; ambiguous cases default to requiring 4b.

**Hand-off rule**
- The Security Engineer hand-off (and any progression to Phase 5 Staging Deployment) requires **BOTH** a Programmatic GO **and**, for in-scope UI changes, a Browser GO. For out-of-scope (infra/CI/docs/backend-internal) changes, Programmatic GO alone satisfies the gate.
- A Browser **NO-GO** blocks staging exactly like a Programmatic NO-GO does today.

### Browser GO record (place next to the existing staging-deploy record discipline)

Every Browser GO/NO-GO emits a structured verdict record (work product / verdict JSON) with at minimum:

- `issueId` — the issue under test
- `verdict` — `GO` | `NO-GO`
- `journeys` — list of user journeys exercised
- `evidence` — screenshot + DOM work-product / attachment ids per journey
- `metrics` — added latency, flaky-journey count
- `approver` — the QA actor agent id
- `timestamp`

The Browser GO record sits next to the existing staging-deploy record discipline. A GO verdict must be captured in a machine-readable place before staging deploy. The minimum acceptable staging deploy record is the `cd-staging.yml` workflow dispatch inputs: QA issue identifier, verdict summary, and approver.

**Rules:**
- Small fixes (typos, minor UI tweaks) do not require a full release-batch GO/NO-GO. They still require Programmatic GO, and they require Browser GO when they are UI/user-facing and not explicitly classified out of scope.
- Every GO/NO-GO issue must list the exact features/PRs under review.
- QA owns the test checklist and Browser GO verdict record. DevOps validates infra readiness. CEO issues the final verdict when the release gate requires CEO sign-off.
- Synthetic smokes that exercise rep/forwarder notification paths must run only against an approved QA/E2E company or an explicit synthetic-notification gate. Never run those smokes against a customer-like company that can emit real operational emails.

### Phase 5: Staging Deployment

- After the applicable Phase 4 GO verdicts, DevOps deploys to the staging environment.
- Staging deployment is a manual GitHub Actions dispatch only; `main` pushes never deploy automatically.
- DevOps must populate the workflow inputs with the Phase 4 QA issue identifier, the GO verdict summary, and the approver before running the deploy.
- Staging URL is shared with the board for validation.

### Phase 6: Staging Validation

- Board and/or real users test the staging environment.
- CEO creates a "Staging Validation" issue for tracking.
- Board comments GO or NO-GO with specific feedback.
- Issues found in staging get filed as bugs and go back to Phase 3.
- When staging validation includes synthetic QA flows, seed and execute them only inside the approved test-company path so rep/forwarder notifications are suppressed by design.

### Phase 7: Production Release

- Only after board GO on staging does DevOps promote to production.
- Production deployment requires a tagged release or manual approval gate.
- Environment protection rules enforce this in GitHub Actions.

## Status Tags

When updating issues, agents must tag their work with the current phase:

- `[Phase 1]` Feature identification
- `[Phase 2]` Scoping and research
- `[Phase 3]` Development
- `[Phase 4a]` Programmatic GO/NO-GO
- `[Phase 4b]` Browser GO/NO-GO
- `[Phase 5]` Staging deployment
- `[Phase 6]` Staging validation
- `[Phase 7]` Production release

## Enforcement

- No code reaches staging without Programmatic GO and, for UI/user-facing changes, Browser GO.
- No code reaches staging without a matching machine-readable staging deploy record.
- No code reaches production without board sign-off from Phase 6.
- Every agent references this policy when planning and executing work.
- Violations are escalated to the CEO immediately.
