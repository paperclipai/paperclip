# UI localization

Paperclip uses two complementary localization paths:

1. New and frequently edited UI should use keyed `i18next` messages from
   `locales/en.json` and `locales/zh-CN.json`.
2. Existing literal-heavy screens are covered by `LegacyLiteralLocalizer` and
   the source-to-Chinese catalog in `legacy-zh-CN.json`. This keeps the whole UI
   localized while those screens migrate incrementally to keyed messages.

The legacy localizer only replaces exact phrases discovered in source. It also
supports numbered `{{value1}}` templates for dynamic labels. It deliberately
skips Markdown, code, editable content, and elements marked `data-i18n-skip` so
user-authored text is never translated.

## Updating copy

Run `pnpm i18n:audit` to locate source literals. Add normal product copy to the
keyed locale files when practical. Otherwise add the English source phrase and
its Chinese translation to `legacy-zh-CN.json`. Put deliberate terminology
corrections in `legacy-zh-CN.overrides.json`; overrides win over generated or
bulk-imported legacy entries.

Before committing, run:

```sh
pnpm check:i18n
pnpm --filter @paperclipai/ui typecheck
pnpm --filter @paperclipai/ui build
```

`check:i18n` scans production TypeScript/TSX files, fails on uncovered UI
phrases, and verifies that dynamic placeholders are preserved exactly.
