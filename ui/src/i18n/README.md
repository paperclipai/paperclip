# UI Internationalization (i18n)

This directory holds the i18n scaffolding for the Paperclip UI. It uses [`i18next`](https://www.i18next.com/) + [`react-i18next`](https://react.i18next.com/), with English (`en`) as the source language.

## Structure

```
ui/src/i18n/
├── README.md                     ← you are here
├── index.ts                      ← (Phase 1.5) i18next init module
├── locales/
│   ├── en/
│   │   └── common.json           ← English source (canonical)
│   └── ko/
│       └── common.json           ← Korean translation
```

Locale files are JSON, namespaced by feature area. `common.json` is the catch-all for shared strings (buttons, statuses, nav). Larger features get their own namespace (e.g. `org-chart.json`, `routines.json`) once Phase 2 extraction begins.

## Status

| Phase | Status |
| --- | --- |
| Locale scaffold (en + ko stubs) | ✅ |
| Dependency install (i18next packages) | ⏳ next commit |
| `index.ts` init module | ⏳ next commit |
| Wire `import './i18n'` into `main.tsx` | ⏳ next commit |
| Convert first 1–2 components | ⏳ next commit |
| Bulk extraction tooling | Phase 2 |

## How to add a new string

Until the i18next runtime is wired up, just add the English source to `locales/en/common.json` and the Korean translation to `locales/ko/common.json` with the same key path. The init code (next commit) will pick them up.

```json
// en/common.json
{
  "onboarding": {
    "welcome": "Welcome to Paperclip"
  }
}

// ko/common.json
{
  "onboarding": {
    "welcome": "Paperclip에 오신 걸 환영해요"
  }
}
```

## Style guide

See [`docs/translation/PLAN.md`](../../../docs/translation/PLAN.md) and [`docs/translation/CONTRIBUTING-i18n.md`](../../../docs/translation/CONTRIBUTING-i18n.md) for tone, terminology, and contributor workflow.
