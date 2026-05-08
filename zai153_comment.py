import json, os, urllib.request

API = os.environ["PAPERCLIP_API_URL"].rstrip("/")
KEY = os.environ["PAPERCLIP_API_KEY"]
RUN = os.environ["PAPERCLIP_RUN_ID"]

ISSUE = "a5760b7a-344a-45cb-8980-414a7379ffab"  # ZAI-153

body_md = """**Delegated to Localization Agent — child ZAI-159.**

Triage:
- The board flagged untranslated content on `/instance/settings/access` in `ru` plus a non-localized date format (`5/5/2026` etc.). The note "//включая даты в региональный стандарт выбранного языка" calls out that dates must follow the selected language's regional standard.
- This is round-4 follow-up on the localization branch (`vib-1171-2652-2760-3582-localization`). Per memory `project_localization_round3.md`, the board rejects merges when the 8-locale sweep isn't clean — so this fix can't be a Russian-only patch.

Action:
- Created **ZAI-159** (assigned to Localization Agent, project Localization, executionPolicy → CEO review+approval) with the full leak inventory the board listed: breadcrumb (Board / Instance Settings / Access), section headings (Search users, Save company access, Current memberships, Toggle company membership..., Remove instance admin, "owner • active", "active company memberships"), and locale-aware date formatting via `Intl.DateTimeFormat` keyed off the active i18n language.
- Acceptance gate: zero English leakage on `/instance/settings/access` across all 8 locales (`en`, `ru`, `de`, `fr`, `es`, `pt`, `el`, `uk`, `zh`) — verified by DOM sweep — and dates render in locale-appropriate format.

Next:
- This issue stays in_progress while ZAI-159 executes. I will request approval from the board on this once ZAI-159 lands clean. If the Localization Agent reports back partial coverage I'll reject in review, not approve, per the round-3 rule.
"""

payload = {"body": body_md}
data = json.dumps(payload).encode("utf-8")

req = urllib.request.Request(
    f"{API}/api/issues/{ISSUE}/comments",
    data=data,
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
    print("comment id:", d.get("id"))
    print("authorAgentId:", d.get("authorAgentId"))
    print("authorUserId:", d.get("authorUserId"))
except urllib.error.HTTPError as e:
    print("HTTP ERROR", e.code, e.read().decode("utf-8", errors="replace"))
