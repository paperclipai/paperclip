# UI Localization Workflow

Paperclip UI uses a catalog-driven i18n model for user-facing copy.

## Current shape

- Runtime/provider: `ui/src/i18n/index.tsx`
- Runtime locale helpers and messenger sync: `ui/src/i18n/runtime.ts`
- Locale list: `ui/src/i18n/types.ts`
- Message catalogs: `ui/src/i18n/messages/*`
- Guardrail: `scripts/check-ui-localization.mjs`
- Verification command: `pnpm check:i18n`

## Rules

- Put user-facing strings behind `t("namespace.key")` in React components.
- Put helper-layer or non-React display strings behind `formatMessage(getRuntimeLocale(), "namespace.key")`.
- Do not add inline locale branching such as `locale === "ko"`, `pickLocaleText()`, or three-argument `tr("en", "ko", "ja")`.
- Prefer domain catalogs under `ui/src/i18n/messages/*` over one large shared file.
- Treat demo/internal pages the same way: catalog-backed UI copy, but fixture data can stay as sanitized sample data when it is intentionally representing user content.

## Adding a new string

1. Add a key to the appropriate catalog in `ui/src/i18n/messages/*`.
2. Provide values for every active locale in `ACTIVE_LOCALES`.
3. Replace the component literal with `t("namespace.key")` or `formatMessage(...)`.
4. Run:
   - `pnpm check:i18n`
   - `pnpm --filter @paperclipai/ui typecheck`

## Adding a new locale

1. Add the locale code to `ACTIVE_LOCALES` in `ui/src/i18n/types.ts`.
2. Add catalog values for the new locale in every file under `ui/src/i18n/messages/*`.
3. Verify runtime fallback and storage handling in:
   - `ui/src/i18n/index.tsx`
   - `ui/src/i18n/runtime.ts`
4. Run:
   - `pnpm check:i18n`
   - `pnpm --filter @paperclipai/ui typecheck`
   - `pnpm build`
   - `pnpm test:run`

## Locale-aware formatting

Do not hardcode date, number, currency, or relative-time formatting in components.

Use the shared helpers in `ui/src/lib/utils.ts` and related helper modules so formatting follows the runtime locale.

## Expected remaining English

These are acceptable and should not be treated as product-surface localization regressions by default:

- English source values inside the `en` catalogs
- Sanitized transcript/demo fixture content that intentionally represents sample user data
- Model identifiers, fixture IDs, and reference-only tokens when they are part of demo data rather than user-facing product copy

## Review checklist

Before merging localization work, confirm:

- No new inline locale branching was added
- No user-facing product copy bypasses the i18n layer
- New helper-layer labels are locale-aware
- `pnpm check:i18n` passes
- `pnpm --filter @paperclipai/ui typecheck` passes
- If the batch is substantial, `pnpm build` and `pnpm test:run` also pass
