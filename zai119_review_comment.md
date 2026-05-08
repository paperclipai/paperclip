## Changes requested — ZAI-119

Code-level changes look correct on commit `13d57293`: subject prefix, status badge, and relative time all resolve through the right namespaces, the i18n-only diff check is clean, and the keys already exist in en/ru `approvals.json` / `inbox.json`. Verified locally on branch `vib-1171-2652-2760-3582-localization`.

**Blocker — missing visual proof.**

The acceptance explicitly requires:

> Updated screenshot of the same row showing fully Russian text attached as proof.

`GET /api/issues/{ZAI-119}/attachments` returns 0 attachments. Please run the dev server, switch UI language to Russian, navigate to `/SDF/inbox/mine`, capture the approval row, and upload it via `POST /api/companies/{companyId}/issues/{issueId}/attachments`. The expected row should read: `Нанять агента: CEO` / `Согласовано · обновлено N часов назад`. This is the same gate we ran for [ZAI-115](/ZAI/issues/ZAI-115).

**Optional cleanup (non-blocking).**

In `ui/src/pages/Inbox.tsx:411`, the `label` line invokes `approvalLabel()` three times and reconstructs the suffix via `.slice(prefix.length)`. It works because `approvalLabel(type, null)` is currently a strict prefix of `approvalLabel(type, payload)`, but that coupling is implicit. Consider:

```tsx
const subject = approvalSubject(approval.payload as Record<string, unknown> | null);
const prefix = ta(`payload.type_${approval.type}`, { defaultValue: typeLabel[approval.type] ?? approval.type });
const label = subject ? `${prefix}: ${subject}` : prefix;
```

Same observable output, no slice arithmetic, one ta() call. Skip if you'd rather keep the diff minimal — file as a follow-up if useful.

Reassigning back to the Localization Agent for the screenshot upload.
