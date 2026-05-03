# Contributing to i18n

This guide is for developers adding translatable strings to the Paperclip UI, or wiring up the i18next runtime.

> **Audience**: people writing UI code (any language) — not just translators.

## Overview

We use [`i18next`](https://www.i18next.com/) + [`react-i18next`](https://react.i18next.com/) with **English as the source language**. Korean (`ko`) is the first translation target, but the system is designed to support any locale.

Locale JSON lives at `ui/src/i18n/locales/{lang}/{namespace}.json`.

---

## Phase 1.5 — Wiring up the runtime

This work is queued for the next commit. The steps:

### 1. Install dependencies

```bash
cd ui
pnpm add i18next react-i18next i18next-browser-languagedetector
```

This adds three packages:
- `i18next` — core runtime
- `react-i18next` — React bindings (`useTranslation`, `<Trans>`)
- `i18next-browser-languagedetector` — auto-detect from browser/localStorage/querystring

### 2. Create `ui/src/i18n/index.ts`

```ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import enCommon from "./locales/en/common.json";
import koCommon from "./locales/ko/common.json";

const resources = {
  en: { common: enCommon },
  ko: { common: koCommon },
} as const;

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en",
    defaultNS: "common",
    interpolation: {
      escapeValue: false, // React already escapes by default
    },
    detection: {
      order: ["querystring", "localStorage", "navigator", "htmlTag"],
      lookupQuerystring: "lng",
      lookupLocalStorage: "paperclip-language",
      caches: ["localStorage"],
    },
  });

export default i18n;
```

### 3. Wire it into the app

In `ui/src/main.tsx`, add the import as early as possible (before `App` is imported, side-effect import is enough):

```ts
import "./i18n";
```

That's it. No provider needed — `react-i18next` uses a context bound to the global `i18next` instance.

### 4. Use it in a component

```tsx
import { useTranslation } from "react-i18next";

export function SaveButton() {
  const { t } = useTranslation();
  return <button>{t("actions.save")}</button>;
}
```

For interpolation:

```tsx
const { t } = useTranslation();
return <p>{t("welcome.message", { name: "Daniel" })}</p>;

// en/common.json: { "welcome": { "message": "Hello, {{name}}!" } }
// ko/common.json: { "welcome": { "message": "{{name}}, 안녕하세요!" } }
```

For pluralization (i18next ICU support):

```tsx
t("issues.count", { count: 3 });

// en/common.json: { "issues": { "count_one": "{{count}} issue", "count_other": "{{count}} issues" } }
// ko/common.json: { "issues": { "count_other": "{{count}}개 이슈" } }   // Korean has no plural form
```

---

## Adding a new translatable string (steady state)

Once the runtime is wired up, the workflow is:

1. **Write the key in `locales/en/common.json`** (or a feature-specific namespace if you're adding many strings to one area)
2. **Add the same key with Korean translation in `locales/ko/common.json`**
3. **Use `t('key.path')` in your component**

Naming conventions:

- Use dot-paths matching the UI structure: `org-chart.add-agent.title`
- Group by feature, not by string type
- Keep keys stable — if the English wording changes significantly, prefer adding a new key over mutating
- Use kebab-case for path segments

---

## Adding a new namespace

When `common.json` gets too crowded (rough rule: more than ~50 keys), split a feature into its own namespace:

1. Create `locales/en/<feature>.json` and `locales/ko/<feature>.json`
2. Register in `i18n/index.ts`:

```ts
import enFeature from "./locales/en/feature.json";
import koFeature from "./locales/ko/feature.json";

const resources = {
  en: { common: enCommon, feature: enFeature },
  ko: { common: koCommon, feature: koFeature },
};
```

3. Use it with namespace prefix:

```tsx
const { t } = useTranslation("feature");
t("some.key");
```

Or inline:

```tsx
const { t } = useTranslation();
t("feature:some.key");
```

---

## Lazy loading (deferred)

If/when the locale bundle gets large enough to matter for initial load, switch from static JSON imports to `i18next-http-backend`. Don't optimize prematurely — for now, static imports are fine.

---

## Pre-merge checks

Before merging i18n changes, verify:

- [ ] All new keys exist in both `en/` and `ko/` (no orphan keys)
- [ ] No untranslated English left in Korean files
- [ ] The component renders correctly in both languages (dev tip: append `?lng=ko` to URL)
- [ ] No hardcoded user-facing strings remain in your TSX (use `grep -r '">[A-Z]'` heuristic)

A CI lint enforcing the first item is on the roadmap.

---

## Style guide reference

For tone, terminology, and translation policy, see [`PLAN.md`](./PLAN.md). Key terminology table is the source of truth for consistent vocabulary.

---

## Upstream contribution

Once this i18n setup is stable in `paperclip-ko`, we plan to propose the infrastructure (not the Korean strings) as a PR to `paperclipai/paperclip`. If you make changes here that you think should be upstreamed, mention it in the PR description so we can coordinate.
