# Product UI localization

Paperclip keeps English as its default UI language. Users can select English or
Simplified Chinese from the account menu or the first-run/authentication UI. The
choice is stored under `paperclip.locale`. If browser storage is unavailable, the
choice still applies to the current session. Switching does not reload the page.

## Resources

The original `locales/*.json` bootstrap resources remain in the `translation`
namespace and retain their strict validation contract. Product copy is grouped
by feature in `catalogs/<locale>/<namespace>.json`.

A catalog must have an English reference. A translated catalog must contain the
same key tree and interpolation parameters as its English reference. A language
without a product namespace falls back to English. The Simplified Chinese
completion test separately requires a Chinese counterpart for every English
product namespace; runtime fallback is not evidence of translation completion.

Use the existing wrapper from `@/i18n`:

```tsx
const { t } = useTranslation("work");
return <button>{t("save")}</button>;
```

Use semantic keys with enough context to distinguish different meanings. Translate
complete messages, not English fragments. Use named interpolation parameters and
`Trans` for messages containing React elements. Keep English `_one` and `_other`
keys in both catalogs under the strict shape contract, even where Chinese uses
the same wording for both.

## Runtime rules

- React components subscribe through `useTranslation(namespace)`.
- Translated memo, callback and effect output depends on the hook translator or
  active language as appropriate. Do not add language dependencies to effects
  that create agents, send messages or save settings merely to refresh a label.
- Non-React display helpers resolve translations at call time. Do not store
  translated text in module-level constants. Keep canonical keys or lazy getters.
- Keep locale-independent state and identity separate from display labels.
  Never derive an input ID, protocol value, route, API payload or equality check
  from a translated label.
- User content, names, prompts, commands, paths, enum values, provider/model IDs,
  raw diagnostic details and third-party plugin content are not translated by
  global replacement. Known product-owned display labels are translated at the
  presentation boundary. There is no DOM text replacement or translation API.

## Checks

```sh
node --test scripts/ui-localization-audit.test.mjs
node scripts/ui-localization-audit.mjs --check
pnpm --filter @paperclipai/ui exec vitest run src/i18n
pnpm --filter @paperclipai/ui typecheck
pnpm --filter @paperclipai/ui build
```

The source-reference audit follows imported translator aliases, component hook
namespaces and explicit namespace options. It reports dynamic references
separately. It does not prove that all visible source text has been extracted;
manual source, terminology, dynamic-enum and browser review are still required.
`Trans` references and custom wrappers require separate review. Full acceptance
also runs the relevant existing UI regression suites and both language directions
on mounted pages, including unsaved forms and already-visible feedback.

## Terminology

Use 组织 for the current product organization concept, 智能体 for agent, 任务 for
task/issue, 例行任务 for routine, 工作区 for workspace and 适配器 for adapter.
Translate board according to context, normally 管理端 or 管理者. Translate default
as 默认 and Git branch as 分支. Authentication token is 令牌; model usage may retain
Token. Keep product brands and technical identifiers unchanged.

## Attribution

Simplified Chinese translation memory was adapted from jiazi009's open
[PR #11251](https://github.com/paperclipai/paperclip/pull/11251), head
`54f703cecd78187f0a20401dbafe8cbdfc8f189e`, including its legacy catalog and
terminology overrides. These existing contributions are not claimed as original
work by this branch. The upstream MIT license and copyright notice remain in
[`LICENSE`](../../../LICENSE).

The keyed localization and locale-preference work in ooolzhooo's
[PR #11373](https://github.com/paperclipai/paperclip/pull/11373), head
`0cac809a0cea0e5bc1cf84ee1f9b48505eff2fed`, was reviewed as prior art. This branch
re-implements against the current product source rather than replacing pages with
an older PR's implementation. The legacy DOM/build-time localization layer was
not adopted.
