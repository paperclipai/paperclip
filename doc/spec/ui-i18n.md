# Paperclip UI Internationalization (i18n) — Decision Record

Status: Accepted
Date: 2026-04-19
Related PR: #3965 (`feat(ui): add full i18n coverage (en/ko) with language switcher`)

This document captures the architectural decisions behind UI translation in Paperclip so that future locale drops, adapter UIs, and contributors have a single reference to follow instead of re-deriving the pattern from the diff.

## Scope classification

i18n is an **accepted V1 extension, not a roadmap-level milestone**.

`ROADMAP.md` describes Paperclip's core control-plane loop (companies, agents, tasks, budgets, approvals, board). i18n is not listed there and is not on the deferral list either — it belongs in the same bucket as keyboard shortcuts, empty states, and dark-theme polish described under `doc/spec/ui.md` §22 "Phase 5: Polish". It is additive, does not change the data model or server contracts, and fails safe (English fallback via `fallbackLng: "en"`).

Implications:

- Translation work (new locales, missing-key fixes) does not require roadmap alignment; a single JSON drop under `ui/src/locales/<lang>/` is sufficient.
- i18n should not be used as a justification to restructure non-UI code.
- Non-UI surfaces (API error messages, CLI output, server logs) are **out of scope**. The decisions here apply to the React UI only.

## Chosen library: `react-i18next`

**Decision:** `react-i18next` (v15) on top of `i18next` + `i18next-browser-languagedetector`.

**Why this over the alternatives:**

| Option | Why not |
|---|---|
| `react-intl` (FormatJS) | ICU MessageFormat is heavier than we need; Paperclip strings are short labels, titles, and toast bodies — no complex pluralization or gendering yet. |
| `lingui` | Compile-step macro ergonomics are nice but require a build-pipeline change; our Vite pipeline intentionally has no extra AST transforms. |
| Hand-rolled `t()` | Viable for 10 strings, not for 80+ files. Loses language-change reactivity, localStorage persistence, plural forms, and interpolation escaping. |

**What we use from it:**

- `useTranslation()` hook → the universal access point from components.
- `i18n.changeLanguage()` → wired to `LanguageSwitcher` and persisted by the detector.
- `interpolation: { escapeValue: false }` → React already escapes; double-escaping corrupts template values.
- `LanguageDetector` with `order: ["localStorage", "navigator"]`, `lookupLocalStorage: "paperclip.lang"`, `caches: ["localStorage"]` → first visit picks up the operator's OS/browser locale automatically; the explicit `LanguageSwitcher` choice survives reload. No per-locale rollout plan is needed — `SUPPORTED_LANGS` gates the set, and any locale outside that set falls back to `en` via `fallbackLng`.

## Bundle layout and namespace strategy

**Layout:** topic JSONs per locale under `ui/src/locales/<lang>/`, merged at import time into a single `translation` namespace.

```
ui/src/locales/
├── en/
│   ├── core.json         core layout, auth-adjacent chrome
│   ├── dashboard.json    dashboard + active-agents panel
│   ├── issues.json       issues list, detail, composer
│   ├── instance.json     instance settings, heartbeat, intervals
│   ├── agents.json       agent list + agent detail + run transcript
│   ├── company.json      company settings, members, access
│   ├── details.json      cross-entity detail surfaces
│   ├── auth.json         sign-in, onboarding gate
│   ├── misc.json         toasts, plugin manager, transcript bits
│   ├── routines.json     scheduled routines
│   ├── costs.json        cost dashboard, usage, quotas
│   ├── onboarding.json   first-run wizard
│   └── index.ts          ← merges all of the above
└── ko/                   ← mirror structure, same keys
```

**Single-namespace merge, not one namespace per file.** `ui/src/locales/<lang>/index.ts` spreads every topic JSON into one object, and `i18n.ts` registers that object under the `translation` namespace:

```ts
// ui/src/i18n.ts
resources: {
  en: { translation: en },
  ko: { translation: ko },
}
```

**Why single namespace (not `t("issues:detail.title")`-style):**

- Components call `t("issues.detail.title")` without needing to thread a `ns` prop or memoize `useTranslation(["issues", "agents"])` on every mount.
- Keeps the API surface of `useTranslation()` identical across every call site, which matters when the whole UI is being migrated mechanically.
- Duplicate-key collisions surface at dev time — we hit exactly this with `agentDetail` (a minimal stub in `company.json` was clobbering the full namespace in `agents.json`). Single-namespace makes the collision visible; per-namespace would have silently shipped two different `agentDetail`s.

**Rules for adding keys:**

1. One topic file per surface — if a key belongs to the agent detail page, it goes in `agents.json`. Do not sprinkle agent strings into `misc.json`.
2. Keys must be unique across **all** topic files in a given locale. `en/index.ts` uses spread order as the conflict resolver; the last-spread file wins. Rely on this only when you intend an override; otherwise keep keys disjoint.
3. Every key in `en/` must exist in `ko/` (and any future locale). Missing keys fall back to English automatically, but that produces mixed-locale UIs which are a poor operator experience — fix at the JSON level, not by ignoring the fallback.
4. Interpolation uses `{{variable}}`. Keep variables named (`{{count}}`, `{{name}}`) — positional `{0}` is not supported by i18next.

**Future lazy-loading:** the topic split is deliberate. When bundle size becomes a concern, topic JSONs can be migrated to `i18next-http-backend` (one request per route's namespace) without touching component call sites, because they already use flat keys like `issues.detail.title`.

## `TFunction`-via-ref pattern for live-event toasts

**Problem:** `LiveUpdatesProvider` opens a WebSocket in a `useEffect` with its own dependency array. The socket's `onmessage` handler closes over `t` at mount time. If the user switches language while the socket is open, naively re-subscribing on every `t` change would tear down and rebuild the WebSocket — unacceptable for a persistent event stream.

**Pattern:**

```ts
const { t } = useTranslation();
const tRef = useRef(t);
useEffect(() => { tRef.current = t; }, [t]);

// inside the WebSocket's onmessage:
handleLiveEvent(..., tRef.current);
```

**Why a ref:**

- The socket effect depends on `queryClient`, `liveCompanyId`, `pushToast`, `canConnectSocket`, `socketAuthKey` — **not** on `t`. Keeping `t` out of that dependency array prevents socket churn on language change.
- `tRef.current` is always the current `t` because `useEffect([t])` updates it synchronously on commit.
- Every toast builder (`buildActivityToast`, `buildRunStatusToast`, `buildAgentStatusToast`, `buildJoinRequestToast`) takes `t: TFunction` as a parameter rather than calling `useTranslation` internally. This keeps the builders pure and testable (the existing `__liveUpdatesTestUtils` export relies on this).

**When to use this pattern elsewhere:**

- Any subscription whose lifetime is decoupled from render but whose output needs to be localized: WebSocket handlers, EventSource consumers, `setInterval` bodies, Web Worker message handlers.
- Not needed for normal React components — `useTranslation()` already re-renders on language change.

**When not to use it:**

- Do not add `tRef` speculatively to components that render synchronously. The only reason this exists is to keep a long-lived imperative subscription in sync with reactive state.

## Date and number formatting

`ui/src/lib/utils.ts` dispatches on `isLangKo()`:

- `formatDate`, `formatDateTime`, `formatShortDate` → pass `currentDateLocale()` (`ko-KR` when Korean, else `en-US`) to `toLocaleDateString` / `toLocaleString`.
- `relativeTime` → short-circuits to `relativeTimeKo` when Korean is active. The Korean formatter returns `"2일 전"` / `"방금"` style; the English path uses `Intl.RelativeTimeFormat`.

**Rule:** callers use `relativeTime(ts)` and `formatDate(ts)`. They do **not** branch on locale themselves. The locale dispatch is a single choke-point inside `utils.ts`; that's what lets `InstanceSettings` and `Agents` be locale-correct without per-page changes.

**For future locales:** replace `isLangKo()` with a `currentLocale()` lookup once a third locale lands. Keep the choke-point in `utils.ts`.

## Checklist for a new locale PR

1. `mkdir ui/src/locales/<lang>/` and copy the 12 topic JSONs from `en/`.
2. Translate values; keep keys and interpolation placeholders identical.
3. Add `import <lang> from "./locales/<lang>"` and register it in `i18n.ts`'s `resources` map.
4. Add `<lang>` to `SUPPORTED_LANGS` in `i18n.ts` and to the `language.*` display labels in `core.json` for every locale.
5. If the locale needs non-`en-US` date formatting, extend `currentDateLocale()` in `ui/src/lib/utils.ts`. If it needs a custom relative-time formatter (Korean does), add it next to `relativeTimeKo` and route through the same `relativeTime()` dispatch.
6. Smoke-test: switch to the new locale via `LanguageSwitcher`, visit sidebar → dashboard → issues list → agent detail → company settings → onboarding, and confirm no raw `namespace.key` strings leak.

## Non-goals

- Server-side i18n (API responses, logs, emails). Those remain English for now.
- Plugin UI i18n. Plugins ship their own bundles; they can adopt this pattern but are not required to.
- Pluralization rules beyond what `i18next` provides out of the box. We do not currently use `count`-based plural forms; when we do, add them per-locale in the topic JSON and document any non-CLDR rule here.
