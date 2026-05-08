import json, os, urllib.request

API = os.environ["PAPERCLIP_API_URL"].rstrip("/")
KEY = os.environ["PAPERCLIP_API_KEY"]
RUN = os.environ["PAPERCLIP_RUN_ID"]
COMP = os.environ["PAPERCLIP_COMPANY_ID"]

LOCALIZATION_AGENT = "2c35ae09-781d-4a7c-880b-8abd833fd682"
CEO = "db69a3af-4281-40f9-9612-00d9c9c80315"
PARENT = "a5760b7a-344a-45cb-8980-414a7379ffab"  # ZAI-153
PROJECT = "90d1b267-8b11-4b20-abed-2422cd4089fb"  # Localization

description = """## Context

The board flagged untranslated content on **/instance/settings/access** in Russian locale (ZAI-153). The page still leaks English strings in the breadcrumb, headings, action labels, and uses non-localized date formatting.

Source URL the board reviewed: http://127.0.0.1:3105/instance/settings/access (locale=ru).

## Concrete leaks called out by the board

Breadcrumb / heading area:
- "Board" (breadcrumb root)
- "Instance Settings" (above breadcrumb)
- "Access" (current crumb / heading prefix)

Page body:
- "Search users"
- "Save company access"
- "Current memberships"
- "Toggle company membership for this user. New access defaults to an active operator membership."
- "Remove instance admin"
- "owner • active" (membership row meta)
- "active company memberships" (count summary text)

Dates: rows render `5/5/2026` / `5/4/2026` (US `M/D/YYYY`). Must use the **regional standard for the selected language** — i.e. a locale-aware `Intl.DateTimeFormat` / formatter rather than a hardcoded en-US format. The board's note: `//включая даты в региональный стандарт выбранного языка`.

## Scope

1. **Find the page** — likely `ui/src/pages/InstanceSettings/AccessPage.tsx` or similar under `ui/src/pages/instance/settings/access/`. Trace the route from `/instance/settings/access` to the component(s).
2. **Wrap every leaking string in `t()`** with sensibly-namespaced keys (mirror the conventions used by the round-3 sweep — `instance_settings.access.*`, etc.).
3. **Localize dates** — replace the `M/D/YYYY` formatter with a locale-aware one (use the same helper the rest of the round-3 sweep adopted; see `5309a195 fix(i18n): complete round-3 localization` for the formatter pattern). Verify the date renders correctly in `ru`, `de`, `fr`, `es`, `pt`, `el`, `uk`, `zh`.
4. **Sweep all 8 locales** — `en`, `ru`, `de`, `fr`, `es`, `pt`, `el`, `uk`, `zh`. Add the new keys to every `*.json` translation file with native translations (do NOT leave English placeholders in non-en files — that was the round-3 rejection criterion per memory note `project_localization_round3.md`).
5. **Run a DOM sweep** on the `/instance/settings/access` route in each locale and confirm zero English-leakage. Save a sweep report (or attach one to this issue) showing FAIL→PASS transition.

## Acceptance criteria

- All listed strings are wrapped in `t()` and resolve to native translations in all 8 locales.
- Date columns render in locale-appropriate format (e.g. `ru` → `05.05.2026`, `de` → `05.05.2026`, `en` → `5/5/2026`, etc.) — uses `Intl.DateTimeFormat` keyed off the active i18n language.
- DOM sweep report attached: zero English leakage on `/instance/settings/access` per locale.
- Branch: `vib-1171-2652-2760-3582-localization` (the localization branch we're already on).

## Reference

- Round-3 commit pattern: `git show 5309a195` for the locale-aware formatter approach.
- Memory note `project_localization_round3.md`: board rejected previous merges when 8-locale sweep wasn't clean — do not request CEO approval on this child until the sweep is clean across all 8 locales.
- Memory note `feedback_qa_warn_is_fail.md`: a sweep with `WARN` and any leakage = FAIL.
"""

policy = {
    "mode": "normal",
    "commentRequired": True,
    "stages": [
        {"type": "review",   "approvalsNeeded": 1, "participants": [{"type": "agent", "agentId": CEO}]},
        {"type": "approval", "approvalsNeeded": 1, "participants": [{"type": "agent", "agentId": CEO}]},
    ],
}

payload = {
    "title": "Localize /instance/settings/access page (ZAI-153 follow-up — 8-locale sweep)",
    "description": description,
    "parentIssueId": PARENT,
    "projectId": PROJECT,
    "assigneeAgentId": LOCALIZATION_AGENT,
    "priority": "medium",
    "status": "todo",
    "executionPolicy": policy,
}

body = json.dumps(payload).encode("utf-8")
req = urllib.request.Request(
    f"{API}/api/companies/{COMP}/issues",
    data=body,
    method="POST",
    headers={
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": f"Bearer {KEY}",
        "X-Paperclip-Run-Id": RUN,
    },
)
try:
    resp = urllib.request.urlopen(req, timeout=30)
    text = resp.read().decode("utf-8")
    print("HTTP", resp.status)
    d = json.loads(text)
    print("id:", d.get("id"))
    print("identifier:", d.get("identifier"))
    print("status:", d.get("status"))
    print("assigneeAgentId:", d.get("assigneeAgentId"))
    print("parentIssueId:", d.get("parentIssueId"))
    open("zai153_child_resp.json","w",encoding="utf-8").write(text)
except urllib.error.HTTPError as e:
    print("HTTP ERROR", e.code, e.read().decode("utf-8", errors="replace"))
