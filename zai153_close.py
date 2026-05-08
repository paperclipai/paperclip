import json, os, urllib.request

API = os.environ["PAPERCLIP_API_URL"].rstrip("/")
KEY = os.environ["PAPERCLIP_API_KEY"]
RUN = os.environ["PAPERCLIP_RUN_ID"]

ISSUE = "a5760b7a-344a-45cb-8980-414a7379ffab"  # ZAI-153

# 1. Comment with review decision (required by policy commentRequired: true)
review_body = """**Review + closing ZAI-153.**

ZAI-159 (Localization Agent, commit `04078c5c` on `vib-1171-2652-2760-3582-localization`) is merged into the branch. Verification:

**Sweep verdict from Localization Agent** (ZAI-159 comment `51b3f82d`):
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

**Code verified:**
- `ui/src/pages/InstanceAccess.tsx`: `useTranslation("settings")` wired, all hardcoded English strings replaced with `t("access.*")` keys (breadcrumbs, heading, description, search, admin toggle, company access section, save button, memberships heading, role/status rows, toast messages, loading/error states).
- Date rendering: `toLocaleDateString(i18n.language)` at line 239 — renders locale-appropriate format for all 8 locales.
- Commit is an ancestor of current branch tip (`b3a48b9c`): confirmed with `git merge-base --is-ancestor`.

Board note: remaining English-looking tokens ("Board" user name, company names like "My AI Company") are database values, not hardcoded i18n strings. Correct behavior — not to be translated.

Accepting as done. ZAI-153 → done.
"""

def post_json(url, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST" if "comments" in url or "reviews" in url else "PATCH",
        headers={"Content-Type": "application/json; charset=utf-8",
                 "Authorization": f"Bearer {KEY}",
                 "X-Paperclip-Run-Id": RUN}
    )
    if "PATCH" in req.get_method():
        req.method = "PATCH"
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        text = resp.read().decode("utf-8")
        return resp.status, json.loads(text)
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode("utf-8", errors="replace")}

# Post comment
status, resp = post_json(f"{API}/api/issues/{ISSUE}/comments", {"body": review_body})
print("Comment:", status, resp.get("id"), resp.get("error", ""))

# Move to done
status2, resp2 = post_json(f"{API}/api/issues/{ISSUE}", {"status": "done"})
print("PATCH done:", status2, resp2.get("status"), resp2.get("error", ""))
