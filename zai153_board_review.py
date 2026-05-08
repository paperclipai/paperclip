import json, os, urllib.request

API = os.environ["PAPERCLIP_API_URL"].rstrip("/")
KEY = os.environ["PAPERCLIP_API_KEY"]
RUN = os.environ["PAPERCLIP_RUN_ID"]

ISSUE = "a5760b7a-344a-45cb-8980-414a7379ffab"  # ZAI-153

def patch(payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{API}/api/issues/{ISSUE}",
        data=data, method="PATCH",
        headers={"Content-Type": "application/json; charset=utf-8",
                 "Authorization": f"Bearer {KEY}",
                 "X-Paperclip-Run-Id": RUN},
    )
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        text = resp.read().decode("utf-8")
        return resp.status, json.loads(text)
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode("utf-8", errors="replace")}

# Step 1: Switch policy to board as reviewer+approver (CEO can't self-approve own issue)
board_policy = {
    "executionPolicy": {
        "mode": "normal",
        "commentRequired": True,
        "stages": [
            {"type": "review",   "approvalsNeeded": 1, "participants": [{"type": "user", "userId": "local-board"}]},
            {"type": "approval", "approvalsNeeded": 1, "participants": [{"type": "user", "userId": "local-board"}]},
        ],
    }
}
s1, r1 = patch(board_policy)
print("Policy→board:", s1, (r1.get("executionPolicy") or {}).get("stages") is not None, r1.get("error", ""))

# Step 2: Submit for review with a closing comment
review_comment = """**Submitting for board review: /instance/settings/access localization complete.**

ZAI-159 (Localization Agent, commit `04078c5c` on `vib-1171-2652-2760-3582-localization`) landed clean.

**Sweep verdict (ZAI-159 comment `51b3f82d`):**
> **Overall: PASS — zero English leakage across all 8 supported locales.**

| Locale | Result | Leaks |
|--------|--------|-------|
| en | PASS | 0 |
| ru | PASS | 0 |
| de | PASS | 0 |
| es | PASS | 0 |
| pt | PASS | 0 |
| el | PASS | 0 |
| uk | PASS | 0 |
| zh | PASS | 0 |

**Implementation verified:**
- `ui/src/pages/InstanceAccess.tsx`: all hardcoded English strings replaced with `t("access.*")` keys via `useTranslation("settings")`.
- Date formatting: `toLocaleDateString(i18n.language)` at line 239 — locale-aware (ru/de → DD.MM.YYYY, etc.).
- Commit is an ancestor of current branch tip `b3a48b9c`.

Board note: "Board" username and company names like "My AI Company" are database values, not hardcoded i18n strings — correct behavior.

Ready for board to mark done.
"""

s2, r2 = patch({"status": "in_review", "comment": review_comment})
print("→in_review:", s2, r2.get("status"), r2.get("error", ""))
