# Onboarding and first work — agent access

Product map: [Onboarding and first work](../feature-map/onboarding.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `instance`

Review: `baseline`.

API: `not-applicable` — Bootstrapping an instance cannot depend solely on an API served
by that not-yet-running instance.

Agent access: `operator-only` — Existing CLI onboard/run/doctor / test-drive.

Policy: Instance setup is operator work; company creation is board; agent creation/task
creation retain their individual permissions.

Evidence: `source-only` —
[implementation](../../ui/src/components/OnboardingWizard.tsx#L279) at the reviewed
commit above.

Verification: `not-run` — exercise the listed local workflow in an authorized, owned
operator environment. Verify its isolation and result; do not count local machine
authority as company-agent API access.

Gaps: Bootstrapping an instance cannot depend solely on an API served by that
not-yet-running instance.

## `company`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies`.
- `POST /api/companies/{companyId}/agents`.

Agent access: `partial` — Board company creation; authorized in-company agent hiring
API.

Policy: Instance setup is operator work; company creation is board; agent creation/task
creation retain their individual permissions.

Evidence: `source-only` —
[implementation](../../ui/src/components/OnboardingWizard.tsx#L279) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: API building blocks exist; an ordinary agent cannot create its parent company with
a company key.

## `adapter`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/adapters/{type}/models`.
- `POST /api/companies/{companyId}/adapters/{type}/test-environment`.

Agent access: `partial` — Permitted agent/model API; operator
provider-account/environment setup.

Policy: Instance setup is operator work; company creation is board; agent creation/task
creation retain their individual permissions.

Evidence: `source-only` —
[implementation](../../ui/src/components/OnboardingWizard.tsx#L279) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Account authorization, environment administration and model selection need
separate checks.

## `first-task`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/issues`.

Agent access: `available` — Native create_task / agent REST / CLI issue.

Policy: Instance setup is operator work; company creation is board; agent creation/task
creation retain their individual permissions.

Evidence: `source-only` —
[implementation](../../ui/src/components/OnboardingWizard.tsx#L279) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Task creation is agent-accessible where permitted; scheduling/readiness does not
follow from successful creation.

## `resume`

Review: `baseline`.

API: `not-applicable` — No server onboarding-draft API for this browser-local state;
classify explicitly or intentionally make it a cross-client product feature.

Agent access: `not-applicable` — Browser localStorage wizard draft; persisted resources
use their domain APIs.

Policy: Instance setup is operator work; company creation is board; agent creation/task
creation retain their individual permissions.

Evidence: `source-only` —
[implementation](../../ui/src/components/OnboardingWizard.tsx#L279) at the reviewed
commit above.

Verification: `not-run` — use the product recipe for the local/developer surface. Verify
listed shared-resource reads separately; local presentation alone is not agent API
evidence.

Gaps: No server onboarding-draft API for this browser-local state; classify explicitly
or intentionally make it a cross-client product feature.
