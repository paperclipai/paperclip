# UI locale bundles

Each supported language has a directory here (`en/`, `ko/`, ...) containing topic-split JSON files merged into a single `translation` namespace at runtime via `index.ts`.

See [`doc/spec/ui-i18n.md`](../../../doc/spec/ui-i18n.md) for:

- Library choice (`react-i18next`) and why
- Single-namespace merge rules and key disjointness
- `TFunction`-via-ref pattern for long-lived subscriptions (e.g. `LiveUpdatesProvider`)
- Checklist for adding a new locale
