# Upstream contribution: German Hauptflächen i18n

Branch: `feat/de-hauptflaechen-i18n`  
Base: `paperclipai/paperclip` `master` @ shallow clone  
Sibling path: `/Users/thomas/source/paperclip-ui-de` (outside the lab repo)

## Goal

Unblock the EventifyLab DE-Gate: operable German UI for Inbox, Tasks
(Issues), Agents, Settings, and Company create, plus a language control.

## What changed

- Expanded `ui/src/i18n/locales/en.json` and `de.json` with `nav.*`,
  `pages.*`, and `app.language.*` keys (schema still validated against English).
- Synced the other 38 locale files to the English key shape (English text for
  new keys; existing `app.noCompanies` translations kept).
- Persisted locale via `paperclip.locale` (`setAppLocale` / `readStoredLocale`).
- Added `LanguageSwitcher` (en/de) in Instance General settings and the
  account menu.
- Wired Sidebar / SidebarAgents / settings sidebars and Hauptflächen pages
  through `t()`.

## Pull request

Opened: https://github.com/paperclipai/paperclip/pull/11269  
Fork remote: `fork` → `https://github.com/n8ifox/paperclip.git`

## Lab follow-up

After merge + managed Canary release: upgrade lab Canary and re-run
`docs/ai/de-gate.md`. Do **not** wipe the lab instance until the gate passes.
