# PRD: Team Mode on the Existing Company Model

## Goal
- Let operators present Paperclip as either a company or a team while keeping the existing internal company-scoped model, APIs, and storage intact.
- Make the change additive and upstream-friendly so frequent syncs with the original repository stay manageable.

## Problem
- Paperclip currently exposes a strong company/CEO/hiring metaphor across onboarding, settings, approvals, and org views.
- That framing works for some users, but it feels forced for research groups, MVP teams, or ad hoc operator-led agent groups that are not naturally modeled as a company.
- The collaboration framework, reports, projects, tasks, and budgeting already fit those smaller use cases well; the main mismatch is presentation and operator-facing terminology.

## Users and audience
- Primary user: operators who want to run Paperclip as a team workspace rather than a company simulator.
- Secondary stakeholders: upstream maintainers who need the change to remain localized and easy to rebase.

## Scope
- In:
- Add persisted `organizationMode: "company" | "team"` to companies with a default of `"company"`.
- Preserve the mode through company create/update/get/list and export/import portability flows.
- Add one shared terminology resolver for operator-facing labels.
- Update onboarding, settings, approvals, company selection, dashboard/org views, and key agent UI copy to consume the mode-aware terms.
- Materialize planning and handoff docs for future Codex sessions.
- Out:
- No new top-level runtime object such as `workspace` or `team`.
- No route renames, API aliases, DB table renames, or event-type renames.
- No internal role/capability refactor; the first/root agent remains stored as `ceo`.
- No agent profile library or alternate agent provisioning system in this project.

## Constraints
- Technical:
- Keep internal identifiers stable: `companyId`, `/companies`, `/agent-hires`, `hire_agent`, `approve_ceo_strategy`, and `ceo` stay canonical.
- Prefer additive helpers and narrow touchpoints over broad renames.
- Keep db/shared/server/ui contracts synchronized.
- Product:
- Team mode is presentation-only in this phase.
- Default team-mode root-agent label is `Team Lead`.
- Delivery:
- The fork must remain easy to rebase against a fast-moving upstream.
- Changes should be self-contained in new helpers and isolated field plumbing where possible.

## Success criteria
- [ ] A company can be created and updated with `organizationMode`, and existing companies default to `"company"`.
- [ ] Export/import preserves `organizationMode`.
- [ ] Onboarding supports both company mode and team mode without changing underlying agent-role semantics.
- [ ] Main operator-facing surfaces show team terminology when `organizationMode === "team"` and keep existing behavior otherwise.
- [ ] Verification is defined as `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`.

## References
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`
- `doc/DEVELOPING.md`
- `doc/DATABASE.md`
- `doc/plans/2026-03-28-team-mode-company-presentation.md`
