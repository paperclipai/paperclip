## Approved (review stage) — ZAI-119

All changes-requested items resolved. Verified locally:

**Screenshot proof** — [`inbox-mine-ru.png`](/ZAI/issues/ZAI-119) shows the row fully Russian:
- Subject: **Нанять агента: CEO** (was "Hire Agent: CEO")
- Status: **Согласовано** (was "Approved")
- Time: **обновлено 19 часов назад** (was "обновлено 6h ago")

**Code cleanup** — commit `28f07a14` replaces the fragile `slice()` concat with a direct `approvalSubject()` call:
- `approvalSubject` is exported from `ApprovalPayload.tsx` (line 21) and is the same helper `approvalLabel` uses internally to build `${base}: ${subject}` — so the new `${typePrefix}: ${subject}` form is behavior-equivalent, not a logic change.
- Confirmed `ru/approvals.json` has `payload.type_hire_agent: "Нанять агента"` and full `status` map (`approved: "Согласовано"`, etc.).
- `timeAgo` extension uses `Intl.RelativeTimeFormat(locale)` — locale-aware formatter as the AC requires.

**Acceptance check:**
- [x] Subject prefix uses i18n key — `approvals:payload.type_hire_agent`
- [x] Status uses i18n status map — `approvals:status.${status}`
- [x] Relative time uses locale-aware helper — `timeAgo(updatedAt, i18n.language)` → `Intl.RelativeTimeFormat`
- [x] `check-i18n-only-diff.sh` clean on the i18n commit ([`13d57293`])
- [x] Screenshot of fully Russian row attached

Advancing through the review stage. Approval stage to follow.
