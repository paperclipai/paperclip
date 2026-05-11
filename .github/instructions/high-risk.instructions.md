---
applyTo: ".github/**,packages/db/**,packages/shared/**,server/**,scripts/**,docker/**,doc/**"
---

# High-Risk Area Instructions

Changes in these paths need tighter review because they can affect CI, secrets, auth, company boundaries, schema/API contracts, release behavior, or operator workflows.

- For `.github/**`, do not weaken branch protection assumptions, review gates, CI coverage, or workflow permission posture. Any workflow or action change needs explicit human maintainer scrutiny before merge.
- For `packages/db/**`, update schema exports and generate migrations when the data model changes. Do not hand-edit generated migration state unless the existing workflow requires it.
- For `packages/shared/**`, keep validators, constants, and shared types in sync with server and UI consumers.
- For `server/**`, enforce company access checks, actor permissions, consistent HTTP errors, and activity logging for mutating routes.
- For scripts, Docker, release, or CI docs, preserve safe defaults and do not add commands that expose or require secrets.
- For docs, keep operational instructions concrete and current with the implementation contract.

If the requested change is broader than the issue scope, stop and ask for maintainer direction instead of expanding the PR.
