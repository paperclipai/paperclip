# UI localization

English is the source locale. Russian is the first reviewed translation. The
application exposes only locales listed in `supportedLocales` in `locales.ts`.
Do not expose a locale that still contains English placeholder content.

## Add or change UI text

1. Add or update the English key in `locales/en.json`.
2. Add or update the same key in `locales/ru.json`.
3. Keep interpolation variables, URLs, markup, and product names unchanged.
4. Use `t("namespace.key")` in the UI. Do not build a sentence by joining
   translated fragments.
5. Run `node scripts/sync-locales.mjs`.
6. Run the locale validation and sync tests.

`node scripts/sync-locales.mjs --write` can scaffold missing Russian keys with
their English source text. It prints every key that still needs human review.
Do not commit an English scaffold as a completed Russian translation.

For Russian counts, define all CLDR forms: `_one`, `_few`, `_many`, and
`_other`. Keep the same `{{placeholders}}` in every locale. Display dates,
numbers, money, relative time, and durations through the shared helpers in
`ui/src/lib/utils.ts` so they follow the selected locale.

## Russian terminology

Use these UI terms consistently:

| English | Russian |
| --- | --- |
| organization | организация |
| agent | агент |
| task | задача |
| workspace | рабочая область |
| project workspace | рабочая область проекта |
| execution workspace | рабочая область выполнения |
| worktree | рабочее дерево Git |
| routine | регламент |
| decision queue | очередь на рассмотрение |
| task watchdog | агент-контролёр |
| secret | секрет |
| secret vault | хранилище секретов |

Do not translate API fields, route segments, environment variable names,
adapter names, model names, command examples, or agent prompt content.

GitHub user [@DrMaks22](https://github.com/DrMaks22) has volunteered to review
new Russian strings and maintain `locales/ru.json`. Tag this user when a change
adds or changes English UI keys. Add a `CODEOWNERS` rule only after repository
maintainers approve locale ownership.

## Verification

```sh
node scripts/sync-locales.mjs
pnpm --filter @paperclipai/ui exec vitest run \
  src/i18n/locale-validation.test.ts \
  src/i18n/locale-sync.test.ts \
  src/lib/utils-localization.test.ts
pnpm --filter @paperclipai/ui typecheck
```
