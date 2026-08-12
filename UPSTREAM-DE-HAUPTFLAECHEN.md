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

## How to open the PR

GitHub CLI auth on this machine was invalid when the branch was prepared.
After `gh auth refresh -h github.com`:

```bash
cd /Users/thomas/source/paperclip-ui-de
gh repo fork paperclipai/paperclip --remote=true
git push -u origin feat/de-hauptflaechen-i18n
gh pr create --title "feat(i18n): German Hauptflächen nav and page strings" --body "$(cat <<'EOF'
## Summary
- Expand EN/DE catalogs for Inbox, Tasks, Agents, Settings, company create
- Wire Hauptflächen + Sidebar through `t()`; add LanguageSwitcher (en/de)
- Keep other locales schema-aligned (English fallbacks for new keys)

## Test plan
- [ ] `pnpm --filter @paperclipai/ui exec vitest run src/i18n/locale-validation.test.ts`
- [ ] Switch language to Deutsch in Instance → General or account menu
- [ ] Confirm Sidebar Inbox/Tasks/Agents/Settings labels are German
- [ ] Confirm company-create empty state remains German
- [ ] Reload page; locale persists via `localStorage.paperclip.locale`
EOF
)"
```

## Lab follow-up

After merge + managed Canary release: upgrade lab Canary and re-run
`docs/ai/de-gate.md`. Do **not** wipe the lab instance until the gate passes.
