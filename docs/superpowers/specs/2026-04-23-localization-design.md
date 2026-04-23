# Paperclip Localization Design

## Summary

Add first-class English and Simplified Chinese localization to the Paperclip web UI and user-visible server responses.

The language model is:

- Instance-wide default language stored in instance general settings
- Optional company-level language override
- Effective locale resolved as `company.localeOverride ?? instance.general.locale ?? "en"`

This design intentionally localizes Paperclip-owned product text, not user-authored content or third-party/plugin output.

## Goals

- Support `en` and `zh-CN` across the web UI
- Support localized API error messages for user-visible server responses
- Add a language control to instance settings
- Add a company-level override that can inherit the instance default
- Keep the rollout incremental so partial translation coverage does not break the app

## Non-Goals

- Translating issue titles, comments, documents, or any other user-authored content
- Translating agent transcript output, adapter stderr/stdout, or historical activity log text
- Translating plugin-owned UI bundles or third-party service errors
- Shipping a generalized translation management platform in this iteration

## Product Rules

### Supported locales

- `en`
- `zh-CN`

### Language precedence

1. If a company override exists, use it
2. Otherwise use the instance default
3. Otherwise fall back to `en`

### Company override semantics

- The company override is stored as `null` when inheriting
- `null` is not a locale value; it only means "follow instance default"

## Data Model

### Shared types

Add a shared locale type in `packages/shared`:

```ts
export type SupportedLocale = "en" | "zh-CN";
```

Update shared instance and company contracts:

- `InstanceGeneralSettings.locale: SupportedLocale`
- `Company.localeOverride: SupportedLocale | null`

Update patch types and validators so both fields are accepted and validated end-to-end.

### Instance settings

Reuse the existing `instance_settings.general` JSON document:

```ts
type InstanceGeneralSettings = {
  locale: SupportedLocale;
  // existing fields...
};
```

Default persisted value for existing installs: `en`.

### Company settings

Add a nullable column to `companies`:

- `locale_override`

Type:

- nullable text or enum constrained to `en | zh-CN`

Semantics:

- `null` => inherit instance default
- `en` => force English
- `zh-CN` => force Simplified Chinese

## API Contract

### Instance settings API

Keep the existing endpoints:

- `GET /api/instance/settings/general`
- `PATCH /api/instance/settings/general`

Patch payload adds:

```json
{
  "locale": "zh-CN"
}
```

### Company settings API

Keep the existing company update endpoint:

- `PATCH /api/companies/:companyId`

Patch payload adds:

```json
{
  "localeOverride": "zh-CN"
}
```

or

```json
{
  "localeOverride": null
}
```

The route must continue to enforce company-scoped authorization rules before applying the override.

## Frontend Design

### Runtime structure

Add a lightweight i18n runtime in `ui/src`:

- `ui/src/i18n/types.ts`
- `ui/src/i18n/messages/en.ts`
- `ui/src/i18n/messages/zh-CN.ts`
- `ui/src/i18n/format.ts`
- `ui/src/context/I18nContext.tsx`

The runtime exports:

- `locale`
- `effectiveLocale`
- `t(key, params?)`
- `formatters` for common app-owned formatting if needed later

### Locale resolution

The provider resolves locale from:

1. instance general settings query
2. selected company `localeOverride`

Resolution formula:

```ts
const effectiveLocale = selectedCompany?.localeOverride ?? instanceGeneral?.locale ?? "en";
```

The provider updates the document root:

```ts
document.documentElement.lang = effectiveLocale;
```

### Translation key strategy

Use stable semantic keys, not English-copy-as-key.

Examples:

- `nav.dashboard`
- `command_palette.search_placeholder`
- `dashboard.empty.no_agents`
- `settings.instance.language.title`
- `errors.issue.not_found`

This keeps server and UI key names aligned even if they do not share the same runtime package.

### UI coverage for the first rollout

First-pass UI localization covers high-traffic, Paperclip-owned surfaces:

- app shell and route entry copy in `ui/src/App.tsx`
- sidebar/navigation labels
- command palette
- dashboard
- companies page
- instance general settings
- company settings
- common empty states, buttons, loading labels, and toast copy touched by those flows

Later pages can continue to render English safely until translated. The provider must never throw on missing keys; it should fall back to English.

### Settings UI

#### Instance settings

Add a language section to `ui/src/pages/InstanceGeneralSettings.tsx`:

- Title: default language
- Choices:
  - English
  - 简体中文

Changing the value updates `instance_settings.general.locale`.

#### Company settings

Add a language section to `ui/src/pages/CompanySettings.tsx`:

- Title: language override
- Choices:
  - Follow instance default
  - English
  - 简体中文

Also display the currently effective language so the inheritance result is explicit.

## Server Design

### Locale resolution service

Add server-side locale resolution helpers, for example:

- `server/src/i18n/types.ts`
- `server/src/i18n/messages/en.ts`
- `server/src/i18n/messages/zh-CN.ts`
- `server/src/i18n/resolve-locale.ts`
- `server/src/i18n/t.ts`

Core helper:

```ts
resolveRequestLocale({
  req,
  companyId,
}): Promise<SupportedLocale>
```

Resolution rules:

- company-scoped routes: company override first, instance default second
- non-company routes: instance default
- hard fallback: `en`

The resolver should not depend on headers for the initial implementation because product policy is configuration-driven, not per-client preference driven.

### Localized error responses

Many routes currently inline strings directly in `res.status(...).json({ error: "..." })` or error helpers. Introduce shared server helpers:

- `sendLocalizedError(res, req, status, key, details?)`
- `localizedBadRequest(req, key, details?)`
- `localizedForbidden(req, key, details?)`
- `localizedNotFound(req, key, details?)`
- `localizedConflict(req, key, details?)`

The HTTP shape stays the same:

```json
{
  "error": "问题未找到"
}
```

Only the `error` string changes by locale.

### Initial server coverage

First localized server responses should cover the routes most likely to surface directly in the board UI:

- `server/src/routes/instance-settings.ts`
- `server/src/routes/companies.ts`
- common shared error helpers in `server/src/errors.ts`
- high-frequency issue route errors in `server/src/routes/issues.ts`

Examples:

- board authentication required
- forbidden
- issue not found
- invalid document key
- limit must be a positive integer
- only board users can perform this action

Internal logs, activity records, and stored messages remain unchanged in this phase.

## Migration Strategy

### Database migration

1. Add `companies.locale_override`
2. Backfill nothing; leave existing rows as `null`
3. Keep instance settings JSON compatible and default missing `locale` to `en` at service-read time

### Compatibility

- Existing clients that do not send locale fields continue to work
- Existing databases without a persisted general locale behave as English
- Partial UI translation coverage falls back to English copy

## Rollout Plan

### Phase 1: Contracts and persistence

- add shared locale types and validators
- add company column and migration
- add instance/company read-write support

### Phase 2: Frontend runtime and settings

- add `I18nProvider`
- wire locale resolution into the provider chain
- add language controls to instance and company settings

### Phase 3: High-traffic UI translation

- localize app shell, dashboard, companies, navigation, command palette, and touched shared copy

### Phase 4: Server response localization

- add server dictionaries and locale resolver
- localize common route errors and shared helpers

## Testing Strategy

### Shared

- validate `SupportedLocale`
- validate patch payloads containing `locale` and `localeOverride`

### Server

- instance settings route tests for reading and writing locale
- company settings route tests for reading and writing locale override
- locale resolution tests for inherit vs override behavior
- route tests confirming localized `error` payloads for `en` and `zh-CN`

### UI

- provider tests for effective locale resolution
- settings page tests for instance default and company override controls
- smoke tests for a few translated pages to verify visible copy changes after locale changes

## Risks

- The UI currently contains many hardcoded strings, so first-pass coverage will be incomplete without a disciplined sweep.
- The server currently inlines many route error strings, making omissions likely unless the migration is driven by systematic search and helper adoption.
- If translation keys drift between files, maintenance cost will rise quickly. Key naming must be reviewed for consistency.
- Different companies in the same instance can intentionally see different API error languages. Tests must make this behavior explicit.

## Acceptance Criteria

- Instance settings can set a default language between English and Simplified Chinese
- Company settings can inherit or override that language
- The effective language resolves correctly for the selected company
- Core UI surfaces switch between English and Simplified Chinese without runtime errors
- Common user-visible API errors return localized `error` strings
- Untranslated surfaces continue to work by falling back to English

## Open Questions Resolved

- Scope includes both UI text and user-visible server response text
- Language preference is not per-user
- Instance settings define the default
- Company settings may override the default
- Initial implementation supports only `en` and `zh-CN`
