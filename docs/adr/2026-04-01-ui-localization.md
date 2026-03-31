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

### Negative

- During the migration period, the repo may temporarily contain both catalog-driven strings and inline locale branching.
- Residual untranslated strings can remain in low-frequency or internal/demo pages until the follow-up sweep is complete.

## Follow-up

- `TODO-2026-001408` completes the remaining repo-wide externalization sweep.
- `TODO-2026-001409` hardens the architecture for 70+ locale expansion, including catalog workflow and guardrails against new inline user-facing strings.
