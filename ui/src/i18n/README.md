# UI localization

English is the source locale. Russian is the first full UI translation in this change. The
application exposes only locales listed in `supportedLocales` in `locales.ts`.
Do not expose a locale that still contains English placeholder content.

## Add or change UI text

1. Add or update the English key in `locales/en.json`.
2. Add or update the same key in `locales/ru.json`.
3. Keep interpolation variables, URLs, markup, and product names unchanged.
4. Use `t("namespace.key")` in the UI. Do not build a sentence by joining
   translated fragments.
5. Compare against the last reviewed localization commit with
   `node scripts/locale-changes.mjs --base <reviewed-commit-or-tag>`. Review every
   added or changed English message, including edits under existing keys.
6. Run `node scripts/sync-locales.mjs` and the locale tests.

`node scripts/sync-locales.mjs --write` can scaffold missing Russian keys with
their English source text. It prints every key that still needs human review.
Do not commit an English scaffold as a completed Russian translation.

For Russian counts, define all CLDR forms: `_one`, `_few`, `_many`, and
`_other` when the message needs inflection. English normally needs `_one` and
`_other`; do not duplicate the Russian suffix set into new English messages.
An invariant phrase such as `Selected: {{count}}` can use a single key.
Pass a numeric `count` to `t`; pass a separately formatted number only when
the message also needs a display-specific placeholder. Keep the same
`{{placeholders}}` in every locale. Display dates,
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
| Cases (saved work products) | Материалы |
| task watchdog | агент-контролёр |
| secret | секрет |
| secret vault | хранилище секретов |

Do not translate API fields, route segments, environment variable names,
adapter names, model names, command examples, or agent prompt content.

GitHub user [@DrMaks22](https://github.com/DrMaks22) has volunteered to review
new Russian strings and maintain `locales/ru.json`. Tag this user when a change
adds or changes English UI keys. Add a `CODEOWNERS` rule only after repository
maintainers approve locale ownership.

## Incremental review

`locale-changes.mjs` is read-only and compares the working catalogs with an
explicit Git commit or tag. It lists added, changed, and removed English
messages, their previous text, and all dependent target plural forms. Use
`--json` for a machine-readable handoff to a translator. An unchanged Russian
value under changed English is a review candidate, not proof that the wording
must change. `edited` does not mean reviewed; `matches-source` can be an
intentional product name. This command never approves a translation or silently
copies source text into the target.

Record the reviewed commit in the release or translation PR. Before the next
update, compare against that commit, then perform a Russian-only fluency pass
and a separate source/target accuracy pass. Run structure checks again after
wording changes. Key parity alone does not measure visible UI coverage.

## Rendering and runtime boundaries

Use `useTranslation()` in rendered components so open surfaces update on a
language change. Include `t` in memo dependencies that compute display text.
Do not add locale dependencies to effects that initialize form drafts, open
connections, save data, or start agent work. Store a message key and values
for persistent local error state when it must retranslate without retrying.

Use `Trans` for complete sentences containing links or emphasis. Preserve the
component names, attributes, destinations, and interpolation variables. Do not
translate a raw enum before comparing it, selecting an icon, or submitting it.
Map known enum values to labels at the rendering boundary; preserve unknown
values. The same applies to bundled app metadata: localize recognized built-in
copy, not user-defined or externally supplied text that happens to look similar.

User content, agent output, logs, commands, provider responses, and raw server
error messages are not translated by changing the UI locale. Language settings
that control an agent's work are distinct from the interface language. No
translation service is called at runtime.

## Adding another language

1. Scaffold its catalog with `node scripts/sync-locales.mjs --locale de --write`.
   Use its own CLDR plural rules, not the Russian suffix list.
2. Translate and review every message and test the main screens, narrow layouts,
   accessibility labels, locale formatting, and switching with unsaved drafts.
3. Register the completed catalog, native language label, and text direction in
   `locales.ts`. Existing seed files are not automatically offered to users.
4. Update the explicit supported-locale test and run the full locale validation.

The current UI is LTR. Adding an RTL locale also requires a separate layout
audit; setting the document direction alone is not sufficient.

## Verification

```sh
node scripts/sync-locales.mjs
pnpm --filter @paperclipai/ui exec vitest run \
  src/i18n/locale-validation.test.ts \
  src/i18n/locale-sync.test.ts \
  src/i18n/locale-changes.test.ts \
  src/lib/utils-localization.test.ts
pnpm --filter @paperclipai/ui typecheck
```
