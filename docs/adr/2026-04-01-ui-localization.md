# ADR: Paperclip UI Localization Foundation

Status: Accepted

Date: 2026-04-01

Related work:
- `TODO-2026-001408`
- `TODO-2026-001409`

## Context

Paperclip UI started as an English-first application with strings embedded directly in React components.

The product now needs:
- immediate support for English, Korean, and Japanese
- locale persistence across reloads
- compatibility with the existing messenger language setting
- a path to support 70+ locales without rewriting component logic

At the same time, the UI already contains a large amount of product-facing copy spread across pages, dialogs, and shared components.

## Decision

### Runtime model

- The UI uses a single i18n runtime/provider exposed through `useI18n()`.
- Components should prefer `t("namespace.key")` for user-facing strings.
- English remains the fallback locale.

### Locale sources

- Paperclip stores its own locale under `paperclip.locale`.
- It also reads and writes the existing messenger locale keys so the two surfaces stay in sync.
- Browser locale detection is only a fallback when no explicit preference exists.

### Message organization

- Translations live under `ui/src/i18n/messages/*`.
- Messages are organized by domain/page rather than one monolithic file.
- Locale-aware formatting such as dates, numbers, relative time, and currency stays centralized rather than being implemented ad hoc per page.

### Transitional rule

- Existing inline locale branching inside TSX is tolerated only as a transitional step while the sweep is in progress.
- The target state is catalog-driven translation keys with no per-locale branching in product components.

## Consequences

### Positive

- Product-facing strings can be localized incrementally without changing the runtime contract.
- Adding a new locale becomes primarily a catalog/data task.
- Locale sync with the messenger avoids conflicting user preferences between surfaces.
- After the 2026-04-01 sweep, the main product routes, shared dialogs, workspace controls, issue/project/goal flows, and most shared primitives are localized for `en/ko/ja`.

### Negative

- During the migration period, the repo may temporarily contain both catalog-driven strings and inline locale branching.
- Residual untranslated strings may still remain in internal/demo/example pages until the follow-up sweep is complete.

## 2026-04-01 Update

The first broad localization pass is now complete for product-facing Paperclip UI.

Covered in the sweep:
- app shell, navigation, onboarding entry, and locale switcher
- dashboard, agents, org chart, costs, approvals, routines, inbox, companies, auth, invite, company import/export
- issue/project/goal creation and detail flows
- seat-management dialogs and workspace management dialogs
- instance settings, restart banners, toasts, shared primitives, and several low-frequency admin surfaces
- internal/demo transcript and design reference pages used by the team while iterating on UI behavior
- follow-up externalization passes moved more goal/project/org/workspace/property strings out of TSX and into message catalogs
- later passes also moved workspace-close, live-run, budget-incident, issue-document, and more shared UI labels into catalogs
- the latest cleanup pass moved transcript UX lab and design-guide locale tables out of TSX into catalog data under `ui/src/i18n/messages/demo.ts`, removing the remaining direct per-locale branching from current UI sources
- shared status and priority labels are now localized through central helper functions and catalog-backed message keys, rather than rendering raw status codes in common UI primitives
- later cleanup also covered live update toasts, workspace status chips, activity-chart status legends, localized change summaries, helper-layer copy such as seat pause labels, delegated permission labels, budget scope descriptions, and issue-detail breadcrumb defaults, plus locale-aware provider/billing/quota display names, onboarding adapter labels, and common component default copy like copy tooltips, command dialog text, Mermaid fallback text, and accounting-model cards
- the latest follow-up localized the remaining adapter instruction-file labels/placeholders across local adapter config forms, added `pi_local` coverage to localized adapter label maps, moved the advanced new-agent adapter chooser onto shared onboarding catalogs, and localized transcript init/system/tool fallback labels plus model/session event summaries
- the newest cleanup pass localized the OpenClaw invite prompt snippet, live-run transcript empty states, and the last user-facing adapter fallback consumers that previously fell through to raw adapter module labels
- a final follow-up moved adapter module labels and fallback maps onto runtime locale helpers, leaving only demo/reference tokens and catalog data as expected remaining English literals

Remaining follow-up is intentionally narrower:
- residual demo/reference tokens such as model identifiers, icon names, and fixture-only placeholders in internal reference screens
- adding guardrails so newly introduced user-facing strings do not bypass the i18n layer
- a lightweight guardrail now exists via `pnpm check:i18n`, and `@paperclipai/ui` runs it in `pretypecheck` to block the old transitional locale-branch patterns from coming back

## Follow-up

- `TODO-2026-001408` completes the remaining repo-wide externalization sweep.
- `TODO-2026-001409` hardens the architecture for 70+ locale expansion, including catalog workflow and guardrails against new inline user-facing strings.
