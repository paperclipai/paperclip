# Paperclip Copilot Instructions

Read `AGENTS.md`, `CONTRIBUTING.md`, and `.github/PULL_REQUEST_TEMPLATE.md` before making changes. These repository instructions supplement those files; when there is a conflict, follow the stricter rule and stop for maintainer guidance if the safe path is unclear.

Paperclip is a control plane for AI-agent companies. Keep changes aligned with `doc/SPEC-implementation.md` and preserve these invariants:

- Every domain entity and API path must enforce company scoping.
- Keep contracts synchronized across `packages/db`, `packages/shared`, `server`, and `ui` when behavior, schema, or API shapes change.
- Preserve the single-assignee task model, atomic issue checkout semantics, approval gates, budget hard-stop behavior, and activity logging for mutating actions.
- Do not introduce secrets, credentials, customer data, broad permissions, or company-wide governance changes.

Work style:

- Keep the change small and scoped to the issue or review thread.
- Avoid unrelated refactors, formatting churn, dependency updates, or broad cleanup.
- Prefer existing code patterns, helpers, validators, and UI conventions.
- Update docs when behavior, commands, workflows, or contributor expectations change.
- If a requested change touches architecture, auth, secrets, database migrations, release automation, or `.github/**`, explain the risk in the PR and expect extra maintainer review.

Verification:

- Run the smallest relevant check first and report exact commands and outcomes.
- Use `pnpm test` for the cheap default Vitest path when a broader code check is needed.
- For PR-ready broad changes, run `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` unless a maintainer narrows the requirement.
- Browser suites (`pnpm test:e2e`, `pnpm test:release-smoke`) are opt-in unless the change touches those flows.

Pull requests:

- Fill every section of `.github/PULL_REQUEST_TEMPLATE.md`, including Thinking Path, Verification, Risks, Model Used, and Checklist.
- In Model Used, identify GitHub Copilot and the selected model/version when available.
- Do not merge Copilot-authored work without required CI, targeted verification, Greptile 5/5 with comments addressed, and human or Paperclip review.
- Treat Copilot code review as advisory feedback; it is not a substitute for a required approving review.
