# UI display languages

The board UI can show its interface text in French. English stays the default and the reference.

## How the UI picks a language

1. A saved choice in `localStorage` (`paperclip:locale`, value `en` or `fr`) wins.
2. Otherwise, the UI uses the first browser language in `navigator.languages` that it supports (English or French). `fr`, `fr-FR` and `fr-CA` select French. `en-GB` before `fr-FR` selects English.
3. Otherwise, the UI uses English.

The language picker is on the sign-in page and in the account menu. A change saves the choice and reloads the page.

## How the translation works

- `ui/src/lib/vite-display-copy.ts` is a Vite plugin. At build time, it wraps JSX text and display attributes (`title`, `aria-label`, `placeholder`, `alt`, `label`, `description` and similar) in `displayText("English source")`. Template literals keep their values out of the sentence: `` `Found ${count} agents` `` becomes `displayText("Found {{v0}} agents", { v0: count })`.
- `ui/src/i18n/display-text.ts` looks up the English source in `ui/src/i18n/display/<locale>.json`. The key is the English text with collapsed whitespace. A missing or unsafe entry falls back to English.
- In French only, `ui/src/i18n/display-dom.ts` also translates exact text nodes and display attributes that the build step cannot see (labels in data arrays, for example), and shows dates in the French format.
- The catalog also holds the product copy that the server sends and the UI shows as is: descriptions of built-in apps, plugins and skills, and the fallback activity verbs. The DOM layer shows this copy in French.
- When a template value is itself a short interface label from the catalog (60 characters or less, for example `Enable` in `` `${verb} ${name}` ``), French shows the translated label. Other values, such as names and titles, show as they are.
- In English, the catalog does not load, the DOM layer does not start, and `Date`/`Intl` are not changed. `displayText` returns the source text.

## What is never translated

- `code`, `pre`, `kbd`, `samp`, `script`, `style`, `textarea`, inputs, editors (`.ProseMirror`, `.mdxeditor`, `.cm-editor`, `contenteditable`) and markdown content.
- Values sent to the API, object properties that are not display attributes, and user data.
- `<option>` elements without a `value` attribute, because the browser submits their text.
- Any element with `data-no-translate` and its children. Add this attribute to opt a subtree out.

## Catalog rules

`ui/src/i18n/display-catalog.test.ts` checks each catalog. A translation must keep the same `{{vN}}` placeholders, must not add HTML tags, URLs or `javascript:`, and must respect the same length limit as the i18next locale validation. The catalog is separate from `ui/src/i18n/locales/*.json`, so it does not change the i18next key parity checks.
