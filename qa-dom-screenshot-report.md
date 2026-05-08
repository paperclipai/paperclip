# DOM-Grounded Hardcoded English Sweep — ZAI-79

## Key Numbers

- **39 routes** scanned (37 unique)
- **2 locales** tested: `ru`, `de`
- **1371 total DOM findings** (1239 `definitely_english`, 132 `likely_english`)
- **691** ru findings, **680** de findings
- **Severity:** 473 high, 898 medium
- **117 screenshots** captured (en + ru + de per route)

## Cross-reference with Static Analysis (871 static findings)

- **24** texts found in both static and DOM analysis
- **211** static-only texts (not visible in any live UI flow — likely dev-only, dialog-only, or unreachable paths)
- **184** DOM-only texts (new runtime-generated English the static scan missed)

## Top 15 Offender Routes (by total leaks across both locales)

| # | Route | EN Elements | RU Leaks | DE Leaks | Total |
|---|-------|-------------|----------|----------|-------|
| 1 | `/ZAI/issues/ZAI-79` | 2877 | 67 | 63 | 130 |
| 2 | `/ZAI/design-guide` | 493 | 52 | 52 | 104 |
| 3 | `/ZAI/dashboard/live` | 243 | 31 | 30 | 61 |
| 4 | `/ZAI/dashboard` | 215 | 29 | 29 | 58 |
| 5 | `/ZAI/projects/localization/configuration` | 155 | 28 | 28 | 56 |
| 6 | `/ZAI/projects/onboarding` | 64 | 21 | 21 | 42 |
| 7 | `/ZAI/inbox/all` | 41 | 19 | 19 | 38 |
| 8 | `/ZAI/goals/{id}` | 62 | 19 | 19 | 38 |
| 9 | `/ZAI/projects/localization/issues` | 258 | 19 | 19 | 38 |
| 10 | `/ZAI/projects/localization` | 258 | 19 | 19 | 38 |
| 11 | `/ZAI/projects/localization/workspaces` | 258 | 18 | 19 | 37 |
| 12 | `/ZAI/routines` | 38 | 17 | 17 | 34 |
| 13 | `/ZAI/approvals/all` | 77 | 17 | 17 | 34 |
| 14 | `/ZAI/costs` | 111 | 17 | 17 | 34 |
| 15 | `/ZAI/inbox/mine` | 63 | 17 | 14 | 31 |

## /inbox/mine Detail

### Russian (ru) — 17 English leaks

| Selector | Text (EN) | Severity | Suggested Key | Source |
|----------|-----------|----------|---------------|--------|
| `button.flex > span.truncate` | New Issue | medium | `inbox_mine.new_issue` | text |
| `a.flex > span.flex-1.truncate` | Settings | medium | `inbox_mine.settings` | text |
| `#radix-*-trigger-unread` | Unread | medium | `inbox_mine.unread` | text |
| `#radix-*-trigger-all` | All | medium | `inbox_mine.all` | text |
| `div.pointer-events-none > span.inline-flex.items-center` | Archive | medium | `inbox_mine.archive` | text |
| `span.min-w-0 > span.line-clamp-2.text-sm` | Hire Agent: CTO | medium | `inbox_mine.hire_agent_cto` | text |
| `#radix-*` | Search for a command to run... | high | `inbox_mine.search_for_a_command` | text |
| `button.flex.items-center[aria-label]` | New agent | medium | `inbox_mine.new_agent` | aria-label |
| `#radix-*[aria-label]` | Open Zai ... menu | high | `inbox_mine.open_zai_menu` | aria-label |
| `#radix-*[aria-label]` | Open actions for CEO | high | `inbox_mine.open_actions_for_ceo` | aria-label |
| `#radix-*[aria-label]` | Open actions for CTO | high | `inbox_mine.open_actions_for_cto` | aria-label |
| `#radix-*[aria-label]` | Open actions for Browser Tester Agent | high | `inbox_mine.open_actions_for_browser` | aria-label |
| `#radix-*[aria-label]` | Open actions for Localization Agent | high | `inbox_mine.open_actions_for_localization` | aria-label |
| `button.flex.w-full[aria-label]` | Open account menu | medium | `inbox_mine.open_account_menu` | aria-label |
| `input[placeholder]` | Search inbox... | medium | `inbox_mine.search_inbox` | placeholder |
| `button[title]` | Disable parent-child nesting | medium | `inbox_mine.disable_parentchild_nesting` | title |
| `button.inline-flex.h-4[aria-label]` | Mark as read | medium | `inbox_mine.mark_as_read` | aria-label |

### German (de) — 14 English leaks

Same elements minus "Archive", "Hire Agent: CTO", and "Mark as read" which were translated in DE but not RU.

### File hints for /inbox/mine leaks

- **"New Issue", "Settings", "Unread", "All", "Archive", "Mark as read"** — likely in `SidebarNav` / `Inbox.tsx` / `InboxList.tsx`
- **"Search for a command to run..."** — `CommandPalette.tsx`
- **"New agent", "Open actions for \*"** — `SidebarAgents.tsx`
- **"Open account menu"** — `SidebarFooter.tsx` or layout shell
- **"Search inbox..."** — `InboxList.tsx` or `Inbox.tsx`
- **"Disable parent-child nesting"** — `InboxList.tsx` toggle button

## All Route Coverage (39 scanned)

| Route | EN Elements | RU Leaks | DE Leaks |
|-------|-------------|----------|----------|
| `/ZAI/dashboard` | 215 | 29 | 29 |
| `/ZAI/dashboard/live` | 243 | 31 | 30 |
| `/ZAI/inbox/mine` | 63 | 17 | 14 |
| `/ZAI/inbox/recent` | 37 | 10 | 10 |
| `/ZAI/inbox/unread` | 47 | 16 | 14 |
| `/ZAI/inbox/all` | 41 | 19 | 19 |
| `/ZAI/inbox/requests` | 34 | 15 | 12 |
| `/ZAI/issues` | 285 | 16 | 16 |
| `/ZAI/search` | 45 | 13 | 13 |
| `/ZAI/routines` | 38 | 17 | 17 |
| `/ZAI/goals` | 43 | 11 | 11 |
| `/ZAI/goals/{id}` | 62 | 19 | 19 |
| `/ZAI/projects` | 45 | 12 | 12 |
| `/ZAI/projects/localization` | 57-258 | 18-19 | 19 |
| `/ZAI/projects/localization/issues` | 258 | 19 | 19 |
| `/ZAI/projects/localization/workspaces` | 258 | 18 | 19 |
| `/ZAI/projects/localization/configuration` | 155 | 28 | 28 |
| `/ZAI/agents/ceo` | 72 | 15 | 15 |
| `/ZAI/agents/all` | 67 | 16 | 16 |
| `/ZAI/agents/active` | 62 | 16 | 16 |
| `/ZAI/approvals/pending` | 42 | 13 | 13 |
| `/ZAI/approvals/all` | 77 | 17 | 17 |
| `/ZAI/org` | 56 | 12 | 12 |
| `/ZAI/costs` | 111 | 17 | 17 |
| `/ZAI/activity` | 243 | 14 | 14 |
| `/ZAI/company/settings` | 0 | 0 | 0 |
| `/ZAI/company/settings/access` | 35 | 13 | 13 |
| `/ZAI/company/settings/environments` | 19 | 7 | 7 |
| `/ZAI/workspaces` | 282 | 15 | 15 |
| `/ZAI/design-guide` | 493 | 52 | 52 |
| `/instance/settings/general` | 66 | 15 | 15 |
| `/instance/settings/profile` | 31 | 12 | 12 |
| `/instance/settings/access` | 50 | 15 | 15 |
| `/instance/settings/experimental` | 39 | 8 | 8 |
| `/instance/settings/adapters` | 53 | 9 | 9 |
| `/onboarding` | 16 | 10 | 10 |
| `/ZAI/issues/ZAI-79` | 2877 | 67 | 63 |
| `/ZAI/projects/onboarding` | 64 | 21 | 21 |

## Notes

- `company/settings` rendered 0 elements — likely redirects to a sub-page.
- `design-guide` has 104 leaks but is a dev/internal page — Localizer may deprioritize.
- Issue detail (`/ZAI/issues/ZAI-79`) has the most leaks (130) due to dynamic comment content mixing English and i18n.
- Screenshots for all 39 routes (en + ru + de = 117 PNGs) captured and attached separately.
