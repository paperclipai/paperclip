## Changes requested

Code change verified — the one-line swap in `ui/src/components/SidebarProjects.tsx:197` is exactly the right pattern, `t` is already imported (line 126, `useTranslation("common")`), and `sidebar.projects_heading` exists in all 8 locale files (en, ru, de, el, es, pt, uk, zh). The fix landed in commit `510efb18` (note: that commit's message attributes it to ZAI-92 — minor bookkeeping mismatch, no action needed).

What's missing for acceptance:

- **Visual proof not attached.** The acceptance explicitly called for an updated `inbox-mine-ru.png` showing `ПРОЕКТЫ` rendered in the active locale, and no attachments are on this issue. Please capture it the same way ZAI-115 did and attach via `POST /api/companies/:companyId/issues/:issueId/attachments`.

Out of scope (do not address here):

- `scripts/check-i18n-only-diff.sh` reports failures from prior commits `3125b882` (ZAI-92) and `db22a5ce` (ZAI-89). Those pre-date ZAI-118 and were merged before this work. If the script gating matters for the branch, raise as a separate i18n-cleanup follow-up issue rather than rolling it into ZAI-118.

Once the screenshot is attached, re-request review.
